import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet-velocity/dist/leaflet-velocity.css'
import 'leaflet-velocity'
import './style.css'

// --- Config ---
const MAX_AGE_MS = 3 * 60 * 60 * 1000 // 3 timmar
const UPDATE_INTERVAL_MS = 5_000
const WS_URLS = [
  'wss://ws1.blitzortung.org/',
  'wss://ws2.blitzortung.org/',
  'wss://ws7.blitzortung.org/',
  'wss://ws8.blitzortung.org/',
]

// Blitzortung streams LZW-compressed JSON. This is their decode() verbatim.
function lzwDecode(str) {
  const chars = str.split('')
  let prev = chars[0]
  const result = [prev]
  const dict = {}
  let code = 256
  for (let i = 1; i < chars.length; i++) {
    const cc = chars[i].charCodeAt(0)
    const entry = cc < 256 ? chars[i] : (dict[cc] ?? prev + prev[0])
    result.push(entry)
    dict[code++] = prev + entry[0]
    prev = entry
  }
  return result.join('')
}

// Blitzortung: vit → gul → orange → röd → mörkröd
const AGE_COLORS = [
  { maxAge: 2 * 60_000,       fill: '#ffffff', stroke: '#ffe066' },
  { maxAge: 15 * 60_000,      fill: '#ffee00', stroke: '#ffaa00' },
  { maxAge: 60 * 60_000,      fill: '#ff8800', stroke: '#cc5500' },
  { maxAge: 2 * 60 * 60_000,  fill: '#ff2200', stroke: '#aa1100' },
  { maxAge: MAX_AGE_MS,       fill: '#660000', stroke: '#330000' },
]

// SMHI (historiskt): cyan → blå → mörkblå
const SMHI_AGE_COLORS = [
  { maxAge: 2 * 60_000,       fill: '#55ffff', stroke: '#00ccff' },
  { maxAge: 15 * 60_000,      fill: '#00ccff', stroke: '#0088ff' },
  { maxAge: 60 * 60_000,      fill: '#0088ff', stroke: '#0055cc' },
  { maxAge: 2 * 60 * 60_000,  fill: '#0055cc', stroke: '#003399' },
  { maxAge: MAX_AGE_MS,       fill: '#002266', stroke: '#001133' },
]

// --- State ---
let map
let userMarker = null
let userLat = null
let userLon = null
let strikes = [] // { lat, lon, timeMs, marker }
let wsIndex = 0
let ws = null
let reconnectTimer = null

const sourceState = {
  blitzortung: 'connecting', // 'connecting' | 'live' | 'reconnecting'
  smhi: 'idle',              // 'idle' | 'loading' | 'ok' | 'empty'
  server: 'idle',            // 'idle' | 'ok' | 'error'
}

// --- Geo utils ---
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

function nearestKm() {
  if (userLat === null || strikes.length === 0) return null
  let min = Infinity
  for (const s of strikes) {
    const d = haversineKm(userLat, userLon, s.lat, s.lon)
    if (d < min) min = d
  }
  return min
}

// --- Map layers ---
const MAP_LAYERS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
    maxNativeZoom: 17,
  },
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
  },
}
const MAP_LAYER_KEY = 'blixt_maplayer'
let baseLayer = null

function setMapLayer(id) {
  const def = MAP_LAYERS[id] ? id : 'dark'
  const layer = MAP_LAYERS[def]
  if (baseLayer) map.removeLayer(baseLayer)
  const opts = { attribution: layer.attribution, maxZoom: layer.maxZoom }
  if (layer.subdomains) opts.subdomains = layer.subdomains
  if (layer.maxNativeZoom) opts.maxNativeZoom = layer.maxNativeZoom
  baseLayer = L.tileLayer(layer.url, opts).addTo(map)
  localStorage.setItem(MAP_LAYER_KEY, def)
  document.querySelectorAll('.layer-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layer === def)
  })
}

