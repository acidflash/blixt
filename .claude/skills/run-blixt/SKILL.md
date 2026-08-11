---
name: run-blixt
description: Build, run, and visually verify blixt (the lightning-tracker map app). Use when asked to start blixt, run it via Docker, take a screenshot of the map, or confirm a change works in the live app.
---

blixt is a Vite + vanilla-JS SPA served by `server.js` (Express) via
Docker Compose on port 80. There's no `chromium-cli` in this
environment, so it's driven by `.claude/skills/run-blixt/driver.mjs` —
a small `playwright-core` script pointed at a system-installed
Chromium — instead.

All paths below are relative to the repo root.

## Prerequisites

Docker + Docker Compose (already available in this environment). For
the visual driver, a system Chromium binary — Playwright's own
browser download refuses on this Ubuntu release
("Playwright does not support chromium on ubuntu26.04-x64"):

```bash
sudo snap install chromium
```

Confirms with `which chromium` → `/snap/bin/chromium`.

## Setup

The driver has its own tiny `package.json` (kept separate from the
app's own deps — it's agent tooling, not app code):

```bash
cd .claude/skills/run-blixt && npm install && cd -
```

## Build & Run

```bash
docker compose up --build -d
```

Wait for it to actually serve, then confirm:

```bash
timeout 30 bash -c 'until curl -sf http://localhost/ > /dev/null; do sleep 1; done'
curl -s http://localhost/api/strikes | python3 -c "import json,sys; print(len(json.load(sys.stdin)), 'strikes')"
```

Logs: `docker compose logs app --since 5m`. Stop: `docker compose down`
(add `-v` only if you also want to wipe the `strikes-data` volume —
don't, unless that's actually the intent, it holds strike history).

## Run (agent path)

Once the container is up, drive it with `driver.mjs`:

```bash
node .claude/skills/run-blixt/driver.mjs http://localhost/ /tmp/blixt-screenshot.png
```

It navigates to the URL, waits for `#map` (Leaflet mounted), waits 2s
for tiles/markers/legend to settle, screenshots, and prints console
errors. **Exits non-zero if the page failed to load or the console
logged any error** — check the exit code, don't just eyeball the
text output. Then actually **look at the screenshot** — a blank or
all-grey frame means tiles didn't load even if there were no console
errors.

Expected healthy output:

```
URL: http://localhost/
Title: Blixt
Console errors: none
Screenshot: /tmp/blixt-screenshot.png
```

What a good screenshot looks like: dark basemap, strike dots (warm
white→red = Blitzortung, cool cyan→blue = SMHI), the dual-bar legend
top-right, radar cloud overlay (Radar is on by default), the
`<n> blixtar ⚡ Live` status pill bottom-center, and four map-control
buttons bottom-right (Karta/Vind/Radar/Bränder/Brandrisk) — only
**Radar** highlighted blue by default, the rest off.

To check a different route/API response instead of the map, just
`curl` it directly — e.g. `curl -s http://localhost/api/wind` for the
wind proxy, `curl -s http://localhost/api/stats` for visitor counts.
`driver.mjs` is only needed for the visual/DOM layer.

## Run (human path)

```bash
npm run dev   # Vite dev server, hot reload, http://localhost:5173
```

Or just open `http://localhost/` (port 80, via Docker) in a real
browser. Useless in a headless agent session — use the driver instead.

## Test

No automated test suite in this repo (`npm run build` is the closest
thing to a check — it must complete without errors before trusting a
change).

## Gotchas

- **Playwright's bundled-browser install fails outright** on this
  Ubuntu build (`ERROR: Playwright does not support chromium on
  ubuntu26.04-x64`) — even `npx playwright install chromium` without
  `--with-deps`. Don't retry it; use the snap Chromium + `playwright-core`
  + explicit `executablePath` instead (already wired up in `driver.mjs`).
- **A stale running container silently masks code changes.** If
  `docker compose ps` shows the container `Up` from before your edits,
  `docker compose up --build -d` still needs to run (recreates the
  container) — just editing files on disk does nothing to the live
  site until rebuilt. Bit us once: wind stayed on with old client-side
  behavior for 46h because the container predated the fix.
- **Open-Meteo wind data can legitimately be `null`** in `/api/wind`
  — it's a proxy with a 6h refresh + 15min retry-on-failure; a `null`
  `data` field isn't a driver/app bug, just means the upstream fetch
  hasn't succeeded yet (check `docker compose logs app | grep Wind`
  for the reason, usually a daily quota exhaustion that clears at UTC
  midnight).
- **Blitzortung WebSocket reconnects every ~6 minutes** by design —
  the upstream server cycles clients across `ws1/ws2/ws7/ws8`. A
  `[Blitzortung] frånkopplad, återansluter…` line in logs followed
  within ~3s by a new `ansluten` line is healthy, not an error.

## Troubleshooting

- **`Error: ERROR: Playwright does not support chromium on
  ubuntu26.04-x64`**: don't use Playwright's own browser install on
  this box. Use the snap Chromium (`sudo snap install chromium`) and
  `driver.mjs`, which already points `playwright-core` at
  `/snap/bin/chromium`.
- **`net::ERR_CONNECTION_REFUSED` from the driver**: the container
  isn't up yet (or `docker compose up --build -d` failed) — check
  `docker compose ps` and `docker compose logs app`.
- **`page.waitForSelector('#map')` times out**: usually a build
  failure baked into the image — check `docker compose logs app` for
  a startup error, or rerun `npm run build` locally to see the actual
  Vite/JS error before it's obscured by the Docker layer.
