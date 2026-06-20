# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (hot reload, port 5173)
npm install
npm run dev

# Production via Docker Compose (port 80)
docker compose up --build

# Build only
npm run build
```

## Architecture

Single-page Vite + vanilla JS app with no framework. All client logic lives in `src/main.js`. A small Express server (`server.js`) serves the built static files and persists strike history server-side.

### Data sources

**Blitzortung** (real-time, global)
- WebSocket: `wss://ws[1,2,7,8].blitzortung.org/` — subscription message `{"a":111}`
- Incoming frames are **LZW-compressed JSON** — must be decoded with `lzwDecode()` before `JSON.parse()`
- Fields: `lat`, `lon`, `time` (nanoseconds since epoch), optional `latc`/`lonc` delta corrections
- Each new strike is POSTed to `/api/strikes` for server-side persistence

**SMHI** (historical, Sweden only)
- REST API: `https://opendata-download-lightning.smhi.se/api/version/latest/year/YYYY/month/MM/day/DD/data.json`
- Daily batch files; fetched at startup for yesterday + today, then polled every 10 minutes
- Extra fields: `cloudIndicator` (0 = cloud-to-ground, 1 = cloud-to-cloud), `peakCurrent` (kA)
- Deduplicated via `smhiSeen` Set using `${timeMs}:${lat}:${lon}` keys
- Only shows data when there are actual strikes in Sweden within the last 3 hours

### Server (`server.js`)

Express app that runs in production (port 80):
- `GET /api/strikes` — returns all strikes from the last 3 hours (in-memory, cleaned up on each request)
- `POST /api/strikes` — adds a strike `{ lat, lon, timeMs, meta }`, deduplicates by exact match
- Persists to `/data/strikes.json` every 60 seconds and on `SIGTERM`
- `/data` is a Docker named volume (`strikes-data`) so history survives container restarts

### Strike lifecycle

- Strikes kept for **3 hours** (`MAX_AGE_MS`), removed server-side and client-side after
- `updateStrikes()` runs every 5 seconds: removes expired markers, updates color/opacity, updates nearest-strike distance
- Each strike has `{ lat, lon, timeMs, meta, marker }` — `meta.source` is `'smhi'` or absent (Blitzortung)

### Color schemes (source-coded)

**Blitzortung** (warm): `AGE_COLORS` — white → yellow → orange → red → dark red

**SMHI** (cool): `SMHI_AGE_COLORS` — cyan → blue → dark blue

`strikeStyle(ageMs, meta)` selects the palette based on `meta.source`. Both `addStrike` and `updateStrikes` pass `meta` through.

### Legend

Top-right panel shows two side-by-side gradient bars (⚡ Blitzortung + SMHI) with shared time labels (Nu / 1 tim / 2 tim / 3 tim).

### Startup load order

1. `loadFromStorage()` — instant render from `localStorage` (local cache)
2. `loadFromApi()` — `GET /api/strikes`, adds any strikes not already in localStorage; makes history work across all browsers/PWA contexts
3. `loadSmhiData()` — fetches SMHI daily files for yesterday + today

### Persistence layers

- **Server** (`/data/strikes.json`): authoritative, shared across all clients; survives PWA/browser isolation
- **localStorage** (`blixt_strikes`): fast local cache; debounced save 3s after last strike + `beforeunload`

### PWA

- `vite-plugin-pwa` generates `dist/sw.js` (Workbox service worker) and `dist/manifest.webmanifest`
- Icons: `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png` (generated from `public/icon.svg` via `sharp`)
- Map tiles (CartoDB) are cached by the service worker (`CacheFirst`, 24h, 1000 entries)
- `apple-mobile-web-app-capable` + `black-translucent` status bar for iOS fullscreen

### Rain radar

- **RainViewer** (free, no API key): `https://api.rainviewer.com/public/weather-maps.json` returns available radar frames
- Latest frame added as a semi-transparent Leaflet tile layer (`opacity: 0.5`, color scheme 6 = classic meteorological)
- Tile URL: `{host}{path}/256/{z}/{x}/{y}/6/1_1.png`
- **RainViewer's hash-based path format (`/v2/radar/{hash}`) only has tiles at zoom 3–7.** Zoom 8+ returns a 1370-byte "Zoom level not supported" error image (200 OK, not an HTTP error, so `tileerror` cannot catch it). Fix: `minNativeZoom: 3, maxNativeZoom: 7` — Leaflet upscales zoom-7 tiles when zoomed in further.
- Refreshed every 5 minutes via `updateRadar()`

### Wind

- **leaflet-velocity** + **Open-Meteo** (both free, no API key)
- Fetches current wind speed + direction for a 7×13 grid (4° step, 72–48°N, -8–40°E = 91 points) in one Open-Meteo request
- Converts meteorological wind direction to U/V components: `U = -speed * sin(dir)`, `V = -speed * cos(dir)`
- Builds leaflet-velocity data structure (two arrays: `eastward_wind` + `northward_wind`) and adds animated particle layer
- Refreshed every 10 minutes via `updateWind()`
- `leaflet-velocity` attaches to the global `L` via its UMD bundle — imported as a static side-effect (`import 'leaflet-velocity'`) after Leaflet; Vite deduplicates the leaflet module so `L.velocityLayer` lands on our instance
- **Do not use top-level `await import('leaflet-velocity')`** — the PWA build target (ES2020) does not support top-level await

### Map control buttons

- Both "💨 Vind" and "🌧 Radar" live in `#map-controls` (flex row, bottom-right)
- Shared class `.map-ctrl-btn`; `.active` = blue highlight
- Both default to active/visible on load

### Other features

- New live strikes trigger a CSS ripple animation (`.strike-ring`) — temporary `L.divIcon` that auto-removes after 1.4s
- Clicking a strike shows a popup: "Blixtnedslag {date} {time}", distance from user (if geolocation active), lat/lon, Toppström + Typ (SMHI only), Källa (yellow for Blitzortung, blue for SMHI). `strikePopup(timeMs, meta, lat, lon)` — lat/lon needed for live distance calculation.
- User position: `watchPosition` → pulsing `.user-pulse` marker; coordinates + accuracy + nearest-strike distance shown bottom-left (Haversine), updated every 5s
- Status bar bottom-center: strike count + Blitzortung connection state + SMHI state + server state

### Key files

- `src/main.js` — all client logic
- `src/style.css` — dark theme, ripple, dual-bar legend, popup, location display
- `index.html` — map, status bar, location div, legend (two source bars)
- `server.js` — Express server (static files + API)
- `vite.config.js` — Vite + VitePWA config
- `public/` — PWA icons and SVG source

**Docker:** Multi-stage build — Node builds with Vite (`npm run build`), then a clean Node image runs `server.js`. Named volume `strikes-data` at `/data`.
