import L from 'leaflet'
import { MAX_AGE_MS, StrikeStore } from '../shared/strikes.js'
import 'leaflet/dist/leaflet.css'
import 'leaflet-velocity/dist/leaflet-velocity.css'
import 'leaflet-velocity'
import './style.css'
import { setupMapUI, reducedMotion, setLayerState, setLayerEnabled } from './map-ui.js'

// --- Config ---
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
const strikes = new StrikeStore()
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
  if (userLat === null || strikes.size === 0) return null
  let min = Infinity
  for (const s of strikes.values()) {
    const d = haversineKm(userLat, userLon, s.lat, s.lon)
    if (d < min) min = d
  }
  return min
}

// --- Map layers ---
// Carto kräver API-nyckel (satt i .env som VITE_CARTO_API_KEY, bakas in vid build eftersom
// Leaflet hämtar tiles direkt i klienten — kan inte proxyas via servern utan att mångdubbla trafiken).
const CARTO_API_KEY = import.meta.env.VITE_CARTO_API_KEY ?? ''
const CARTO_KEY_SUFFIX = CARTO_API_KEY ? `?key=${CARTO_API_KEY}` : ''
const MAP_LAYERS = {
  dark: {
    url: `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${CARTO_KEY_SUFFIX}`,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  light: {
    url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png${CARTO_KEY_SUFFIX}`,
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
  const def = Object.hasOwn(MAP_LAYERS, id) ? id : 'dark'
  const layer = MAP_LAYERS[def]
  if (baseLayer) map.removeLayer(baseLayer)
  const opts = { attribution: layer.attribution, maxZoom: layer.maxZoom }
  if (layer.subdomains) opts.subdomains = layer.subdomains
  if (layer.maxNativeZoom) opts.maxNativeZoom = layer.maxNativeZoom
  const currentLayer = L.tileLayer(layer.url, opts)
  const error = document.getElementById('map-error')
  error.hidden = true
  let failed = false
  currentLayer.on('tileerror', () => {
    if (baseLayer !== currentLayer) return
    failed = true
    error.textContent = 'Kartan kunde inte laddas. Välj en annan karta under Lager.'
    error.hidden = false
  })
  currentLayer.on('loading', () => { failed = false })
  currentLayer.on('load', () => {
    if (baseLayer === currentLayer && !failed) error.hidden = true
  })
  baseLayer = currentLayer
  baseLayer.addTo(map)
  try { localStorage.setItem(MAP_LAYER_KEY, def) } catch { /* storage may be unavailable */ }
  document.querySelectorAll('input[name=basemap]').forEach(input => { input.checked = input.value === def })
}

// --- Map ---
function initMap() {
  const renderer = L.canvas({ padding: 0.5 })

  map = L.map('map', { zoomControl: false, renderer, minZoom: 3, zoomAnimation: !reducedMotion.matches, fadeAnimation: !reducedMotion.matches })
  L.control.zoom({ zoomInTitle: 'Zooma in', zoomOutTitle: 'Zooma ut' }).addTo(map)

  let savedLayer = 'dark'
  try { savedLayer = localStorage.getItem(MAP_LAYER_KEY) || 'dark' } catch {}
  setMapLayer(savedLayer)

  map.setView([62, 15], 5) // Sweden as fallback

  map.createPane('windPane')
  map.getPane('windPane').style.pointerEvents = 'none'

  map.createPane('brandriskPane')
  map.getPane('brandriskPane').style.zIndex = 350 // ovanför tiles/radar, under blixtar/bränder
  map.getPane('brandriskPane').style.pointerEvents = 'none' // rent dekorativt, blockerar inte klick
  brandriskRenderer = L.canvas({ pane: 'brandriskPane', padding: 0.5 })

  const LocControl = L.Control.extend({
    onAdd() {
      const btn = L.DomUtil.create('button', 'leaflet-bar leaflet-control-loc')
      btn.title = 'Min position'
      btn.id = 'locate-button'
      btn.type = 'button'
      btn.setAttribute('aria-label', 'Min position')
      btn.innerHTML = '⊙'
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.stop(e)
        if (userLat !== null) map.setView([userLat, userLon], Math.max(map.getZoom(), 12), { animate: !reducedMotion.matches })
        if (userLat === null || positionWatch === null) initGeolocation()
      })
      return btn
    },
  })
  new LocControl({ position: 'topleft' }).addTo(map)
}

// --- Geolocation ---
let positionWatch = null
function initGeolocation() {
  const notice = document.getElementById('location-status')
  const button = document.getElementById('locate-button')
  notice.hidden = false
  if (!navigator.geolocation) {
    notice.textContent = 'Din webbläsare stöder inte position. Du kan flytta kartan själv.'
    return
  }
  if (positionWatch !== null) navigator.geolocation.clearWatch(positionWatch)
  notice.textContent = 'Hämtar din position…'
  button.setAttribute('aria-busy', 'true')
  positionWatch = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 10_000,
    timeout: 15_000,
  })
}

function onPosition({ coords }) {
  const { latitude: lat, longitude: lon, accuracy } = coords
  userLat = lat
  userLon = lon
  document.getElementById('location-status').hidden = true
  document.getElementById('locate-button').setAttribute('aria-busy', 'false')

  const popupHtml = `${lat.toFixed(5)}, ${lon.toFixed(5)}<br><small class="popup-muted">±${Math.round(accuracy)} m</small>`

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
    }).addTo(map).bindPopup(popupHtml, { className: 'strike-popup', autoPan: false })
  } else {
    userMarker.setLatLng([lat, lon])
    userMarker.setPopupContent(popupHtml)
  }
}

function onPositionError(err) {
  const notice = document.getElementById('location-status')
  notice.textContent = err.code === 1
    ? 'Position nekad. Tillåt platsåtkomst i webbläsaren och tryck på Min position igen.'
    : 'Positionen kunde inte hämtas. Tryck på Min position för att försöka igen.'
  notice.hidden = false
  document.getElementById('locate-button').setAttribute('aria-busy', 'false')
  if (positionWatch !== null) navigator.geolocation.clearWatch(positionWatch)
  positionWatch = null
}

// --- Server WebSocket (primär) ---
function connectToServer() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const serverWs = new WebSocket(`${proto}://${location.host}/ws`)
  let opened = false

  serverWs.onopen = () => {
    opened = true
    sourceState.blitzortung = 'relay'
    sourceState.server = 'ok'
    renderStatus()
  }

  serverWs.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data)
      if (msg.type === 'history') {
        sourceState.blitzortung = 'relay'
        const smhiInHistory = msg.strikes.some(s => s.meta?.source === 'smhi')
        if (smhiInHistory) sourceState.smhi = 'ok'
        for (const { lat, lon, timeMs, meta } of msg.strikes) {
          addStrike(lat, lon, timeMs, false, meta)
        }
        renderStatus()
      } else if (msg.type === 'strike') {
        sourceState.blitzortung = 'relay'
        if (msg.meta?.source === 'smhi') sourceState.smhi = 'ok'
        addStrike(msg.lat, msg.lon, msg.timeMs, true, msg.meta ?? {})
        renderStatus()
      }
    } catch {}
  }

  serverWs.onclose = () => {
    sourceState.server = 'error'
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
  const opacity = Math.max(0, Math.min(1, 1 - ageMs / MAX_AGE_MS))
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
  if (saveTimer !== null) return
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
    const type = { 0: 'Moln–mark', 1: 'Moln–moln' }[meta.cloudIndicator] ?? 'Okänd'
    extraStr += `<div>Typ: ${type}</div>`
  }

  const sourceLabel = meta.source === 'smhi' ? 'SMHI' : 'Blitzortung'
  const sourceColor = meta.source === 'smhi' ? '#7ecaff' : '#ffdd88'

  return `<div class="popup-body">
    <div class="popup-title">Blixtnedslag ${dateStr} ${timeStr}</div>
    ${distStr}${coordStr}${extraStr}<div style="color:${sourceColor}">Källa: ${sourceLabel}</div>
  </div>`
}

