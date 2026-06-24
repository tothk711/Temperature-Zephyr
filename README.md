# 🌡️ Temperature Zephyr

A weather temperature comparison dashboard for Central European cities, built to support
energy / power‑trading decisions. It pulls hourly temperatures and short‑range forecasts
from [Open‑Meteo](https://open-meteo.com/), caches them in PostgreSQL, and renders them as
interactive charts, a data table, and 5‑day "what's coming" overviews for Czechia and
Hungary (with a focus on solar / FVE output potential).

The app intentionally **never invents data**: anything Open‑Meteo does not return is left
blank, and downloaded data is cross‑checked against an independent reanalysis archive.

---

## Features

- **Side‑by‑side temperature charts** — Czech cities (incl. a Czechia average) on the left,
  other cities (Budapest, Debrecen, Berlin, Munich) on the right.
- **Seven series per city** — past 3–7 day average, 2 days ago, yesterday, today,
  *today as forecast yesterday*, tomorrow, and the day after.
- **Clickable legends** — click (or keyboard Enter/Space on) any legend item to hide/show
  that line. Each chart toggles independently and remembers your choices when you switch
  cities.
- **Data table** — the same series shown numerically every 4 hours.
- **CZ future / HU future overviews** — a 5‑day table per country (Prague = CZ proxy,
  Budapest = HU proxy) with temperatures, pressure, wind, sky condition, cloud cover,
  solar (FVE) potential and auto‑generated notes. Column headers show **label / date /
  weekday name** (e.g. `Today / 2026-06-25 / Thursday`). Day‑over‑day changes are colour‑coded
  for solar output.
- **Built‑in data verification** — each city shows a badge summarising automated sanity
  checks, including a cross‑check against Open‑Meteo's ERA5 reanalysis archive.
- **Automatic refresh** — data is re‑fetched on startup and every 6 hours; a manual
  "Refresh All Data" button is also available.

---

## Tech stack

| Layer       | Technology |
|-------------|------------|
| Runtime     | Node.js (≥ 20; tested on 22) |
| Server      | Express 4 |
| Database    | PostgreSQL (via `pg`) |
| Scheduling  | `node-cron` |
| Front‑end   | Single static `public/index.html` + [Chart.js](https://www.chartjs.org/) 4.5.1 and `chartjs-plugin-annotation` 3.1.0 (pinned via CDN) |
| Data source | [Open‑Meteo](https://open-meteo.com/) forecast, previous‑runs, archive (ERA5) and geocoding APIs |

---

## Architecture

```
Temperature-Zephyr-main/
├── server.js            # Express server, Open-Meteo fetching, caching, verification, prep
├── public/
│   └── index.html       # Entire front-end (HTML + CSS + JS in one file)
├── package.json
├── package-lock.json
└── README.md
```

**Data flow:** `server.js` fetches each city from Open‑Meteo, stores the parsed result as a
JSONB blob in a `weather_cache` table, and serves it via a small JSON API. The front‑end
calls that API, computes the Czechia average client‑side, and draws the charts/tables. All
day‑boundary math is done in **`Europe/Prague`** so labels stay correct around midnight.

The "pure" helper functions in `server.js` (`getDateString`, `haversineKm`, `runDataChecks`,
`parsePreparation`, `buildNotes`, `classify*`, `describeWeather`) are exported so they can be
unit‑tested without a database or network connection.

---

## Cities

| City      | Latitude | Longitude | Group |
|-----------|----------|-----------|-------|
| Prague    | 50.08    | 14.42     | CZ |
| Brno      | 49.19    | 16.61     | CZ |
| Plzeň     | 49.75    | 13.38     | CZ |
| Ostrava   | 49.83    | 18.29     | CZ |
| Berlin    | 52.52    | 13.40     | Other |
| Munich    | 48.14    | 11.58     | Other |
| Budapest  | 47.50    | 19.04     | Other |
| Debrecen  | 47.53    | 21.63     | Other |

To add or change a city, edit the `cities` array in `server.js` (and the city groups near
the top of the `<script>` block in `public/index.html`).

---

## Data sources (Open‑Meteo)

All temperatures use the hourly `temperature_2m` field. Example URLs for **Budapest**
(`47.5, 19.04`) — handy for manually verifying what the app shows:

**Main forecast** (charts & table — 8 past days + 3 forecast days):
```
https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&hourly=temperature_2m&past_days=8&forecast_days=3&timezone=Europe%2FPrague
```

**Previous‑runs** ("Today Forecast" line — what yesterday's run predicted for today):
```
https://previous-runs-api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&hourly=temperature_2m_previous_day1&forecast_days=3&timezone=Europe%2FPrague
```

**CZ / HU future overview** (note the local `Europe/Budapest` timezone and extra fields):
```
https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&hourly=temperature_2m,cloud_cover,pressure_msl,wind_gusts_10m,shortwave_radiation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,precipitation_sum,wind_gusts_10m_max,sunshine_duration&forecast_days=5&timezone=Europe%2FBudapest&wind_speed_unit=kmh
```

**ERA5 archive** (independent cross‑check used by data verification):
```
https://archive-api.open-meteo.com/v1/archive?latitude=47.5&longitude=19.04&start_date=2026-06-17&end_date=2026-06-19&hourly=temperature_2m&timezone=Europe%2FPrague
```

**Geocoding** (confirms configured coordinates resolve to the right city):
```
https://geocoding-api.open-meteo.com/v1/search?name=Budapest&count=1&language=en&format=json
```

> The main charts request Budapest with `timezone=Europe/Prague`. Because Prague and
> Budapest share the same CET/CEST offset, the hourly values line up exactly — the timezone
> parameter does not shift the data.

---

## Data verification

For each city the app runs five automated checks (cached for 6 hours) and surfaces the
result as a badge. Thresholds live in the `VERIFY` object in `server.js`:

| Check | Passes when |
|-------|-------------|
| Coordinates match city | Configured point is within **30 km** of the geocoded city |
| Temperatures in plausible range | Every value between **−45 °C and 48 °C** |
| Recent days complete | ≤ **4** missing hours across yesterday + today |
| No impossible hourly jumps | Largest hour‑to‑hour change ≤ **12 °C** |
| Matches ERA5 reference archive | Avg diff ≤ **3 °C** and worst hour ≤ **6 °C** vs ERA5 |

---

## API

| Method | Route | Description |
|--------|-------|-------------|
| `GET`  | `/api/cities` | List of configured city names |
| `GET`  | `/api/weather/:city` | Cached weather for a city (auto‑refreshes if > 1 h old) |
| `POST` | `/api/fetch` | Force a fresh fetch for **all** cities |
| `GET`  | `/api/status` | Cache status (per‑city `updated_at`) |
| `GET`  | `/api/verify/:city` | Run/return the data‑verification checks |
| `GET`  | `/api/preparation/:city` | 5‑day "future" overview for a capital |

---

## Getting started

### Prerequisites
- Node.js ≥ 20
- A PostgreSQL database (any provider; SSL is enabled automatically when `DATABASE_URL` is set)

### Install
```bash
npm install
```

### Configure
Set the following environment variables (e.g. in a `.env` or your host's config):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes (for caching) | — | PostgreSQL connection string |
| `PORT` | No | `3000` | HTTP port |

### Run
```bash
npm start
```
Then open <http://localhost:3000>. On first start the app creates the `weather_cache` table,
fetches all cities, and schedules a refresh every 6 hours.

---

## Configuration reference

| What | Where (`server.js`) |
|------|---------------------|
| Cities & coordinates | `cities` array |
| App timezone (day math, main forecast) | `APP_TIMEZONE` (`Europe/Prague`) |
| Per‑country preparation timezone | `PREP_TZ` (`Prague` → `Europe/Prague`, `Budapest` → `Europe/Budapest`) |
| Verification thresholds | `VERIFY` |
| Refresh schedule | `cron.schedule('0 */6 * * *', …)` |
| Cache freshness (API) | 1 hour (in `/api/weather/:city`) |

---

## Changelog

### June 2026 — maintenance & feature pass
- **Pinned the Chart.js CDN versions** (`chart.js@4.5.1`, `chartjs-plugin-annotation@3.1.0`).
  They were previously loaded unversioned ("always latest"), which risked an upstream major
  release silently breaking the charts.
- **Clickable legends** — legend items under each graph now toggle their line on/off, with
  independent left/right state that persists across city changes.
- **CZ / HU future headers** now show a third line, the **weekday name** (label / date / day).
- **Fixed a client‑side timezone bug** — the header date was derived from UTC + browser‑local
  time and could show the wrong day around midnight; it now uses `Europe/Prague`, matching the
  server.
- **Hardened `analyzeTemps`** against empty / all‑null data (no more `Infinity` bounds).
- **Dependencies** — raised floors to a current security baseline (`express ^4.21.2`,
  `pg ^8.22.0`), kept `node-cron` on 3.x, and widened the Node engines range to `>=20`
  (the deploy environment runs Node 22). `package-lock.json` re‑synced.

---

## License

No license file is currently included in this repository. Add one before distributing
publicly if you intend to open‑source the project.
