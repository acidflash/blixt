import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket as NodeWS } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'

const app = express()
const httpServer = createServer(app)
const PORT = process.env.PORT ?? 80
const DATA_FILE = process.env.DATA_FILE ?? '/data/strikes.json'
const MAX_AGE_MS = 3 * 60 * 60 * 1000
const SMHI_BASE = 'https://opendata-download-lightning.smhi.se/api/version/latest'
const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY
const FIRMS_SOURCE = 'VIIRS_SNPP_NRT'
const FIRMS_AREA = '-180,-90,180,90' // world

// --- Access log + besöksstatistik ---
// Loggfil + besökarantal sparas i samma /data-volym som strikes.json så de
// överlever omstart. En "besökare" räknas per unikt IP som hämtar /
// (index.html) — inte varje asset/API-anrop.
const ACCESS_LOG_FILE = process.env.ACCESS_LOG_FILE ?? join(dirname(DATA_FILE), 'access.log')
const VISITORS_FILE = process.env.VISITORS_FILE ?? join(dirname(DATA_FILE), 'visitors.json')

const todayKey = () => new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)

let visitorHistory = {} // { 'YYYY-MM-DD': antal unika besökare }
try {
  visitorHistory = JSON.parse(readFileSync(VISITORS_FILE, 'utf8'))
} catch {}

let visitorsDate = todayKey()
let visitorsToday = new Set()

function saveVisitors() {
  try {
    mkdirSync(dirname(VISITORS_FILE), { recursive: true })
    writeFileSync(VISITORS_FILE, JSON.stringify({ ...visitorHistory, [visitorsDate]: visitorsToday.size }))
  } catch (e) {
    console.error('Visitor save error:', e.message)
  }
}

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip
  const today = todayKey()
  if (today !== visitorsDate) {
    visitorHistory[visitorsDate] = visitorsToday.size
    visitorsDate = today
    visitorsToday = new Set()
  }
  if (req.path === '/' || req.path === '/index.html') visitorsToday.add(ip)

  res.on('finish', () => {
    const line = `${new Date().toISOString()} ${ip} ${req.method} ${req.originalUrl} ${res.statusCode}\n`
    try {
      mkdirSync(dirname(ACCESS_LOG_FILE), { recursive: true })
      appendFileSync(ACCESS_LOG_FILE, line)
    } catch (e) {
      console.error('Access log error:', e.message)
    }
  })
  next()
})

app.get('/api/stats', (_req, res) => {
  res.json({ date: visitorsDate, visitorsToday: visitorsToday.size, history: visitorHistory })
})

app.use(express.json({ limit: '2mb' }))
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'dist')))

let strikes = []
try {
  const now = Date.now()
  strikes = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    .filter(s => now - s.timeMs < MAX_AGE_MS)
  console.log(`Loaded ${strikes.length} strikes from disk`)
} catch {}

function cleanup() {
  const cutoff = Date.now() - MAX_AGE_MS
  strikes = strikes.filter(s => s.timeMs > cutoff)
}

function save() {
  cleanup()
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true })
    writeFileSync(DATA_FILE, JSON.stringify(strikes))
  } catch (e) {
    console.error('Save error:', e.message)
  }
}

// --- WebSocket server (browsers connect here) ---
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws) => {
  cleanup()
  ws.send(JSON.stringify({ type: 'history', strikes }))
  ws.on('error', () => {})
})

function broadcast(strike) {
  const msg = JSON.stringify({ type: 'strike', ...strike })
  for (const client of wss.clients) {
    if (client.readyState === NodeWS.OPEN) client.send(msg)
  }
}

// --- Unified strike ingestion ---
function ingest(lat, lon, timeMs, meta = {}) {
  if (Date.now() - timeMs > MAX_AGE_MS) return
  if (strikes.some(s => s.timeMs === timeMs && s.lat === lat && s.lon === lon)) return
  const strike = { lat, lon, timeMs, meta }
  strikes.push(strike)
  broadcast(strike)
}

// --- REST API (keep for backward compat + health checks) ---
app.get('/api/strikes', (_req, res) => {
  cleanup()
  res.json(strikes)
})

app.post('/api/strikes', (req, res) => {
  const { lat, lon, timeMs, meta } = req.body
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof timeMs !== 'number')
    return res.sendStatus(400)
  ingest(lat, lon, timeMs, meta ?? {})
  res.sendStatus(204)
})

// --- Blitzortung relay ---
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

const BLITZ_URLS = [
  'wss://ws1.blitzortung.org/',
  'wss://ws2.blitzortung.org/',
  'wss://ws7.blitzortung.org/',
  'wss://ws8.blitzortung.org/',
]
let blitzIdx = 0