function addStrike(lat, lon, timeMs, ripple = false, meta = {}) {
  const strike = strikes.add({ lat, lon, timeMs, meta })
  if (!strike) return false
  meta = strike.meta
  const marker = L.circleMarker([lat, lon], strikeStyle(Date.now() - timeMs, meta))
    .bindPopup(() => strikePopup(timeMs, meta, lat, lon), { className: 'strike-popup', autoPan: false })
    .addTo(map)
  strike.marker = marker
  if (ripple && !reducedMotion.matches) addRipple(lat, lon)
  scheduleSave()
  return true
}

function updateStrikes() {
  const now = Date.now()
  for (const strike of strikes.prune(now)) map.removeLayer(strike.marker)
  for (const strike of strikes.values()) {
    strike.marker.setStyle(strikeStyle(now - strike.timeMs, strike.meta))
  }

  renderStatus()

}

// --- Status bar ---
function renderStatus() {
  const count = strikes.size
  const countStr = count > 0
    ? `${count} blixt${count !== 1 ? 'ar' : ''}`
    : 'Inga blixtar'

  const connection = {
    connecting: 'Ansluter…',
    relay: 'Ansluten till servern',
    live: 'Blitzortung direkt',
    reconnecting: 'Återansluter…',
  }[sourceState.blitzortung]
  const details = [connection]
  if (sourceState.smhi === 'ok') details.push('SMHI-data')
  if (sourceState.smhi === 'loading') details.push('Hämtar SMHI…')
  if (sourceState.server === 'error') details.push('Servern kan inte nås')
  const status = document.getElementById('status')
  status.replaceChildren()
  const countNode = document.createElement('span')
  countNode.className = 'status-count'
  countNode.textContent = countStr
  const detailNode = document.createElement('span')
  detailNode.className = 'status-detail'
  detailNode.textContent = details.join(' · ')
  status.append(countNode, detailNode)
  const announcement = document.getElementById('connection-announcement')
  const message = sourceState.server === 'error' ? 'Servern kan inte nås' : connection
  if (announcement.textContent !== message) announcement.textContent = message

}