// --- Map ---
function initMap() {
  const renderer = L.canvas({ padding: 0.5 })

  map = L.map('map', { zoomControl: true, renderer, minZoom: 3 })

  setMapLayer(localStorage.getItem(MAP_LAYER_KEY) || 'dark')

  map.setView([62, 15], 5) // Sweden as fallback

  map.createPane('windPane')
  map.getPane('windPane').style.pointerEvents = 'none'

  const LocControl = L.Control.extend({
    onAdd() {
      const btn = L.DomUtil.create('button', 'leaflet-bar leaflet-control-loc')
      btn.title = 'Min position'
      btn.innerHTML = '⊙'
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.stop(e)
        if (userLat !== null) map.setView([userLat, userLon], Math.max(map.getZoom(), 12))
      })
      return btn
    },
  })
  new LocControl({ position: 'topleft' }).addTo(map)
}

// --- Geolocation ---
function initGeolocation() {
  if (!navigator.geolocation) {
    setStatus('Geolocation saknas i webbläsaren')
    return
  }
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 10_000,
  })
}

function onPosition({ coords }) {
  const { latitude: lat, longitude: lon, accuracy } = coords
  userLat = lat
  userLon = lon

  const popupHtml = `${lat.toFixed(5)}, ${lon.toFixed(5)}<br><small style="color:#888">±${Math.round(accuracy)} m</small>`

  if (!userMarker) {
    map.setView([lat, lon], 8)
    userMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="user-pulse"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      zIndexOffset: 1000,
    }).addTo(map).bindPopup(popupHtml)
  } else {
    userMarker.setLatLng([lat, lon])
    userMarker.setPopupContent(popupHtml)
  }
}

function onPositionError(err) {
  console.warn('Position error:', err.message)
}

// --- Server WebSocket (primär) ---
function connectToServer() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const serverWs = new WebSocket(`${proto}://${location.host}/ws`)
  let opened = false

  serverWs.onopen = () => {
    opened = true
    sourceState.blitzortung = 'connecting'
    renderStatus()
  }

  serverWs.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data)
      if (msg.type === 'history') {
        sourceState.blitzortung = 'live'
        const smhiInHistory = msg.strikes.some(s => s.meta?.source === 'smhi')
        if (smhiInHistory) sourceState.smhi = 'ok'
        renderStatus()
        const existing = new Set(strikes.map(s => `${s.timeMs}:${s.lat}:${s.lon}`))
        for (const { lat, lon, timeMs, meta } of msg.strikes) {
          const key = `${timeMs}:${lat}:${lon}`
          if (!existing.has(key)) { existing.add(key); addStrike(lat, lon, timeMs, false, meta ?? {}) }
        }
      } else if (msg.type === 'strike') {
        sourceState.blitzortung = 'live'
        if (msg.meta?.source === 'smhi') sourceState.smhi = 'ok'
        addStrike(msg.lat, msg.lon, msg.timeMs, true, msg.meta ?? {})
        renderStatus()
      }
    } catch {}
  }

  serverWs.onclose = () => {
    if (opened) {
      sourceState.blitzortung = 'reconnecting'
      renderStatus()
      setTimeout(connectToServer, 3000)
    } else {
      connectBlitzortung()
    }
  }

  serverWs.onerror = () => {}
}

// --- Blitzortung direktanslutning (dev-fallback) ---
function connectBlitzortung() {
  sourceState.blitzortung = 'connecting'
  renderStatus()

  if (ws) {
    ws.onclose = null
    ws.close()
  }

  ws = new WebSocket(WS_URLS[wsIndex % WS_URLS.length])

  ws.onopen = () => {
    ws.send('{"a":111}')
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(lzwDecode(event.data))
      if (typeof data.lat !== 'number' || typeof data.lon !== 'number') return
      if (typeof data.latc === 'number') data.lat += data.latc
      if (typeof data.lonc === 'number') data.lon += data.lonc
      const timeMs = data.time ? data.time / 1e6 : Date.now()
      sourceState.blitzortung = 'live'
      addStrike(data.lat, data.lon, timeMs, true)
      renderStatus()
    } catch {}
  }

  ws.onerror = () => {
    wsIndex++
    scheduleBlitzReconnect()
  }

  ws.onclose = () => {
    scheduleBlitzReconnect()
  }
}

function scheduleBlitzReconnect() {
  if (reconnectTimer) return
  sourceState.blitzortung = 'reconnecting'
  renderStatus()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectBlitzortung()
  }, 3000)
}