function connectBlitzortung() {
  const url = BLITZ_URLS[blitzIdx % BLITZ_URLS.length]
  const ws = new NodeWS(url)

  ws.on('open', () => {
    ws.send('{"a":111}')
    console.log(`[Blitzortung] ansluten till ${url}`)
  })

  ws.on('message', (data) => {
    try {
      const d = JSON.parse(lzwDecode(data.toString()))
      if (typeof d.lat !== 'number' || typeof d.lon !== 'number') return
      if (typeof d.latc === 'number') d.lat += d.latc
      if (typeof d.lonc === 'number') d.lon += d.lonc
      const timeMs = d.time ? d.time / 1e6 : Date.now()
      ingest(d.lat, d.lon, timeMs, {})
    } catch {}
  })

  ws.on('close', () => {
    blitzIdx++
    console.log('[Blitzortung] frånkopplad, återansluter…')
    setTimeout(connectBlitzortung, 3000)
  })

  ws.on('error', () => {
    blitzIdx++
    setTimeout(connectBlitzortung, 3000)
  })
}

// --- SMHI polling ---
const smhiSeen = new Set()

function smhiToMs(s) {
  return Date.UTC(s.year, s.month - 1, s.day, s.hours, s.minutes, s.seconds, Math.floor(s.nanoseconds / 1e6))
}

async function fetchSmhiDay(year, month, day) {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  const res = await fetch(`${SMHI_BASE}/year/${year}/month/${m}/day/${d}/data.json`)
  if (!res.ok) return []
  return (await res.json()).values ?? []
}

async function pollSmhi() {
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
    try { raw = await fetchSmhiDay(d.year, d.month, d.day) } catch { continue }
    for (const s of raw) {
      const timeMs = smhiToMs(s)
      if (timeMs < cutoff) continue
      const key = `${timeMs}:${s.lat}:${s.lon}`
      if (smhiSeen.has(key)) continue
      smhiSeen.add(key)
      ingest(s.lat, s.lon, timeMs, { source: 'smhi', cloudIndicator: s.cloudIndicator, peakCurrent: s.peakCurrent })
      added++
    }
  }
  if (added > 0) console.log(`[SMHI] +${added} slag`)
}

// --- Wildfires (NASA FIRMS) ---
let fires = []

function parseFiresCsv(csv) {
  const lines = csv.trim().split('\n')
  if (lines.length < 2) return []
  const cols = lines[0].split(',')
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]))
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',')
    const confidence = f[idx.confidence]
    if (confidence === 'l') continue // skip low-confidence detections
    out.push({
      lat: Number(f[idx.latitude]),
      lon: Number(f[idx.longitude]),
      acqDate: f[idx.acq_date],
      acqTime: f[idx.acq_time],
      confidence,
      frp: Number(f[idx.frp]) || 0,
      satellite: f[idx.satellite],
      daynight: f[idx.daynight],
    })
  }
  return out
}

// NRT VIIRS can return 40k+ points/day worldwide — one Leaflet layer per point
// freezes the map's hit-testing. Collapse to one (hottest) detection per grid cell.
const FIRMS_GRID_DEG = 0.4
function decimateFires(list) {
  const cells = new Map()
  for (const f of list) {
    const key = `${Math.round(f.lat / FIRMS_GRID_DEG)}:${Math.round(f.lon / FIRMS_GRID_DEG)}`
    const existing = cells.get(key)
    if (!existing || f.frp > existing.frp) cells.set(key, f)
  }
  return [...cells.values()]
}