// --- Persistence ---
const STORAGE_KEY = 'blixt_strikes'

function saveToStorage() {
  clearTimeout(saveTimer)
  saveTimer = null
  const now = Date.now()
  const payload = [...strikes.values()]
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
    const res = await fetch('/api/strikes', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error('Strikes API HTTP ' + res.status)
    const data = await res.json()
    const now = Date.now()
    for (const { lat, lon, timeMs, meta } of data) {
      if (now - timeMs > MAX_AGE_MS) continue
      addStrike(lat, lon, timeMs, false, meta)
    }
    sourceState.server = 'ok'
    sourceState.smhi = [...strikes.values()].some(s => s.meta.source === 'smhi') ? 'ok' : 'empty'
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

  for (const d of days) {
    let raw
    try {
      const res = await fetch(`${SMHI_BASE}/year/${d.year}/month/${d.month}/day/${d.day}/data.json`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) continue
      raw = (await res.json()).values
      if (!Array.isArray(raw)) continue
    } catch { continue }

    for (const s of raw) {
      const timeMs = Date.UTC(s.year, s.month - 1, s.day, s.hours, s.minutes, s.seconds, Math.floor(s.nanoseconds / 1e6))
      if (timeMs < cutoff) continue
      addStrike(s.lat, s.lon, timeMs, false, { source: 'smhi', cloudIndicator: s.cloudIndicator, peakCurrent: s.peakCurrent })
    }
  }

  if (sourceState.smhi === 'loading') {
    sourceState.smhi = [...strikes.values()].some(s => s.meta.source === 'smhi') ? 'ok' : 'empty'
    renderStatus()
  }
}

// --- Rain radar (RainViewer) ---
let radarLayer = null
let radarVisible = true

async function updateRadar() {
  setLayerState('radar', 'loading')
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error('Radar API HTTP ' + res.status)
    const data = await res.json()
    const frames = data.radar?.past
    if (!frames?.length) {
      if (radarLayer) map.removeLayer(radarLayer)
      radarLayer = null
      setLayerState('radar', 'empty')
      return
    }
    const latest = frames[frames.length - 1]
    const url = `${data.host}${latest.path}/256/{z}/{x}/{y}/6/1_1.png`
    if (radarLayer) map.removeLayer(radarLayer)
    radarLayer = L.tileLayer(url, { opacity: 0.5, zIndex: 200, minNativeZoom: 3, maxNativeZoom: 7, attribution: 'Rain: RainViewer' })
    const currentRadar = radarLayer
    let tileFailed = false
    radarLayer.on('loading', () => { tileFailed = false })
    radarLayer.on('load', () => {
      if (currentRadar === radarLayer) setLayerState('radar', tileFailed ? 'error' : 'ready')
    })
    radarLayer.on('tileerror', (e) => {
      tileFailed = true
      if (currentRadar === radarLayer) setLayerState('radar', 'error')
      e.tile.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    })
    setLayerState('radar', 'ready')
    if (radarVisible) radarLayer.addTo(map)
  } catch { setLayerState('radar', radarLayer ? 'stale' : 'error') }
}

