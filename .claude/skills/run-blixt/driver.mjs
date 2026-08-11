#!/usr/bin/env node
// Headless-browser driver for blixt, using the system Chromium (installed
// via `sudo snap install chromium`) through playwright-core.
//
// Why not plain Playwright / chromium-cli: Playwright's own browser
// downloader refuses to install on this Ubuntu release ("Playwright does
// not support chromium on ubuntu26.04-x64"), and this environment has no
// chromium-cli. playwright-core skips the download and drives whatever
// Chromium binary you point it at.
//
// Usage:
//   node driver.mjs [url] [screenshot-path]
//
// Defaults: url = http://localhost/, screenshot = ./screenshot.png
// (relative to cwd when you run it).
//
// Exits non-zero if the page fails to load or the console logs any error.

import { chromium } from 'playwright-core'
import path from 'path'

const CHROMIUM_PATH = '/snap/bin/chromium'

const url = process.argv[2] || 'http://localhost/'
const screenshotPath = process.argv[3] || path.resolve('screenshot.png')

const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

const consoleErrors = []
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message))

let ok = true
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  // blixt's map div — presence means Leaflet mounted.
  await page.waitForSelector('#map', { timeout: 15000 })
  await page.waitForTimeout(2000) // let tiles/markers/legend settle
  await page.screenshot({ path: screenshotPath })
} catch (e) {
  ok = false
  console.error('Navigation/render failed:', e.message)
}

console.log('URL:', url)
console.log('Title:', await page.title().catch(() => '(unknown)'))
console.log('Console errors:', consoleErrors.length ? consoleErrors : 'none')
console.log('Screenshot:', screenshotPath)

await browser.close()

if (!ok || consoleErrors.length) process.exit(1)
