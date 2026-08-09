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
- Persists to `/data/strikes.json` every 60 seconds and on `SIGTERM` (path override via `DATA_FILE` env for non-Docker dev)
- `/data` is a Docker named volume (`strikes-data`) so history survives container restarts

### Access log + besöksstatistik

- Middleware (registered before `express.json`/`express.static`) logs every request to `/data/access.log` (`ACCESS_LOG_FILE` env override): `ISO-timestamp ip method path status`, one line per request, append-only (no rotation).
- "Besökare" = unikt IP (från `X-Forwarded-For` om satt, annars `req.ip`) som hämtar `/` eller `/index.html` — inte varje asset/API-anrop. Räknas per UTC-dag i `visitorsToday` (in-memory `Set`).
- `GET /api/stats` → `{ date, visitorsToday, history: { 'YYYY-MM-DD': count } }`.
- Persisteras till `/data/visitors.json` (`VISITORS_FILE` env override) var 60:e sekund och på `SIGTERM`, samma mönster som strikes. **Känd begränsning:** bara dagens *antal* persisteras, inte IP-listan — en omstart mitt på dagen nollställer `visitorsToday` till 0 och tappar dedupering mot besökare från innan omstarten (historiken för tidigare dagar påverkas inte).

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

### Wind (Open-Meteo via serverproxy)

- **leaflet-velocity** + **Open-Meteo** (both free, no API key)
- **server.js** hämtar vinddata (nuvarande hastighet + riktning) för en **global grid** (6° steg, 90–-90°N, -180–180°E = 1891 punkter) och cachear resultatet; klienten hämtar bara `GET /api/wind`.
- **Varför serverproxy + nedskalad grid:** Open-Meteos gratistier har tre travande gränser — ~600 anrop/minut, 5 000/timme, och (den som faktiskt styr här) bara **10 000/dygn**, där varje efterfrågad koordinat räknas som ett anrop. Ursprungsimplementationen hämtade en global 4°-grid (4186 punkter) client-side i 9 parallella 500-punkters-anrop **per besökare**, var 10:e minut — det small i minutgränsen direkt (HTTP 429 "Minutely API request limit exceeded"), och även om man löser burst-problemet hade 4°/10 min krävt ~600 000 anrop/dygn, 60x över dygnsbudgeten. Nu hämtar servern i stället gridden **en gång åt alla klienter**, nedskalad till 6° (1891 punkter), var 6:e timme (≈7 564 anrop/dygn, ~76 % av budgeten). Inom varje körning hämtas punkterna sekventiellt i chunkar (`WIND_CHUNK` = 200 punkter) med paus (`WIND_CHUNK_DELAY_MS` = 3s) mellan varje, så minut-/timgränsen inte heller triggas. Vid fel behålls föregående cachade data (samma mönster som brandrisk).
- Konverterar meteorologisk vindriktning till U/V-komponenter server-side: `U = -speed * sin(dir)`, `V = -speed * cos(dir)`
- Servern bygger leaflet-velocity-datastrukturen (två headers + arrays: `eastward_wind` + `northward_wind`) och exponerar den direkt via `GET /api/wind` → `{ updated, data }`; klienten skickar `data` oförändrad till `L.velocityLayer`.
- Uppdateras var 6:e timme server-side, men självschemalagt (`scheduleWind` → rekursiv `setTimeout`, inte `setInterval`): vid misslyckad hämtning (t.ex. kvoten inte återställd) körs nästa försök redan efter 15 min (`WIND_RETRY_MS`) i stället för att vänta hela 6-timmarscykeln — annars kan en enda misslyckad körning lämna vindlagret tomt i timmar. Klienten pollar `/api/wind` var 10:e minut via `updateWind()` (billigt — träffar bara den egna servern, inte Open-Meteo).
- `leaflet-velocity` attaches to the global `L` via its UMD bundle — imported as a static side-effect (`import 'leaflet-velocity'`) after Leaflet; Vite deduplicates the leaflet module so `L.velocityLayer` lands on our instance
- **Do not use top-level `await import('leaflet-velocity')`** — the PWA build target (ES2020) does not support top-level await

### Brandrisk (SMHI fwif1g-prognos via serverproxy)

- **server.js** hämtar SMHI-brandriskprognosen som ett rutnät av punkter över Sverige (lat 55–69.5, lon 10–24.5, steg 0.8°) med 8 samtidiga förfrågningar.
- Endpoint: `https://opendata-download-metfcst.smhi.se/api/category/{category}/version/{version}/{period}/geotype/point/lon/{lon}/lat/{lat}/data.json` — kategori/version/period konfigurerbara via env (`BRANDRISK_CATEGORY` default `fwif1g`, `BRANDRISK_VERSION` default `1`, `BRANDRISK_PERIOD` default `hourly`). Verifierat mot https://opendata.smhi.se/metfcst/fwif/ (2026-08-02) — kräver `{period}` (`hourly`/`daily`) i sökvägen, saknas i SMHI:s äldre dokumenterade format.
- Enda relevanta parametern är `fwiindex`: SMHI:s officiella 1–6-klass (se `/metfcst/fwif/parameters`). `-1` = data saknas/utanför säsong, `9999` = fyllnadsvärde för gridpunkter utanför prognosområdet (~63 % av rutnätet, mest hav/fjäll) — filtreras bort server-side i `fetchBrandriskPoint`. Server cachear och exponerar `GET /api/brandrisk` → `{ updated, validTime, points: [{ lat, lon, validTime, fwiindex }] }`.
- **main.js** renderar två lager i `brandriskLayer`: ett dekorativt "molnigt" bakgrundslager (stora överlappande `L.circle`, egen `brandriskPane`/renderer, `pointer-events: none` + `interactive: false`, CSS `blur(9px)` på panen så grannpunkter tonas ihop likt regnradarn) och små klickbara `L.circleMarker`-prickar ovanpå på den delade standard-renderern (samma klick/popup-mekanik som blixtar/bränder). 6-stegs färgskala `BRANDRISK_COLORS`/`BRANDRISK_LABELS` matchar SMHI:s `fwiindex`-klasser.
- Knapp `⚠️ Brandrisk` i `#map-controls` + egen legend (`#brandrisk-legend`, 1–6) som visas/döljs med lagret. Avstängt som standard.
- Uppdateras var 30:e minut.

### Map control buttons

- "💨 Vind", "🌧 Radar", "🔥 Bränder" and "⚠️ Brandrisk" live in `#map-controls` (flex row, bottom-right)
- Shared class `.map-ctrl-btn`; `.active` = blue highlight
- Only "🌧 Radar" defaults to active/visible on load — Vind, Bränder and Brandrisk default off (each is either a heavier fetch — global grid for vind — or less central to the core lightning use case) and must be toggled on manually

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