function toggleRadar() {
  radarVisible = !radarVisible
  if (radarLayer) {
    if (radarVisible) radarLayer.addTo(map)
    else map.removeLayer(radarLayer)
  }
  setLayerEnabled('radar', radarVisible)
}

// --- Wind (leaflet-velocity + SMHI snow1g via serverproxy) ---
// Servern hämtar vindgridden (Skandinavien) åt alla klienter en gång i
// stället för att varje besökare gör samma hämtning själv (se pollWind i
// server.js, som äger grid-bbox/upplösning och uppdateringsintervall).
let windLayer = null
let windVisible = !reducedMotion.matches

async function updateWind() {
  setLayerState('wind', 'loading')
  try {
    const res = await fetch('/api/wind', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error('Wind API HTTP ' + res.status)
    const { data: velData } = await res.json()
    if (!velData) { setLayerState('wind', windLayer ? 'stale' : 'empty'); return }
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
    setLayerState('wind', 'ready')
  } catch (e) {
    setLayerState('wind', windLayer ? 'stale' : 'error')
    console.warn('Wind fetch failed:', e)
  }
}

function toggleWind() {
  windVisible = !windVisible
  if (windLayer) {
    if (windVisible) windLayer.addTo(map)
    else map.removeLayer(windLayer)
  }
  setLayerEnabled('wind', windVisible)
}

// --- Wildfires (NASA FIRMS via server proxy) ---
let fireLayer = null
let firesVisible = false

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
  return `<div class="popup-body">
    <div class="popup-title">🔥 Markbrand ${dateStr} ${timeStr}</div>
    ${distStr}<div>Lat: ${f.lat.toFixed(4)} Lon: ${f.lon.toFixed(4)}</div>
    <div>Styrka (FRP): ${f.frp} MW</div>
    <div>Konfidens: ${confLabel}</div>
    <div style="color:#ffb366">Källa: NASA FIRMS (${f.satellite})</div>
  </div>`
}

