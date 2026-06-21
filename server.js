import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket as NodeWS } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

const app = express()
const httpServer = createServer(app)
const PORT = process.env.PORT ?? 80
const DATA_FILE = '/data/strikes.json'
const MAX_AGE_MS = 3 * 60 * 60 * 1000
const SMHI_BASE = 'https://opendata-download-lightning.smhi.se/api/version/latest'

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
    mkdirSync('/data', { recursive: true })
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

// --- Boot ---
connectBlitzortung()
pollSmhi()
setInterval(pollSmhi, 60_000)
setInterval(save, 60_000)
process.on('SIGTERM', () => { save(); process.exit(0) })

httpServer.listen(PORT, () => console.log(`Blixt på :${PORT}`))
