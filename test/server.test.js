import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const directory = await mkdtemp(join(tmpdir(), 'blixt-test-'))
process.env.DATA_FILE = join(directory, 'strikes.json')
process.env.ACCESS_LOG_FILE = join(directory, 'access.log')
process.env.VISITORS_FILE = join(directory, 'visitors.json')
const saved = { lat: 60, lon: 16, timeMs: Date.now(), meta: { source: 'smhi', peakCurrent: '<script>' } }
await writeFile(process.env.DATA_FILE, JSON.stringify([saved, saved, null, { ...saved, lat: 999 }]))
const { httpServer, connectBlitzortung } = await import('../server.js')
let baseUrl

before(async () => {
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))
  await rm(directory, { recursive: true, force: true })
})

test('disk history is validated, sanitized and deduplicated on startup', async () => {
  const response = await fetch(`${baseUrl}/api/strikes`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [{ ...saved, meta: { source: 'smhi' } }])
})

test('REST rejects missing bodies, invalid coordinates and future timestamps', async () => {
  assert.equal((await fetch(`${baseUrl}/api/strikes`, { method: 'POST' })).status, 400)
  for (const body of [{}, [], { ...saved, lat: 91 }, { ...saved, lon: -181 },
    { ...saved, timeMs: Date.now() + 120_000 }]) {
    const response = await fetch(`${baseUrl}/api/strikes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
  }
})

test('REST ingestion broadcasts one sanitized strike and retains one history entry', async t => {
  const ws = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws')
  t.after(() => ws.terminate())
  const [history] = await once(ws, 'message')
  assert.equal(JSON.parse(history).type, 'history')
  const messages = []
  ws.on('message', data => messages.push(JSON.parse(data)))
  const incoming = { ...saved, lat: 61, meta: { source: 'smhi', peakCurrent: '<img onerror=alert(1)>' } }
  const broadcast = once(ws, 'message')
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${baseUrl}/api/strikes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(incoming),
    })
    assert.equal(response.status, 204)
  }
  await broadcast
  // A ping/pong round trip ensures any preceding broadcast has been received.
  const pong = once(ws, 'pong')
  ws.ping()
  await pong
  assert.deepEqual(messages, [{ type: 'strike', ...incoming, meta: { source: 'smhi' } }])
  const historyResponse = await fetch(`${baseUrl}/api/strikes`)
  assert.equal((await historyResponse.json()).filter(s => s.lat === 61).length, 1)
})

test('an upstream error followed by close schedules exactly one reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sockets = []
  class FakeWebSocket extends EventEmitter {
    constructor(url) { super(); this.url = url; sockets.push(this) }
  }
  connectBlitzortung(FakeWebSocket)
  sockets[0].emit('error', new Error('connection refused'))
  sockets[0].emit('close')
  t.mock.timers.tick(2999)
  assert.equal(sockets.length, 1)
  t.mock.timers.tick(1)
  assert.equal(sockets.length, 2)
  assert.equal(sockets[1].url, 'wss://ws2.blitzortung.org/')
  sockets[1].emit('close')
  t.mock.timers.tick(3000)
  assert.equal(sockets.length, 3)
  assert.equal(sockets[2].url, 'wss://ws7.blitzortung.org/')
})
