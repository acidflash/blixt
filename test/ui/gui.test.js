import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright-core'

let browser, server, baseUrl, screenshots
const tile = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const windHeader = { parameterUnit: 'm.s-1', parameterCategory: 2, dx: 10, dy: 10, la1: 70, la2: 50, lo1: 10, lo2: 30, nx: 3, ny: 3, refTime: new Date().toISOString() }
const wind = [2, 3].map(parameterNumber => ({ header: { ...windHeader, parameterNumber }, data: Array(9).fill(2) }))

before(async () => {
  screenshots = await mkdtemp(join(tmpdir(), 'blixt-ui-'))
  const root = resolve('dist')
  server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]))
      if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return }
      const data = await readFile(path)
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' })[extname(path)] || 'application/octet-stream')
      res.end(data)
    } catch { res.writeHead(404).end() }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || '/snap/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(r => server.close(r))
  console.log('GUI screenshots:', screenshots)
})

async function openPage(t, viewport = { width: 390, height: 844 }, options = {}) {
  const page = await browser.newPage({ viewport, serviceWorkers: 'block', reducedMotion: options.reduced ? 'reduce' : 'no-preference', hasTouch: viewport.width <= 900 })
  if (options.clock) await page.clock.install()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], 'No uncaught browser errors') })
  await page.addInitScript(({ denied, noStorage, missingGeo }) => {
    if (noStorage) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked') } })
    let watches = 0
    window.__positionDenied = denied
    Object.defineProperty(navigator, 'geolocation', { value: missingGeo ? undefined : {
      watchPosition(success, error) {
        window.__positionRequests = ++watches
        setTimeout(() => window.__positionDenied ? error({ code: 1 }) : success({ coords: { latitude: 62, longitude: 15, accuracy: 10 } }), 10)
        return watches
      }, clearWatch() {},
    } })
    window.__sockets = []
    window.WebSocket = class {
      constructor() {
        window.__sockets.push(this)
        setTimeout(() => {
          this.onopen?.()
          this.onmessage?.({ data: JSON.stringify({ type: 'history', strikes: [] }) })
        }, 20)
      }
      close() {} send() {}
    }
  }, options)
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (route.request().resourceType() === 'image' && !url.startsWith(baseUrl)) {
      if (options.tileFailure) return route.fulfill({ status: 503, body: '' })
      return route.fulfill({ contentType: 'image/gif', body: tile })
    }
    if (url.includes('/api/') || url.includes('weather-maps.json')) {
      if (options.failure) return route.fulfill({ status: 503, json: {} })
      if (url.endsWith('/api/wind')) return route.fulfill({ json: { data: options.empty ? null : wind } })
      if (url.endsWith('/api/brandrisk')) return route.fulfill({ json: { points: options.empty ? [] : [{ lat: 64, lon: 17, fwiindex: 4, validTime: new Date().toISOString() }] } })
      if (url.endsWith('/api/fires')) return route.fulfill({ json: options.empty ? [] : [{ lat: 64, lon: 17, frp: 12, confidence: 'h', acqDate: '2026-09-07', acqTime: '1200', satellite: 'N' }] })
      if (url.endsWith('weather-maps.json')) return route.fulfill({ json: { host: 'https://radar.test', radar: { past: options.empty ? [] : [{ path: '/frame' }] } } })
      if (url.includes('opendata-download-lightning')) return route.fulfill({ json: { values: [] } })
      return route.fulfill({ json: [] })
    }
    if (!url.startsWith(baseUrl)) return route.fulfill({ json: {} })
    return route.continue()
  })
  await page.goto(baseUrl)
  await page.locator('#locate-button').waitFor()
  await page.waitForFunction(() => document.querySelector('#locate-button').getAttribute('aria-busy') !== 'true')
  await page.waitForFunction(() => document.querySelector('#wind-toggle').getAttribute('aria-busy') === 'false')
  return page
}