// --- Strikes ---
function strikeStyle(ageMs, meta) {
  const palette = meta?.source === 'smhi' ? SMHI_AGE_COLORS : AGE_COLORS
  const opacity = 1 - ageMs / MAX_AGE_MS
  const bucket = palette.find(b => ageMs <= b.maxAge) ?? palette.at(-1)
  return {
    radius: 5,
    fillColor: bucket.fill,
    color: bucket.stroke,
    weight: 1,
    opacity,
    fillOpacity: opacity * 0.85,
  }
}

let saveTimer = null
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveToStorage, 3_000)
}

function addRipple(lat, lon) {
  const icon = L.divIcon({
    className: '',
    html: '<div class="strike-ring"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })
  const ring = L.marker([lat, lon], { icon, zIndexOffset: 500, interactive: false }).addTo(map)
  setTimeout(() => map.removeLayer(ring), 1400)
}

function strikePopup(timeMs, meta = {}, lat, lon) {
  const date = new Date(timeMs)
  const dateStr = date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' })
  const timeStr = date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const distStr = (userLat !== null)
    ? `<div>Avstånd: ${haversineKm(userLat, userLon, lat, lon).toFixed(1)} km</div>`
    : ''

  const coordStr = `<div>Lat: ${lat.toFixed(4)} Lon: ${lon.toFixed(4)}</div>`

  let extraStr = ''
  if (meta.source === 'smhi') {
    if (meta.peakCurrent != null) extraStr += `<div>Toppström: ${meta.peakCurrent} kA</div>`
    const type = meta.cloudIndicator === 0 ? 'Moln–mark' : 'Moln–moln'
    extraStr += `<div>Typ: ${type}</div>`
  }

  const sourceLabel = meta.source === 'smhi' ? 'SMHI' : 'Blitzortung'
  const sourceColor = meta.source === 'smhi' ? '#7ecaff' : '#ffdd88'

  return `<div style="font-size:13px;line-height:1.7">
    <div style="font-weight:600;margin-bottom:4px">Blixtnedslag ${dateStr} ${timeStr}</div>
    ${distStr}${coordStr}${extraStr}<div style="color:${sourceColor}">Källa: ${sourceLabel}</div>
  </div>`
}

function addStrike(lat, lon, timeMs, ripple = false, meta = {}) {
  const marker = L.circleMarker([lat, lon], strikeStyle(Date.now() - timeMs, meta))
    .bindPopup(() => strikePopup(timeMs, meta, lat, lon), { className: 'strike-popup' })
    .addTo(map)
  strikes.push({ lat, lon, timeMs, meta, marker })
  if (ripple) addRipple(lat, lon)
  scheduleSave()
}

function updateStrikes() {
  const now = Date.now()
  const kept = []

  for (const strike of strikes) {
    const age = now - strike.timeMs
    if (age > MAX_AGE_MS) {
      map.removeLayer(strike.marker)
    } else {
      strike.marker.setStyle(strikeStyle(age, strike.meta))
      kept.push(strike)
    }
  }

  strikes = kept
  renderStatus()

}

// --- Status bar ---
function renderStatus() {
  const count = strikes.length
  const countStr = count > 0
    ? `${count} blixt${count !== 1 ? 'ar' : ''}`
    : 'Inga blixtar'

  const blitzDot = {
    connecting:   '<span style="color:#ffcc44">●</span>',
    live:         '<span style="color:#44dd88">●</span>',
    reconnecting: '<span style="color:#ff6644">●</span>',
  }[sourceState.blitzortung] ?? ''

  const blitzText = {
    connecting:   'Ansluter…',
    live:         'Live',
    reconnecting: 'Återansluter…',
  }[sourceState.blitzortung] ?? '?'

  const blitzLabel = `${blitzDot} ⚡ ${blitzText}`

  const smhiLabel = {
    idle:    '',
    loading: '· <span style="color:#ffcc44">●</span> SMHI',
    ok:      '· <span style="color:#44dd88">●</span> SMHI',
    empty:   '',
  }[sourceState.smhi] ?? ''

  const serverLabel = {
    idle:  '',
    ok:    '',
    error: '· <span style="color:#ff6644">●</span> Server borta',
  }[sourceState.server] ?? ''

  const parts = [countStr, blitzLabel, smhiLabel, serverLabel]
    .filter(Boolean)
    .join('  ')

  document.getElementById('status').innerHTML = parts
}

// --- Persistence ---
const STORAGE_KEY = 'blixt_strikes'

function saveToStorage() {
  const now = Date.now()
  const payload = strikes
    .filter(s => now - s.timeMs < MAX_AGE_MS)
    .map(({ lat, lon, timeMs, meta }) => ({ lat, lon, timeMs, ...(meta && Object.keys(meta).length ? { meta } : {}) }))
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // storage full — silently skip
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const now = Date.now()
    for (const { lat, lon, timeMs, meta } of JSON.parse(raw)) {
      if (now - timeMs < MAX_AGE_MS) {
        addStrike(lat, lon, timeMs, false, meta ?? {})
      }
    }
  } catch {
    // corrupted — ignore
  }
}

// --- Server sync ---
async function loadFromApi() {
  try {
    const res = await fetch('/api/strikes')
    if (!res.ok) return
    const data = await res.json()
    const now = Date.now()
    const existing = new Set(strikes.map(s => `${s.timeMs}:${s.lat}:${s.lon}`))
    let added = 0
    let smhiCount = 0
    for (const { lat, lon, timeMs, meta } of data) {
      if (now - timeMs > MAX_AGE_MS) continue
      const key = `${timeMs}:${lat}:${lon}`
      if (existing.has(key)) continue
      existing.add(key)
      addStrike(lat, lon, timeMs, false, meta ?? {})
      if (meta?.source === 'smhi') smhiCount++
      added++
    }
    sourceState.server = 'ok'
    sourceState.smhi = smhiCount > 0 ? 'ok' : 'empty'
    renderStatus()
  } catch {
    sourceState.server = 'error'
    renderStatus()
  }
}

// Re-poll server every 60s to pick up new SMHI strikes added server-side
setInterval(loadFromApi, 60_000)

// --- SMHI client-side (works in dev; in prod supplements server polling) ---
const SMHI_BASE = 'https://opendata-download-lightning.smhi.se/api/version/latest'
const smhiSeen = new Set()

async function loadSmhiData() {
  sourceState.smhi = 'loading'
  renderStatus()

  const now = Date.now()
  const cutoff = now - MAX_AGE_MS
  const todayUtc = new Date(now)
  const ydayUtc = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate() - 1))

  const days = [
    { year: ydayUtc.getUTCFullYear(), month: ydayUtc.getUTCMonth() + 1, day: ydayUtc.getUTCDate() },
    { year: todayUtc.getUTCFullYear(), month: todayUtc.getUTCMonth() + 1, day: todayUtc.getUTCDate() },
  ]

  let added = 0
  for (const d of days) {
    let raw
    try {
      const res = await fetch(`${SMHI_BASE}/year/${d.year}/month/${d.month}/day/${d.day}/data.json`)
      if (!res.ok) continue
      raw = (await res.json()).values ?? []
    } catch { continue }

    for (const s of raw) {
      const timeMs = Date.UTC(s.year, s.month - 1, s.day, s.hours, s.minutes, s.seconds, Math.floor(s.nanoseconds / 1e6))
      if (timeMs < cutoff) continue
      const key = `${timeMs}:${s.lat}:${s.lon}`
      if (smhiSeen.has(key)) continue
      smhiSeen.add(key)
      if (strikes.some(e => e.timeMs === timeMs && e.lat === s.lat && e.lon === s.lon)) continue
      addStrike(s.lat, s.lon, timeMs, false, { source: 'smhi', cloudIndicator: s.cloudIndicator, peakCurrent: s.peakCurrent })
      added++
    }
  }

  if (sourceState.smhi === 'loading') {
    sourceState.smhi = added > 0 ? 'ok' : 'empty'
    renderStatus()
  }
}

