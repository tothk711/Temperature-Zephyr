# 🌡️ Temperature Zephyr

A weather temperature comparison dashboard for Central European cities, built to support
energy / power‑trading decisions. It pulls hourly temperatures and short‑range forecasts
from [Open‑Meteo](https://open-meteo.com/), caches them in PostgreSQL, and renders them as
interactive charts, a data table, hour‑by‑hour history, and 6‑day "what's coming" overviews for Czechia and
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
- **🇨🇿 future / 🇭🇺 future overviews** — a 6‑day table per country (Prague = CZ proxy,
  Budapest = HU proxy) with temperatures at 8:00 / 12:00 / 16:00 / 20:00 / 0:00, pressure,
  wind, sky condition, cloud cover, solar (FVE) potential and auto‑generated notes. Column headers show **label / date /
  weekday name** (e.g. `Today / 2026-06-25 / Thursday`). Day‑over‑day changes are colour‑coded
  for solar output.
- **📖 History tab** — pick a city, an ISO week of this year (1 → current) and a source,
  and get the actual past temperatures for every hour that has already happened: 24 rows
  (hours) × 7 columns (Mon–Sun). Source is either **Openmeteo** (best_match) or the
  **Global median** — the per‑hour median of all implemented sources (ECMWF, DWD ICON,
  NOAA GFS, Météo‑France, MET Norway, Open‑Meteo); sources with no coverage for a city
  are skipped automatically and the footer lists what was actually used.
- **Built‑in data verification** — each city shows a badge summarising automated sanity
  checks, including a cross‑check against Open‑Meteo's ERA5 reanalysis archive.
- **LIVE tab** — a right‑now snapshot for Prague, Brno, Budapest and Debrecen across
  temperature, wind, rain/storms and pressure, each with its current value and a ▲/▼ vs the
  same hour yesterday. Hover a category to see what it means for the electric grid.
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
├── README.md
└── Temperature1.0/       # Frozen v1.0 baseline snapshot (pre-LIVE)
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
https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&hourly=temperature_2m,cloud_cover,pressure_msl,wind_gusts_10m,shortwave_radiation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,precipitation_sum,wind_gusts_10m_max,sunshine_duration&forecast_days=6&timezone=Europe%2FBudapest&wind_speed_unit=kmh
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

## Data stability (provisional history)

**Recent "past" days are provisional and can change between refreshes.** This is expected
behaviour of the data source + caching design, not a data error. Two effects combine:

1. **The forecast endpoint does not return final observations for past days.** Open‑Meteo's
   `/v1/forecast` (used for the charts) returns continuously re‑analysed *model* data for
   recent past days; newer model runs fold in more observations, so a past day's curve gets
   revised over time. Only the ERA5 `/v1/archive` endpoint is a stable record, and it lags
   **~5 days** — so "yesterday" and "2 days ago" are always provisional.
2. **The app overwrites its whole cache every cycle.** `fetchWeatherFromAPI` always requests
   `past_days=8`, and `cacheWeatherData` replaces the entire per‑city record
   (`ON CONFLICT … DO UPDATE SET data = …`). There is no per‑day freezing, so each 6‑hourly
   refresh replaces stored history with the model's latest hindcast.

Net effect: an already‑happened day can read a few degrees differently than it did when it
was "today", especially in volatile weather (heatwaves, storms). Note also that comparing a
**forecast** line for a date (e.g. "Tomorrow") against the **actual** for that same date later
is just normal forecast error, not revision.

The built‑in verification badge cross‑checks the three oldest historic days against the ERA5
archive. If they drift beyond the `VERIFY` thresholds the badge turns amber
("Check flagged issues") and its detail line quantifies the difference.

> **If immutable history is required** (not currently implemented): freeze each day's values
> once it is in the past (write‑once for past days, keep updating today + forecast), and/or
> source days older than ~5 days from the ERA5 archive endpoint instead of the forecast
> endpoint.

---

## Cross-check / confidence

A single weather model can occasionally produce an unrealistic value for one hour (e.g. a
sudden multi‑degree drop that is really a model artefact). To catch these, the app
cross‑checks the value it shows for **today** (Open‑Meteo `best_match`) against several
**independent** sources and flags — but never alters — hours that disagree:

- Other individual Open‑Meteo models: **ECMWF**, **DWD ICON**, **NOAA GFS**, **Météo‑France**
  (each fetched with `&models=<id>`, so the response is a plain `temperature_2m`).
- **MET Norway** (`api.met.no`) — a completely separate provider / agency.

For each hour, if the shown value differs from the **median of the other sources** by more
than `CROSSCHECK.DEVIATION_C` (default **4 °C**) it is flagged. A confidence badge next to
each graph summarises the result ("✓ Sources agree" / "⚠ N hr low‑confidence"), the detail
panel lists each flagged hour with the per‑source numbers, and the flagged hours are marked
with ⚠ triangles on the Today line. Genuine rapid changes that *all* sources agree on are
deliberately **not** flagged, so real fronts/storms are not false‑flagged.

Example independent‑source URLs for Budapest:

```
# One Open-Meteo model (repeat per model id in CROSSCHECK.MODELS)
https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&hourly=temperature_2m&models=ecmwf_ifs025&forecast_days=2&timezone=Europe%2FPrague

# MET Norway (requires a User-Agent header — see METNO_USER_AGENT)
https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=47.5&lon=19.04
```

> Cross‑check runs on individual cities; the Czechia average is skipped. The model list and
> threshold live in the `CROSSCHECK` object in `server.js`.

---

## LIVE tab

A "right now" snapshot for **Prague, Brno, Budapest and Debrecen** across four categories:

| Category | Current value | vs yesterday |
|----------|---------------|--------------|
| 🌡️ Temperature | °C | ▲ / ▼ / ▬ vs the same hour yesterday |
| 💨 Wind | km/h (+ gust) | ▲ / ▼ / ▬ |
| 🌧️ Rain / Storms | mm (+ sky condition, ⛈️ flag on storms) | ▲ / ▼ / ▬ |
| 🎚️ Pressure | hPa | ▲ / ▼ / ▬ |

Each value is Open‑Meteo's `current` reading; the arrow compares it to the matching hour 24 h
earlier (a small dead‑band keeps tiny wiggles as "flat"). **Hover any category header** for a
one‑line explanation of what that metric means for the electric grid (demand, wind/solar
generation, faults). The tab auto‑refreshes every 5 minutes while open. Served by
`/api/live/:city` (10‑minute cache).

---

## API

| Method | Route | Description |
|--------|-------|-------------|
| `GET`  | `/api/cities` | List of configured city names |
| `GET`  | `/api/weather/:city` | Cached weather for a city (auto‑refreshes if > 1 h old) |
| `POST` | `/api/fetch` | Force a fresh fetch for **all** cities |
| `GET`  | `/api/status` | Cache status (per‑city `updated_at`) |
| `GET`  | `/api/verify/:city` | Run/return the data‑verification checks |
| `GET`  | `/api/preparation/:city` | 6‑day "future" overview for a capital |
| `GET`  | `/api/crosscheck/:city` | Cross‑check today's shown values vs independent models + MET Norway |
| `GET`  | `/api/live/:city` | Right‑now snapshot + direction vs the same hour yesterday |
| `GET`  | `/api/market/:country` | Power‑market weather brief for `CZ` or `HU` (demand / solar / wind / risks) |
| `GET`  | `/api/history/:city?week=N&source=openmeteo\|median` | Hour‑by‑hour actual temperatures for ISO week `N` of this year |

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
| `METNO_USER_AGENT` | Recommended | generic | Identifies your app to MET Norway for the cross‑check. Put a real contact, e.g. `TemperatureZephyr/1.0 you@example.com` — MET Norway blocks missing/generic User‑Agents |

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
| Cross‑check models, threshold, User‑Agent | `CROSSCHECK` |
| LIVE cache TTL | `LIVE_CACHE_MS` (10 min) |

---

## Changelog

### v1.3.0 — July 2026 — History tab, 6‑day outlook, flag tabs
- **📖 History tab.** Pick a **city** (all eight), an **ISO week of this year** (1 → the
  current week) and a **source**, and see the actual temperature for every hour that has
  already happened in that week — 24 hourly rows × 7 day columns (Mon–Sun). Hours still in
  the future stay blank: this tab never shows forecast values. Sources: **Openmeteo**
  (best_match) or **Global median** — the per‑hour median of ECMWF, DWD ICON, NOAA GFS,
  Météo‑France, MET Norway and Open‑Meteo. Models are fetched one per call (same pattern
  as the cross‑check), so a source with no coverage (MET Norway's Nordic model does not
  reach CZ/HU) is skipped automatically and the footer lists what was actually used.
  Finished weeks come from Open‑Meteo's **Historical Forecast archive**; weeks touching
  the last ~3 days use the forecast endpoint's `past_days` so the newest hours are present.
  Served by `GET /api/history/:city?week=N&source=openmeteo|median` (in‑memory cache:
  6 h for finished weeks, 15 min for the current one).
- **Future tabs: one more day.** The CZ/HU outlook now covers **6 days** (Today → D+5).
- **Future tabs: 12:00 and 20:00 rows.** Temperature rows are now 8:00 / 12:00 / 16:00 /
  20:00 / 0:00, in chronological order.
- **Flag tabs.** "CZ future" / "HU future" are now **🇨🇿 future / 🇭🇺 future**. Windows has no
  native flag‑emoji glyphs (the tabs would show plain "CZ"/"HU" letters), so the page loads
  a tiny Twemoji **country‑flags subset font** from the same pinned jsDelivr CDN as
  Chart.js, restricted via `unicode-range` to flag codepoints only. If the CDN is
  unreachable the tabs degrade to the letters CZ / HU.
- **Tests restored.** `npm test` (offline unit tests in `tests/`) covers the new ISO‑week /
  median / table‑assembly helpers and the 6‑day parser. `tests/mock-fetch.js` lets you boot
  the whole app against a synthetic Open‑Meteo for smoke tests:
  `node --require ./tests/mock-fetch.js server.js`.

### v1.2.0 — July 2026 — consensus correction, Market brief, hardening
- **Consensus correction (cross‑check upgrade).** The cross‑check no longer only flags bad
  hours — when the primary (best_match) value is > 4 °C away from the median of the other
  sources *and* at least 3 of those sources agree within 2 °C of each other, the displayed
  Today value is replaced by their median (cyan ◆ marker; the raw model value stays in the
  tooltip and in the API's `primary` field). When the other sources disagree among
  themselves, the hour is only flagged (amber ▲), never replaced. Missing primary hours are
  gap‑filled from a tight consensus. Config: `CROSSCHECK.CONSENSUS_SPREAD_C`,
  `CROSSCHECK.CONSENSUS_MIN_SOURCES`. Cached/stored data is never modified.
- **📈 Market tab.** New per‑country (CZ / HU) power‑fundamentals brief for Yesterday
  (context) / Today / Tomorrow / D+2: population‑weighted demand temperature with HDD/CDD,
  a 0–100 % solar index (daily radiation vs clear‑sky monthly max), a 0–100 % wind index
  (120 m hub‑height wind through a simplified turbine power curve), grid‑risk flags
  (storms, cut‑out gusts, morning fog, snow, heat, frost, heavy rain) and a plain‑language
  day‑over‑day signal incl. residual‑load direction. New `/api/market/:country` route.
  Fundamentals only — explicitly not price advice.
- **Startup resilience.** The server now starts even when Postgres is missing or down —
  it warns and degrades to an in‑memory cache (previously it silently never listened).
  A pool error handler prevents crashes on DB restarts.
- **Front‑end data hygiene.** HTTP errors / error payloads are no longer cached as if they
  were weather data (previously a single 500 could break charts until a manual refresh);
  the Czechia average now skips invalid cities instead of crashing.
- **LIVE pressure fix.** The yesterday‑delta is only computed when both values are MSL
  pressure; the surface‑pressure fallback (~30–45 hPa lower at these altitudes) no longer
  produces a bogus ▼ comparison.
- **Test suite.** `npm test` (`node --test tests/`) with 27 offline unit tests covering the
  cross‑check consensus logic, market brief, LIVE parsing, verification and helpers.


### v1.1.0 — July 2026 — LIVE tab
- **LIVE tab.** New right‑now dashboard for Prague, Brno, Budapest and Debrecen —
  temperature, wind, rain/storms and pressure, each with the current value + ▲/▼ vs the same
  hour yesterday and hover‑for‑grid‑meaning tooltips. New `/api/live/:city` route.
- **Versioning.** The pre‑LIVE app is archived as a frozen baseline in `Temperature1.0/`;
  the main folder is bumped to **1.1.0** and carries development forward.

### July 2026 — data trust
- **Cross‑check / confidence.** Today's shown values are now compared against independent
  Open‑Meteo models (ECMWF, DWD ICON, NOAA GFS, Météo‑France) and MET Norway. Hours that
  disagree with the consensus by more than 4 °C are flagged with a confidence badge, a
  detail panel, and ⚠ markers on the chart. Data is never altered, and changes all sources
  agree on are not flagged. Adds the `/api/crosscheck/:city` route and the
  `METNO_USER_AGENT` env var.
- **Documented provisional history** — added the "Data stability" section explaining why
  recent past days can change between refreshes.

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