async function verifyLayout(page) {
  const issues = await page.evaluate(() => {
    const visible = e => !!(e.getClientRects().length && e.getBoundingClientRect().height)
    const ids = ['status', 'legend', 'map-controls', 'mobile-controls', 'location-status', 'map-error']
    const boxes = ids.map(id => document.getElementById(id)).filter(visible).map(e => ({ id: e.id, rect: e.getBoundingClientRect() }))
    const issues = []
    for (let i = 0; i < boxes.length; i++) {
      const { id, rect: a } = boxes[i]
      if (a.left < -1 || a.top < -1 || a.right > innerWidth + 1 || a.bottom > innerHeight + 1) issues.push(`${id} outside viewport`)
      for (let j = i + 1; j < boxes.length; j++) {
        const { id: other, rect: b } = boxes[j]
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) issues.push(`${id} overlaps ${other}`)
      }
    }
    for (const e of document.querySelectorAll('button, .layer-option, .leaflet-control-zoom a')) {
      if (!visible(e)) continue
      const r = e.getBoundingClientRect()
      if (r.width < 44 || r.height < 44) issues.push(`${e.id || e.className} touch target ${r.width}x${r.height}`)
    }
    if (document.documentElement.scrollWidth > innerWidth) issues.push('Horizontal page overflow')
    for (const id of ['map-controls', 'legend']) {
      const e = document.getElementById(id)
      if (visible(e) && e.scrollWidth > e.clientWidth + 1) issues.push(`${id} horizontal overflow`)
    }
    return issues
  })
  assert.deepEqual(issues, [])
}

for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [844, 390], [1024, 768], [1440, 900]]) {
  test(`controls and legends fit ${width}×${height}`, async t => {
    const page = await openPage(t, { width, height })
    await verifyLayout(page)
    const compact = width <= 900 || height <= 500
    if (compact) await page.locator('#layers-toggle').click()
    await page.locator('#brandrisk-toggle').click()
    await page.locator('input[value=satellite]').check()
    assert.equal(await page.locator('#brandrisk-toggle').getAttribute('aria-pressed'), 'true')
    await verifyLayout(page)
    assert.ok(await page.locator('#map-error').isHidden())
    await page.screenshot({ path: join(screenshots, `${width}-layers.png`) })
    if (compact) await page.locator('#legend-toggle').click()
    await verifyLayout(page)
    assert.ok(await page.locator('#brandrisk-legend').isVisible())
    assert.ok((await page.locator('#legend-bar-blitz').boundingBox()).height >= 100)
    assert.ok((await page.locator('#legend-bar-smhi').boundingBox()).height >= 100)
    if (compact) assert.ok((await page.locator('#legend').boundingBox()).height <= height * 0.45 + 1)
    await page.screenshot({ path: join(screenshots, `${width}-legend.png`) })
  })
}

test('panels support keyboard, outside clicks and rotation without losing state or position', async t => {
  const page = await openPage(t)
  await page.locator('#layers-toggle').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#layers-toggle').getAttribute('aria-expanded'), 'true')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.name), 'basemap')
  await page.keyboard.press('ArrowRight')
  assert.ok(await page.locator('input[value=light]').isChecked())
  await page.locator('#fires-toggle').click()
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'layers-toggle')
  assert.equal(await page.locator('#layers-toggle').getAttribute('aria-expanded'), 'false')
  await page.locator('#legend-toggle').click()
  await page.locator('#map').click({ position: { x: 200, y: 250 } })
  assert.equal(await page.locator('#legend-toggle').getAttribute('aria-expanded'), 'false')
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForFunction(() => document.querySelector('#map').clientWidth === 1024)
  await verifyLayout(page)
  assert.ok(await page.locator('input[value=light]').isChecked())
  assert.equal(await page.locator('#fires-toggle').getAttribute('aria-pressed'), 'true')
  await page.waitForFunction(() => {
    const r = document.querySelector('.user-pulse').getBoundingClientRect()
    return Math.abs(r.x + r.width / 2 - innerWidth / 2) < 3 && Math.abs(r.y + r.height / 2 - innerHeight / 2) < 3
  })
})

test('position denial can be retried, storage failure and missing geolocation do not prevent startup', async t => {
  const page = await openPage(t, undefined, { denied: true, noStorage: true })
  assert.match(await page.locator('#location-status').textContent(), /Position nekad/)
  await page.evaluate(() => { window.__positionDenied = false })
  await page.locator('#locate-button').click()
  await page.waitForFunction(() => document.querySelector('#location-status').hidden)
  assert.equal(await page.evaluate(() => window.__positionRequests), 2)
  await page.locator('#layers-toggle').click()
  await page.locator('input[value=osm]').check()
  assert.ok(await page.locator('input[value=osm]').isChecked())
  const missing = await openPage(t, undefined, { missingGeo: true })
  assert.match(await missing.locator('#location-status').textContent(), /stöder inte position/)
})