// --- Rain radar (RainViewer) ---
let radarLayer = null
let radarVisible = true

async function updateRadar() {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json')
    const data = await res.json()
    const frames = data.radar?.past
    if (!frames?.length) return
    const latest = frames[frames.length - 1]
    const url = `${data.host}${latest.path}/256/{z}/{x}/{y}/6/1_1.png`
    if (radarLayer) map.removeLayer(radarLayer)
    radarLayer = L.tileLayer(url, { opacity: 0.5, zIndex: 200, minNativeZoom: 3, maxNativeZoom: 7, attribution: 'Rain: RainViewer' })
    radarLayer.on('tileerror', (e) => {
      e.tile.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    })
    if (radarVisible) radarLayer.addTo(map)
  } catch {}
}

function toggleRadar() {
  radarVisible = !radarVisible
  const btn = document.getElementById('radar-toggle')
  if (radarVisible) {
    if (radarLayer) radarLayer.addTo(map)
    btn.classList.add('active')
  } else {
    if (radarLayer) map.removeLayer(radarLayer)
    btn.classList.remove('active')
  }
}

// --- Wind (leaflet-velocity + Open-Meteo) ---
// Grid: globalt 90–-90°N, -180–180°E, 4° steg → 46×91 = 4186 punkter.
// Open-Meteo begränsar antalet koordinater per anrop, så gridden hämtas i
// chunkar (WIND_CHUNK punkter/request) och sätts ihop i rad-major ordning.
const WIND_LA1 = 90, WIND_LA2 = -90
const WIND_LO1 = -180, WIND_LO2 = 180
const WIND_D = 4
const WIND_NX = Math.round((WIND_LO2 - WIND_LO1) / WIND_D) + 1
const WIND_NY = Math.round((WIND_LA1 - WIND_LA2) / WIND_D) + 1
const WIND_POINTS = WIND_NX * WIND_NY
const WIND_CHUNK = 500