async function pollFires() {
  if (!FIRMS_MAP_KEY) return
  try {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/${FIRMS_SOURCE}/${FIRMS_AREA}/1`
    const res = await fetch(url)
    if (!res.ok) { console.error('[FIRMS] HTTP', res.status); return }
    const csv = await res.text()
    if (csv.startsWith('Invalid') || csv.startsWith('Error')) { console.error('[FIRMS]', csv.slice(0, 120)); return }
    fires = decimateFires(parseFiresCsv(csv))
    console.log(`[FIRMS] ${fires.length} bränder`)
  } catch (e) {
    console.error('[FIRMS] fetch error:', e.message)
  }
}

app.get('/api/fires', (_req, res) => {
  res.json(fires)
})

// --- Brandrisk (SMHI fwif-prognos via proxy) ---
// Hämtar brandriskprognosen som ett rutnät av punkter över Sverige från SMHI:s
// öppna prognos-API (metfcst, kategori "fwif1g" = Fire Weather Index / brandrisk).
// Verifierat mot https://opendata.smhi.se/metfcst/fwif/introduction (2026-08-02).
// Katsa/version/period konfigurerbara via env så de kan justeras mot
// nuvarande SMHI-definition utan kodändring.
const BRANDRISK_CATEGORY = process.env.BRANDRISK_CATEGORY ?? 'fwif1g'
const BRANDRISK_VERSION = process.env.BRANDRISK_VERSION ?? '1'
const BRANDRISK_PERIOD = process.env.BRANDRISK_PERIOD ?? 'hourly' // 'hourly' | 'daily'
const BRANDRISK_BASE = `https://opendata-download-metfcst.smhi.se/api/category/${BRANDRISK_CATEGORY}/version/${BRANDRISK_VERSION}/${BRANDRISK_PERIOD}`
// Rutnät över Sverige
const BR_LAT_MIN = 55, BR_LAT_MAX = 69.5
const BR_LON_MIN = 10, BR_LON_MAX = 24.5
const BR_STEP = 0.8
const BR_CONCURRENCY = 8

let brandrisk = [] // { lat, lon, validTime, approvedTime, values }
let brandriskUpdated = null

// Välj den tidpunkt i prognosen som ligger närmast "nu".
function pickTimeStep(timeSeries, nowMs) {
  let best = timeSeries.length - 1
  let bestDiff = Infinity
  for (let i = 0; i < timeSeries.length; i++) {
    const t = Date.parse(timeSeries[i].validTime)
    if (Number.isNaN(t)) continue
    const d = Math.abs(t - nowMs)
    if (d < bestDiff) { bestDiff = d; best = i }
  }
  return timeSeries[best]
}

async function fetchBrandriskPoint(lat, lon) {
  const res = await fetch(`${BRANDRISK_BASE}/geotype/point/lon/${lon}/lat/${lat}/data.json`)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const json = await res.json()
  const ts = json.timeSeries
  if (!Array.isArray(ts) || !ts.length) return null
  const step = pickTimeStep(ts, Date.now())
  const param = step.parameters?.find(p => p.name === 'fwiindex')
  const fwiindex = Array.isArray(param?.values) ? param.values.at(-1) : param?.values
  if (typeof fwiindex !== 'number' || fwiindex === 9999) return null // saknas / utanför SMHI:s prognosområde
  return { lat, lon, validTime: step.validTime, approvedTime: json.approvedTime, fwiindex }
}

async function pollBrandrisk() {
  const pts = []
  for (let lat = BR_LAT_MAX; lat >= BR_LAT_MIN; lat -= BR_STEP) {
    for (let lon = BR_LON_MIN; lon <= BR_LON_MAX; lon += BR_STEP) {
      pts.push([Math.round(lat * 10) / 10, Math.round(lon * 10) / 10])
    }
  }

  const out = []
  let idx = 0
  const workers = Array.from({ length: BR_CONCURRENCY }, async () => {
    while (true) {
      const i = idx++
      if (i >= pts.length) break
      const [la, lo] = pts[i]
      try {
        const r = await fetchBrandriskPoint(la, lo)
        if (r) out.push(r)
      } catch { /* punktfel ignoreras */ }
    }
  })
  await Promise.all(workers)

  if (out.length) {
    brandrisk = out
    brandriskUpdated = new Date().toISOString()
    console.log(`[Brandrisk] ${out.length}/${pts.length} punkter (SMHI ${BRANDRISK_CATEGORY} v${BRANDRISK_VERSION})`)
  } else {
    console.warn('[Brandrisk] inga punkter hämtades – SMHI otillgänglig? Data kvar: ' + brandrisk.length)
  }
}

app.get('/api/brandrisk', (_req, res) => {
  res.json({ updated: brandriskUpdated, validTime: brandrisk[0]?.validTime ?? null, points: brandrisk })
})

// --- Wind (Open-Meteo via proxy) ---
// Open-Meteos gratistier har tre travande gränser: ~600 "location calls"/minut,
// 5 000/timme, och — den som faktiskt styr här — bara 10 000/dygn, DELAD per
// käll-IP mellan allt som anropar Open-Meteo från den IP:n. Det gamla
// klient-side upplägget hämtade en global 4°-grid (4186 punkter) i 9 parallella
// anrop PER BESÖKARE, vilket small i minutgränsen direkt (HTTP 429). Ett
// server-side 6°-grid (1891 punkter, var 6:e timme ≈ 7 564 anrop/dygn) löste
// burst-problemet men åt ändå 76 % av HELA dygnsbudgeten på egen hand — noll
// marginal för omförsök, och en enda misslyckad körning + 15-min-retry räckte
// för att permanent trigga "Daily API request limit exceeded" (verifierat
// 2026-08-11: `curl` mot Open-Meteo gav 429 med den texten direkt, oavsett
// vad servern gjorde). Gridden är därför skalad ner till Skandinavien i
// stället för hela jorden (samma bbox som brandrisk) — 900 punkter × 4
// körningar/dygn ≈ 3 600 anrop/dygn, 36 % av budgeten, med gott om marginal
// för omförsök. Ger dessutom bättre lokal upplösning (0,5°) än det gamla
// 6°-globala rutnätet. Inom varje körning hämtas punkterna sekventiellt i
// små chunkar med paus mellan, så att inte heller minut- eller timgränsen
// träffas.
const WIND_LA1 = 69.5, WIND_LA2 = 55
const WIND_LO1 = 10, WIND_LO2 = 24.5
const WIND_D = 0.5
const WIND_NX = Math.round((WIND_LO2 - WIND_LO1) / WIND_D) + 1
const WIND_NY = Math.round((WIND_LA1 - WIND_LA2) / WIND_D) + 1
const WIND_POINTS = WIND_NX * WIND_NY
const WIND_CHUNK = 200
const WIND_CHUNK_DELAY_MS = 3000

let windData = null // leaflet-velocity-formaterad data (två headers + arrays)
let windUpdated = null

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchWindChunk(chunk) {
  const lats = chunk.map(p => p[0]).join(',')
  const lons = chunk.map(p => p[1]).join(',')
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&forecast_days=1`
  )
  if (!res.ok) throw new Error('Open-Meteo HTTP ' + res.status)
  const json = await res.json()
  return Array.isArray(json) ? json : (json.results ?? [json])
}

async function pollWind() {
  const points = []
  for (let lat = WIND_LA1; lat >= WIND_LA2; lat -= WIND_D) {
    for (let lon = WIND_LO1; lon <= WIND_LO2; lon += WIND_D) {
      points.push([lat, lon])
    }
  }

  const speeds = new Array(WIND_POINTS)
  const dirs = new Array(WIND_POINTS)
  try {
    let idx = 0
    for (let i = 0; i < WIND_POINTS; i += WIND_CHUNK) {
      const data = await fetchWindChunk(points.slice(i, i + WIND_CHUNK))
      for (const r of data) {
        speeds[idx] = r.current?.wind_speed_10m ?? 0
        dirs[idx] = (r.current?.wind_direction_10m ?? 0) * Math.PI / 180
        idx++
      }
      if (i + WIND_CHUNK < WIND_POINTS) await sleep(WIND_CHUNK_DELAY_MS)
    }

    const uData = new Array(WIND_POINTS)
    const vData = new Array(WIND_POINTS)
    for (let i = 0; i < WIND_POINTS; i++) {
      uData[i] = -speeds[i] * Math.sin(dirs[i])
      vData[i] = -speeds[i] * Math.cos(dirs[i])
    }

    const refTime = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const hdr = { parameterUnit: 'm.s-1', parameterCategory: 2, dx: WIND_D, dy: WIND_D, la1: WIND_LA1, la2: WIND_LA2, lo1: WIND_LO1, lo2: WIND_LO2, nx: WIND_NX, ny: WIND_NY, refTime }
    windData = [
      { header: { ...hdr, parameterNumber: 2, parameterNumberName: 'eastward_wind' }, data: uData },
      { header: { ...hdr, parameterNumber: 3, parameterNumberName: 'northward_wind' }, data: vData },
    ]
    windUpdated = new Date().toISOString()
    console.log(`[Wind] ${WIND_POINTS} punkter hämtade (Open-Meteo)`)
    return true
  } catch (e) {
    console.warn('[Wind] hämtning misslyckades, behåller tidigare data:', e.message)
    return false
  }
}

// Självschemalagd i stället för setInterval: vid fel (t.ex. Open-Meteos
// kvot inte återställd än) försöks igen efter en kort stund i stället för
// att vänta hela 6-timmarscykeln — annars kan en enda misslyckad körning
// lämna vindlagret tomt i timmar. En enstaka extra retry var 15:e minut
// påverkar inte dygnsbudgeten nämnvärt.
const WIND_INTERVAL_MS = 6 * 60 * 60_000
const WIND_RETRY_MS = 15 * 60_000
async function scheduleWind() {
  const ok = await pollWind()
  setTimeout(scheduleWind, ok ? WIND_INTERVAL_MS : WIND_RETRY_MS)
}

app.get('/api/wind', (_req, res) => {
  res.json({ updated: windUpdated, data: windData })
})

// --- Boot ---
connectBlitzortung()
pollSmhi()
pollFires()
pollBrandrisk()
scheduleWind()
setInterval(pollSmhi, 60_000)
setInterval(pollFires, 30 * 60_000)
setInterval(pollBrandrisk, 30 * 60_000)
setInterval(save, 60_000)
setInterval(saveVisitors, 60_000)
process.on('SIGTERM', () => { save(); saveVisitors(); process.exit(0) })

httpServer.listen(PORT, () => console.log(`Blixt på :${PORT}`))
