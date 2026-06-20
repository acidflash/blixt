import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

const app = express()
const PORT = 80
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

app.get('/api/strikes', (_req, res) => {
  cleanup()
  res.json(strikes)
})

app.post('/api/strikes', (req, res) => {
  const { lat, lon, timeMs, meta } = req.body
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof timeMs !== 'number')
    return res.sendStatus(400)
  if (Date.now() - timeMs > MAX_AGE_MS)
    return res.sendStatus(204)
  const dup = strikes.some(s => s.timeMs === timeMs && s.lat === lat && s.lon === lon)
  if (!dup) strikes.push({ lat, lon, timeMs, meta: meta ?? {} })
  res.sendStatus(204)
})

// --- Server-side SMHI polling ---
const smhiSeen = new Set()

function smhiToMs(s) {
  return Date.UTC(s.year, s.month - 1, s.day, s.hours, s.minutes, s.seconds, Math.floor(s.nanoseconds / 1e6))
}

async function fetchSmhiDay(year, month, day) {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  const url = `${SMHI_BASE}/year/${year}/month/${m}/day/${d}/data.json`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = await res.json()
  return data.values ?? []
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
      const meta = { source: 'smhi', cloudIndicator: s.cloudIndicator, peakCurrent: s.peakCurrent }
      strikes.push({ lat: s.lat, lon: s.lon, timeMs, meta })
      added++
    }
  }
  if (added > 0) console.log(`[SMHI] +${added} strikes`)
}

pollSmhi()
setInterval(pollSmhi, 60_000)

setInterval(save, 60_000)
process.on('SIGTERM', () => { save(); process.exit(0) })

app.listen(PORT, () => console.log(`Blixt på :${PORT}`))
