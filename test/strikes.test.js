import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AGE_MS, StrikeStore, isValidStrike } from '../shared/strikes.js'

const now = 1_800_000_000_000
const strike = { lat: 59.3, lon: 18.1, timeMs: now }

test('rejects malformed coordinates and timestamps before storing data', () => {
  const store = new StrikeStore()
  const invalid = [null, undefined, {}, [],
    ...[NaN, Infinity, -Infinity, '59', 90.1, -90.1].map(lat => ({ ...strike, lat })),
    ...[NaN, Infinity, -180.1, 180.1].map(lon => ({ ...strike, lon })),
    ...[NaN, Infinity, 0, -1, '123', now + 60_001].map(timeMs => ({ ...strike, timeMs })),
  ]
  for (const value of invalid) {
    assert.equal(isValidStrike(value, now), false)
    assert.equal(store.add(value, now), null)
  }
  assert.equal(store.size, 0)
  assert.ok(store.add({ lat: -90, lon: 180, timeMs: now + 60_000 }, now))
})

test('history, REST, SMHI and live duplicates share one entry', () => {
  const store = new StrikeStore()
  const entry = store.add(strike, now)
  entry.marker = { id: 'existing marker' }
  for (const source of [undefined, 'smhi', undefined]) {
    assert.equal(store.add({ ...strike, meta: { source } }, now), null)
  }
  assert.equal(store.size, 1)
  assert.equal([...store.values()][0], entry)
  assert.ok(store.add({ ...strike, lon: 18.2 }, now))
  assert.ok(store.add({ ...strike, timeMs: now - 1 }, now))
  assert.equal(store.size, 3)
})

test('expiration removes both entries and deduplication keys at three hours', () => {
  const store = new StrikeStore()
  assert.equal(store.add({ ...strike, timeMs: now - MAX_AGE_MS }, now), null)
  const old = store.add({ ...strike, timeMs: now - MAX_AGE_MS + 1 }, now)
  const current = store.add(strike, now)
  assert.deepEqual(store.prune(now + 1), [old])
  assert.deepEqual([...store.values()], [current])
  assert.deepEqual(store.prune(now + MAX_AGE_MS), [current])
  assert.equal(store.size, 0)
  // Rewinding the test clock confirms that the deduplication key was removed.
  assert.ok(store.add(strike, now))
})

test('metadata keeps numeric SMHI data and discards HTML and arbitrary fields', () => {
  const store = new StrikeStore()
  const meta = { source: 'smhi', peakCurrent: -12.5, cloudIndicator: 0, extra: 'discard' }
  assert.deepEqual(store.add({ ...strike, meta }, now).meta,
    { source: 'smhi', peakCurrent: -12.5, cloudIndicator: 0 })
  const injected = { source: 'smhi', peakCurrent: '<img src=x onerror=alert(1)>', cloudIndicator: '0' }
  assert.deepEqual(store.add({ ...strike, lon: 19, meta: injected }, now).meta, { source: 'smhi' })
  assert.deepEqual(store.add({ ...strike, lon: 20, meta: null }, now).meta, {})
  assert.deepEqual(store.add({ ...strike, lon: 21, meta: { source: '<script>' } }, now).meta, {})
})