async function updateFires() {
  setLayerState('fires', 'loading')
  try {
    const res = await fetch('/api/fires', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error('API HTTP ' + res.status)
    const data = await res.json()
    if (fireLayer) map.removeLayer(fireLayer)
    // No explicit renderer — shares the map's default canvas with strikes so hit-testing
    // (and thus click-through) works correctly instead of a private canvas blocking clicks.
    fireLayer = L.layerGroup(
      data.map((f) => L.circleMarker([f.lat, f.lon], fireStyle(f)).bindPopup(() => firePopup(f), { className: 'strike-popup', autoPan: false }))
    )
    if (firesVisible) fireLayer.addTo(map)
    setLayerState('fires', data.length ? 'ready' : 'empty')
  } catch (e) {
    setLayerState('fires', fireLayer ? 'stale' : 'error')
    console.warn('Fires fetch failed:', e)
  }
}

function toggleFires() {
  firesVisible = !firesVisible
  if (fireLayer) {
    if (firesVisible) fireLayer.addTo(map)
    else map.removeLayer(fireLayer)
  }
  setLayerEnabled('fires', firesVisible)
}

// --- Brandrisk (SMHI via serverproxy /api/brandrisk) ---
// SMHI:s brandriskprognos (fwif1g) levereras som ett rutnät av punkter över
// Sverige. Risknivån anges av parametern "fwiindex": heltal 1–6 (klass),
// eller -1 = data saknas/utanför säsong. Se
// https://opendata.smhi.se/metfcst/fwif/parameters (verifierat 2026-08-02).
const BRANDRISK_COLORS = ['#3fa34d', '#8fbf3f', '#ffce00', '#f28f3b', '#e5484d', '#8b0000']
// Mörkare kusin till varje färg ovan, till punkternas kant — samma idiom som
// blixtarnas fill+stroke (se AGE_COLORS) i stället för en platt svart kant.
const BRANDRISK_STROKE = ['#256b30', '#5c7f22', '#cc9e00', '#c56a1c', '#a5262b', '#4d0000']
const BRANDRISK_LABELS = ['Mycket liten risk', 'Liten risk', 'Måttlig risk', 'Stor risk', 'Mycket stor risk', 'Extremt stor risk']
// Servergridden har 0.8° steg (~55-90 km beroende på breddgrad). Varje punkt
// ritas som två överlappande cirklar (liten mättad kärna + stor ljus halo) i
// stället för en enda platt cirkel — halon ger en mjuk, gradvis avtoning ut
// mot grannpunkterna så det blir ett riktigt "molnigt" utseende (som
// regnradarn) i stället för en pixlig/kantig rutnätssilhuett när blur-filtret
// på panen (se .leaflet-brandrisk-pane i style.css) sen tonar ihop allt.
const BRANDRISK_CORE_RADIUS_M = 42_000
const BRANDRISK_HALO_RADIUS_M = 95_000

let brandriskLayer = null
let brandriskVisible = false // avstängt som standard tills data finns tillgänglig
let brandriskRenderer = null

function brandriskStep(point) {
  const v = point.fwiindex
  if (typeof v !== 'number' || v === -1) return -1 // data saknas/utanför säsong
  return Math.max(0, Math.min(Math.round(v) - 1, BRANDRISK_COLORS.length - 1))
}

// Molnigt bakgrundslager: två storlekar per punkt (halo + kärna), rent
// dekorativa (klick går rakt igenom till punkt-lagret nedan).
function brandriskHaloStyle(point) {
  return {
    renderer: brandriskRenderer,
    radius: BRANDRISK_HALO_RADIUS_M,
    fillColor: BRANDRISK_COLORS[brandriskStep(point)],
    stroke: false,
    fillOpacity: 0.22,
    interactive: false,
  }
}

function brandriskCoreStyle(point) {
  return {
    renderer: brandriskRenderer,
    radius: BRANDRISK_CORE_RADIUS_M,
    fillColor: BRANDRISK_COLORS[brandriskStep(point)],
    stroke: false,
    fillOpacity: 0.5,
    interactive: false,
  }
}

// Klickbara punkter ovanpå molnet — samma delade renderer som blixtar/bränder,
// så klick/popup fungerar exakt som innan.
function brandriskDotStyle(point) {
  const step = brandriskStep(point)
  return {
    radius: 6,
    fillColor: BRANDRISK_COLORS[step],
    color: BRANDRISK_STROKE[step],
    weight: 1.5,
    fillOpacity: 0.9,
  }
}

function brandriskPopup(point) {
  const step = brandriskStep(point)
  const riskLine = step >= 0
    ? `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
         <span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${BRANDRISK_COLORS[step]};border:1px solid ${BRANDRISK_STROKE[step]}"></span>
         <b>${BRANDRISK_LABELS[step]}</b>
         <span class="popup-muted">(nivå ${step + 1}/6)</span>
       </div>`
    : '<div class="popup-muted">Ingen riskdata på denna punkt</div>'
  const valid = point.validTime ? ` (${new Date(point.validTime).toLocaleString('sv-SE')})` : ''
  return `<div class="popup-body">
    <div class="popup-title">⚠️ Brandrisk ${point.lat.toFixed(2)}, ${point.lon.toFixed(2)}</div>
    ${riskLine}
    <div style="color:#ffb366">Källa: SMHI brandriskprognos${valid}</div>
  </div>`
}

async function updateBrandrisk() {
  setLayerState('brandrisk', 'loading')
  try {
    const res = await fetch('/api/brandrisk', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error('API HTTP ' + res.status)
    const data = await res.json()
    const points = (data?.points ?? []).filter((p) => brandriskStep(p) >= 0)
    if (brandriskLayer) map.removeLayer(brandriskLayer)
    // Halor ritas först (underst) så kärnorna hamnar ovanpå dem.
    const halos = points.map((p) => L.circle([p.lat, p.lon], brandriskHaloStyle(p)))
    const cores = points.map((p) => L.circle([p.lat, p.lon], brandriskCoreStyle(p)))
    const dots = points.map((p) => L.circleMarker([p.lat, p.lon], brandriskDotStyle(p))
      .bindPopup(() => brandriskPopup(p), { className: 'strike-popup', autoPan: false }))
    brandriskLayer = L.layerGroup([...halos, ...cores, ...dots])
    if (brandriskVisible) brandriskLayer.addTo(map)
    setLayerState('brandrisk', points.length ? 'ready' : 'empty')
  } catch (e) {
    setLayerState('brandrisk', brandriskLayer ? 'stale' : 'error')
    console.warn('Brandrisk fetch failed:', e)
  }
}

function toggleBrandrisk() {
  brandriskVisible = !brandriskVisible
  if (brandriskLayer) {
    if (brandriskVisible) brandriskLayer.addTo(map)
    else map.removeLayer(brandriskLayer)
  }
  setLayerEnabled('brandrisk', brandriskVisible)
  document.getElementById('brandrisk-legend').hidden = !brandriskVisible
}

// --- Boot ---
initMap()
setupMapUI(map)
loadFromStorage()
initGeolocation()
connectToServer()
loadFromApi()
loadSmhiData()
updateRadar()
updateWind()
updateFires()
updateBrandrisk()
setInterval(updateStrikes, UPDATE_INTERVAL_MS)
setInterval(loadSmhiData, 10 * 60_000)
setInterval(updateRadar, 5 * 60_000)
setInterval(updateWind, 10 * 60_000)
setInterval(updateFires, 15 * 60_000)
setInterval(updateBrandrisk, 30 * 60_000)
window.addEventListener('beforeunload', saveToStorage)
for (const [id, enabled, toggle] of [
  ['radar', radarVisible, toggleRadar], ['wind', windVisible, toggleWind],
  ['fires', firesVisible, toggleFires], ['brandrisk', brandriskVisible, toggleBrandrisk],
]) {
  document.getElementById(`${id}-toggle`).addEventListener('click', toggle)
  setLayerEnabled(id, enabled)
}
document.getElementById('motion-note').hidden = !reducedMotion.matches
reducedMotion.addEventListener('change', () => {
  document.getElementById('motion-note').hidden = !reducedMotion.matches
  if (reducedMotion.matches && windVisible) toggleWind()
})
document.querySelectorAll('input[name=basemap]').forEach(input => {
  input.addEventListener('change', () => { if (input.checked) setMapLayer(input.value) })
})