let windLayer = null
let windVisible = true

async function fetchWindChunk(chunk) {
  const lats = chunk.map(p => p[0]).join(',')
  const lons = chunk.map(p => p[1]).join(',')
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&forecast_days=1`
  )
  if (!res.ok) throw new Error('Open-Meteo HTTP ' + res.status)
  const json = await res.json()
  // Multi-location svarar med en array av resultat (ett per koordinat, i begärd ordning).
  return Array.isArray(json) ? json : (json.results ?? [json])
}

async function updateWind() {
  // Bygg gridden i rad-major ordning: alla longituder för varje latitud (norr→söder).
  const points = []
  for (let lat = WIND_LA1; lat >= WIND_LA2; lat -= WIND_D) {
    for (let lon = WIND_LO1; lon <= WIND_LO2; lon += WIND_D) {
      points.push([lat, lon])
    }
  }

  const speeds = new Array(WIND_POINTS)
  const dirs = new Array(WIND_POINTS)
  try {
    const tasks = []
    for (let i = 0; i < WIND_POINTS; i += WIND_CHUNK) {
      tasks.push(fetchWindChunk(points.slice(i, i + WIND_CHUNK)))
    }
    const chunks = await Promise.all(tasks)

    let idx = 0
    for (const data of chunks) {
      for (const r of data) {
        speeds[idx] = r.current?.wind_speed_10m ?? 0
        dirs[idx] = (r.current?.wind_direction_10m ?? 0) * Math.PI / 180
        idx++
      }
    }

    const uData = new Array(WIND_POINTS)
    const vData = new Array(WIND_POINTS)
    for (let i = 0; i < WIND_POINTS; i++) {
      uData[i] = -speeds[i] * Math.sin(dirs[i])
      vData[i] = -speeds[i] * Math.cos(dirs[i])
    }

    const refTime = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const hdr = { parameterUnit: 'm.s-1', parameterCategory: 2, dx: WIND_D, dy: WIND_D, la1: WIND_LA1, la2: WIND_LA2, lo1: WIND_LO1, lo2: WIND_LO2, nx: WIND_NX, ny: WIND_NY, refTime }
    const velData = [
      { header: { ...hdr, parameterNumber: 2, parameterNumberName: 'eastward_wind' }, data: uData },
      { header: { ...hdr, parameterNumber: 3, parameterNumberName: 'northward_wind' }, data: vData },
    ]
    if (windLayer) map.removeLayer(windLayer)
    windLayer = L.velocityLayer({
      displayValues: false,
      pane: 'windPane',
      data: velData,
      maxVelocity: 25,
      colorScale: ['rgba(255,255,255,0.3)', 'rgba(180,200,255,0.6)', 'rgba(100,140,255,0.85)', 'rgba(60,80,220,1)'],
      opacity: 0.8,
      lineWidth: 1.5,
      particleAge: 90,
      particleMultiplier: 0.003,
    })
    if (windVisible) windLayer.addTo(map)
  } catch (e) {
    console.warn('Wind fetch failed:', e)
  }
}

function toggleWind() {
  windVisible = !windVisible
  const btn = document.getElementById('wind-toggle')
  if (windVisible) {
    if (windLayer) windLayer.addTo(map)
    btn.classList.add('active')
  } else {
    if (windLayer) map.removeLayer(windLayer)
    btn.classList.remove('active')
  }
}

// --- Wildfires (NASA FIRMS via server proxy) ---
let fireLayer = null
let firesVisible = true

function fireStyle(f) {
  const hot = f.confidence === 'h' || f.confidence === '100' || Number(f.confidence) >= 80
  return {
    radius: Math.min(4 + Math.sqrt(f.frp || 1), 12),
    fillColor: hot ? '#ff4400' : '#ff8800',
    color: '#fff2cc',
    weight: 1,
    opacity: 0.9,
    fillOpacity: 0.7,
  }
}

function firePopup(f) {
  const confLabel = { l: 'Låg', n: 'Normal', h: 'Hög' }[f.confidence] ?? f.confidence
  const hhmm = f.acqTime.padStart(4, '0')
  const acqDateMs = Date.parse(`${f.acqDate}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`)
  const dateStr = new Date(acqDateMs).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' })
  const timeStr = new Date(acqDateMs).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
  const distStr = (userLat !== null)
    ? `<div>Avstånd: ${haversineKm(userLat, userLon, f.lat, f.lon).toFixed(1)} km</div>`
    : ''
  return `<div style="font-size:13px;line-height:1.7">
    <div style="font-weight:600;margin-bottom:4px">🔥 Markbrand ${dateStr} ${timeStr}</div>
    ${distStr}<div>Lat: ${f.lat.toFixed(4)} Lon: ${f.lon.toFixed(4)}</div>
    <div>Styrka (FRP): ${f.frp} MW</div>
    <div>Konfidens: ${confLabel}</div>
    <div style="color:#ffb366">Källa: NASA FIRMS (${f.satellite})</div>
  </div>`
}

async function updateFires() {
  try {
    const res = await fetch('/api/fires')
    if (!res.ok) return
    const data = await res.json()
    if (fireLayer) map.removeLayer(fireLayer)
    // No explicit renderer — shares the map's default canvas with strikes so hit-testing
    // (and thus click-through) works correctly instead of a private canvas blocking clicks.
    fireLayer = L.layerGroup(
      data.map((f) => L.circleMarker([f.lat, f.lon], fireStyle(f)).bindPopup(() => firePopup(f), { className: 'strike-popup' }))
    )
    if (firesVisible) fireLayer.addTo(map)
  } catch (e) {
    console.warn('Fires fetch failed:', e)
  }
}

function toggleFires() {
  firesVisible = !firesVisible
  const btn = document.getElementById('fires-toggle')
  if (firesVisible) {
    if (fireLayer) fireLayer.addTo(map)
    btn.classList.add('active')
  } else {
    if (fireLayer) map.removeLayer(fireLayer)
    btn.classList.remove('active')
  }
}

// --- Boot ---
initMap()
loadFromStorage()
initGeolocation()
connectToServer()
loadFromApi()
loadSmhiData()
updateRadar()
updateWind()
updateFires()
setInterval(updateStrikes, UPDATE_INTERVAL_MS)
setInterval(loadSmhiData, 10 * 60_000)
setInterval(updateRadar, 5 * 60_000)
setInterval(updateWind, 10 * 60_000)
setInterval(updateFires, 15 * 60_000)
window.addEventListener('beforeunload', saveToStorage)
document.getElementById('radar-toggle').addEventListener('click', toggleRadar)
document.getElementById('radar-toggle').classList.add('active')
document.getElementById('wind-toggle').addEventListener('click', toggleWind)
document.getElementById('wind-toggle').classList.add('active')
document.getElementById('fires-toggle').addEventListener('click', toggleFires)
document.getElementById('fires-toggle').classList.add('active')
document.getElementById('layer-toggle').addEventListener('click', (e) => {
  e.stopPropagation()
  document.getElementById('layer-menu').classList.toggle('hidden')
})
document.querySelectorAll('.layer-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    setMapLayer(btn.dataset.layer)
    document.getElementById('layer-menu').classList.add('hidden')
  })
})
document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.layer-select-wrap')
  if (!wrap.contains(e.target)) document.getElementById('layer-menu').classList.add('hidden')
})
