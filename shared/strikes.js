export const MAX_AGE_MS = 3 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 60_000

export function isValidStrike(strike, now = Date.now()) {
  return strike != null
    && Number.isFinite(strike.lat) && Math.abs(strike.lat) <= 90
    && Number.isFinite(strike.lon) && Math.abs(strike.lon) <= 180
    && Number.isFinite(strike.timeMs) && strike.timeMs > 0
    && strike.timeMs <= now + MAX_CLOCK_SKEW_MS
}

// Only retain typed fields that are used by the map's HTML popups.
function normalizeMeta(meta) {
  if (meta?.source !== 'smhi') return {}
  const result = { source: 'smhi' }
  if (meta.cloudIndicator === 0 || meta.cloudIndicator === 1) result.cloudIndicator = meta.cloudIndicator
  if (Number.isFinite(meta.peakCurrent)) result.peakCurrent = meta.peakCurrent
  return result
}

export class StrikeStore {
  #entries = new Map()

  get size() { return this.#entries.size }
  values() { return this.#entries.values() }

  add(strike, now = Date.now()) {
    if (!isValidStrike(strike, now) || now - strike.timeMs >= MAX_AGE_MS) return null
    const { lat, lon, timeMs } = strike
    const key = `${timeMs}:${lat}:${lon}`
    if (this.#entries.has(key)) return null
    const entry = { lat, lon, timeMs, meta: normalizeMeta(strike.meta) }
    this.#entries.set(key, entry)
    return entry
  }

  prune(now = Date.now()) {
    const removed = []
    for (const [key, strike] of this.#entries) {
      if (now - strike.timeMs >= MAX_AGE_MS) {
        this.#entries.delete(key)
        removed.push(strike)
      }
    }
    return removed
  }
}