test('empty and failed layers are distinct from enabled layers; history is not labelled live', async t => {
  for (const [options, expected] of [[{ empty: true }, 'Inga data'], [{ failure: true }, 'Kunde inte hämta']]) {
    const page = await openPage(t, undefined, options)
    await page.locator('#layers-toggle').click()
    for (const id of ['wind', 'radar', 'fires', 'brandrisk']) assert.ok((await page.locator(`#${id}-state`).textContent()).includes(expected))
    assert.equal(await page.locator('#radar-toggle').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('#fires-toggle').getAttribute('aria-pressed'), 'false')
    assert.doesNotMatch(await page.locator('#status').textContent(), /Live/)
  }
})

test('failed basemap tiles provide a visible recovery hint', async t => {
  const page = await openPage(t, undefined, { tileFailure: true })
  await page.locator('#map-error').waitFor({ state: 'visible' })
  assert.match(await page.locator('#map-error').textContent(), /Välj en annan karta/)
})

test('reduced motion disables initial wind and pulses but allows explicit wind selection', async t => {
  const page = await openPage(t, undefined, { reduced: true })
  await page.locator('#layers-toggle').click()
  assert.equal(await page.locator('#wind-toggle').getAttribute('aria-pressed'), 'false')
  assert.ok(await page.locator('#motion-note').isVisible())
  assert.equal(await page.locator('.user-pulse').evaluate(e => getComputedStyle(e, '::after').animationName), 'none')
  await page.locator('#wind-toggle').click()
  assert.equal(await page.locator('#wind-toggle').getAttribute('aria-pressed'), 'true')
})

test('200 percent text scaling preserves operable panels', async t => {
  const page = await openPage(t, { width: 512, height: 384 })
  await page.addStyleTag({ content: 'html { font-size: 200%; }' })
  await page.locator('#layers-toggle').click()
  await verifyLayout(page)
  await page.locator('#brandrisk-toggle').click()
  await page.locator('#legend-toggle').click()
  await verifyLayout(page)
})

for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1024, 768]]) {
test(`edge strike popup fits ${width}×${height}`, async t => {
  const page = await openPage(t, { width, height })
  const position = { x: width - 20, y: Math.round(height / 2) + 18 }
  await page.evaluate(({ x, y }) => {
    const scale = 256 * 2 ** 8
    const centerX = (15 + 180) / 360 * scale
    const sin = Math.sin(62 * Math.PI / 180)
    const centerY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
    const lon = (centerX + x - innerWidth / 2) / scale * 360 - 180
    const n = Math.PI - 2 * Math.PI * (centerY + y - innerHeight / 2) / scale
    const lat = 180 / Math.PI * Math.atan(Math.sinh(n))
    window.__sockets[0].onmessage({ data: JSON.stringify({ type: 'strike', lat, lon, timeMs: Date.now(), meta: { source: 'smhi', peakCurrent: 12, cloudIndicator: 0 } }) })
  }, position)
  await page.locator('#map').click({ position })
  await page.locator('.leaflet-popup').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const p = document.querySelector('.leaflet-popup').getBoundingClientRect()
    const status = document.querySelector('#status').getBoundingClientRect()
    const controls = document.querySelector('#mobile-controls').getBoundingClientRect()
    const compact = matchMedia('(max-width: 900px), (max-height: 500px)').matches
    const right = compact ? 12 : document.querySelector('#map-controls').offsetWidth + 24
    return p.left >= 71 && p.right <= innerWidth - right + 1 && p.top >= status.bottom && p.bottom <= (compact ? controls.top : innerHeight - 20)
  })
  const close = page.locator('.leaflet-popup-close-button')
  const bounds = await close.boundingBox()
  assert.ok(bounds.width >= 44 && bounds.height >= 44)
  assert.equal(await close.getAttribute('aria-label'), 'Stäng information')
  await page.screenshot({ path: join(screenshots, `${width}-popup.png`) })
  await close.click()
  await page.locator('.leaflet-popup').waitFor({ state: 'detached' })
})
}

test('failed refresh keeps previously loaded wind visible and reports stale data', async t => {
  const page = await openPage(t, undefined, { clock: true })
  await page.route('**/api/wind', route => route.fulfill({ status: 503, json: {} }))
  await page.clock.fastForward(10 * 60 * 1000)
  await page.waitForFunction(() => document.querySelector('#wind-state').textContent === 'Äldre data visas')
  assert.equal(await page.locator('#wind-toggle').getAttribute('aria-pressed'), 'true')
  assert.ok(await page.locator('canvas.velocity-overlay').count() > 0)
})
