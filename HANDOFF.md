# Temperature Zephyr — Handoff Note

**Date:** 2026-07-07 · **Current version:** 1.3.1 (main folder) · **Baseline:** 1.0.0 (`Temperature1.0/` — see note below)

A weather/temperature dashboard for Central European cities, used to support energy /
power‑trading decisions (solar "FVE" output, wind generation, grid load). Node + Express
backend, PostgreSQL cache, single‑file Chart.js front‑end, all data from Open‑Meteo.

---

## v1.3.1 addendum (2026-07-07)

- **Flags:** the v1.3.0 Twemoji webfont did NOT work on the user's Windows machine —
  buttons don't inherit the body font-family, so the unicode-range font never applied to
  the tab labels. Replaced with inline SVG flags (`.flag` CSS + `PREP_CONFIG[..].flag`);
  the @font-face and its CDN fetch were removed. No dependencies, works everywhere.
- **History tab:** per-cell heat colouring scaled to the displayed week (dark green =
  min, dark red = max, HSL hue interpolation between; blank future cells stay uncoloured).
  Scale legend with real min/max added to the footer.

---

## v1.3.0 addendum (2026-07-07)

What changed in this round (details in README → Changelog → v1.3.0):

- **📖 History tab** — city + ISO week (1 → current) + source dropdowns; 24×7 table of
  actual past hourly temperatures. `GET /api/history/:city?week=N&source=openmeteo|median`.
  "Global median" = per-hour median of ECMWF / DWD ICON / NOAA GFS / Météo-France /
  MET Norway / Open-Meteo, fetched one model per call with automatic skipping (MET Norway
  has no coverage for CZ/HU — expect 5 contributing sources there; the API response's
  `sources` array tells you what was used). Finished weeks read the historical-forecast
  archive; recent weeks read the forecast endpoint's `past_days`. Future hours are null by
  design — the tab never shows forecasts.
- **CZ/HU future tabs** — now 6 days (Today → D+5) and five temperature rows
  (8:00 / 12:00 / 16:00 / 20:00 / 0:00). Tab labels are now flag emojis **🇨🇿 / 🇭🇺** with a
  pinned Twemoji country-flags subset font (unicode-range–limited) so they render on
  Windows too; graceful fallback to "CZ"/"HU" letters if the CDN is unreachable.
- **Tests** — the `tests/` folder referenced by `npm test` was missing from the repo; it
  now exists with offline unit tests for the new pure helpers plus `tests/mock-fetch.js`
  (a preload that fakes Open-Meteo/MET Norway so the app can be booted end-to-end without
  network: `node --require ./tests/mock-fetch.js server.js`).
- **Verified offline** — `node --check` on everything, unit tests green, and a mocked
  end-to-end boot: `/`, `/api/preparation/*` (6 days, h12/h20), `/api/history/*` (both
  sources, past + current week, validation errors) all returned sane payloads. A **live
  smoke test is still required** (this build environment has no network access — same as
  the 1.1/1.2 handoffs): after deploy open the 📖 History tab and check a past week with
  both sources, and `GET /api/history/Prague?week=1&source=median` for the archive path.

---

## v1.2.0 addendum (2026-07-02)

What changed in this round (full list in README → Changelog → v1.2.0):

- **Consensus correction** — the cross-check now *fixes* clear model outliers instead of
  only flagging them: if best_match is > 4 °C off the median of the other sources while
  ≥ 3 of them agree within 2 °C, the Today line shows their median (cyan ◆, raw value in
  the tooltip / API `primary`). Disagreeing sources ⇒ flag only, never substitute. Logic in
  `analyzeCrossCheck` (pure, tested). Stored data is never modified.
- **📈 Market tab** — per-country CZ/HU power-fundamentals brief (`/api/market/:country`):
  pop-weighted demand temp + HDD/CDD, solar index, hub-height wind index via turbine power
  curve, risk flags, day-over-day signals + residual-load direction. Pure builders
  (`parseMarketCity`, `buildMarketBrief`, …) exported and unit-tested.
- **Bug fixes** — server no longer fails to start without a reachable Postgres (degrades to
  in-memory cache); front-end no longer caches error payloads as data (a single 500 used to
  break charts until manual refresh); Czechia average survives one broken city; LIVE
  pressure no longer compares surface vs MSL pressure (fake ▼ of ~40 hPa).
- **Tests wired in** — `npm test` runs 27 offline unit tests (`tests/server.test.js`).
- **Verified end-to-end offline** — the app was booted against a mocked Open-Meteo API: a
  planted 35 ° outlier at 14:00 vs a tight 21 ° consensus produced `status: "corrected"`,
  `display = 21`, raw preserved; market/live/prep/verify routes all returned sane payloads.
  A **live smoke test is still required** (build environments have no network access —
  same as the 1.1 handoff): check the LIVE tab, `/api/crosscheck/Budapest`,
  `/api/market/CZ` and `/api/market/HU` after deploy, and set `METNO_USER_AGENT`.

⚠ **Note on `Temperature1.0/`:** the folder exists but is **empty** in this working copy —
the frozen 1.0 baseline described below is missing. If you have the snapshot elsewhere
(git history / backup), restore it; otherwise treat the baseline as lost.

⚠ **Tooling note:** the sandboxed build environment used for 1.1 and 1.2 truncates in-place
edits of existing files (the "file view froze" issue from the 1.1 session). This session
worked around it by writing whole files and verifying byte sizes + syntax afterwards —
`server.js`, `public/index.html`, `package.json` and `tests/` were all confirmed complete
(`node --check`, 27/27 tests passing, mocked end-to-end boot).

---

## TL;DR — status at a glance

- The app is feature‑complete for this round and runs the same way it always has
  (`npm install` → set env → `npm start` → open `:3000`).
- **Two things must be done before trusting the two newest features** (cross‑check + LIVE) —
  see **Action items** below. Everything else is production‑ready.
- Nothing in the data pipeline was changed in a way that alters existing behaviour; the new
  work is additive (a new tab, a new confidence badge, docs, and a version snapshot).

---

## ⚠ Action items before you rely on it

1. **Live smoke‑test the two API‑backed features.** The cross‑check and LIVE tab call external
   endpoints that could not be reached from the build environment, so they are written to the
   documented API contracts with graceful degradation but have **not been exercised against a
   live response**. After deploy, open the app and confirm:
   - LIVE tab shows real numbers for Prague, Brno, Budapest, Debrecen.
   - `GET /api/crosscheck/Budapest` returns values from all sources (4 Open‑Meteo models + MET Norway).
   - `GET /api/live/Budapest` returns current values + yesterday deltas.
   If a source is missing, the feature still works with whatever responded (it degrades, it
   won't crash).

2. **Set `METNO_USER_AGENT`.** MET Norway blocks generic/missing User‑Agents. Set it to a real
   contact, e.g. `TemperatureZephyr/1.0 vit.vavra@zephyrtrade.eu`. Without it, MET Norway is
   skipped and the cross‑check still runs on the four Open‑Meteo models.

3. **Run one local sanity pass.** `node --check server.js` and load the page once. (A single
   whole‑file syntax check could not be completed in the last session because the build
   sandbox's file view froze; every new code block was verified in isolation instead, and the
   on‑disk files were confirmed complete and well‑formed.)

---

## How to run

```bash
npm install
# env: DATABASE_URL (Postgres, required for cache), PORT (default 3000),
#      METNO_USER_AGENT (recommended)
npm start          # -> http://localhost:3000
```

On start it creates the `weather_cache` table, fetches all cities, and schedules a refresh
every 6 hours.

| Env var | Required | Notes |
|---------|----------|-------|
| `DATABASE_URL` | Yes (for caching) | Postgres connection string; SSL auto‑enabled when set |
| `PORT` | No | Default `3000` |
| `METNO_USER_AGENT` | Recommended | Real contact for the MET Norway cross‑check |

---

## Where things live

```
Temperature-Zephyr-main/          # main working copy (v1.1.0)
├── server.js                     # backend: routes, Open-Meteo fetch, cache, verify, cross-check, prep, live
├── public/index.html             # entire front-end (HTML + CSS + JS in one file)
├── package.json / package-lock.json
├── README.md                     # full documentation
├── HANDOFF.md                    # this file
└── Temperature1.0/               # FROZEN v1.0 baseline snapshot (pre-LIVE) — do not edit
```

The pure/testable helpers in `server.js` are exported at the bottom (`getDateString`,
`runDataChecks`, `parsePreparation`, `buildNotes`, `analyzeCrossCheck`, `localHourIndex`,
`parseLive`, `liveDir`, …) so logic can be unit‑tested without a DB or network.

---

## What each tab does

- **Graphs** — two charts (Czech cities incl. a Czechia average; other cities). Legends are
  **clickable** to hide/show lines (state persists across city changes).
- **Table** — the same series numerically, every 4 hours.
- **🇨🇿 future / 🇭🇺 future** — 6‑day outlook per country (Prague/Budapest as proxies) with
  temp at 8/12/16/20/0 h, pressure/wind/weather/clouds/solar and auto notes. Column headers
  show **label / date / weekday**.
- **📖 History** — city + week (ISO, 1 → current) + source dropdowns; 24×7 grid of actual
  past hourly temperatures (Openmeteo best_match, or Global median of all sources).
- **⚡ LIVE** — right‑now snapshot for Prague, Brno, Budapest, Debrecen across Temperature,
  Wind, Rain/Storms, Pressure. Each shows the current value + **▲/▼/▬ vs the same hour
  yesterday**. Hover a category header for its **grid meaning**. Auto‑refreshes every 5 min.

## API routes

| Route | Purpose |
|-------|---------|
| `GET /api/cities` | City list |
| `GET /api/weather/:city` | Cached weather (auto‑refresh if > 1 h old) |
| `POST /api/fetch` | Force fresh fetch for all cities |
| `GET /api/status` | Per‑city cache timestamps |
| `GET /api/verify/:city` | Data sanity checks + ERA5 cross‑check |
| `GET /api/preparation/:city` | 5‑day country outlook |
| `GET /api/crosscheck/:city` | Today vs independent models + MET Norway (flags outliers) |
| `GET /api/live/:city` | Right‑now snapshot + direction vs yesterday |
| `GET /api/history/:city?week=N&source=openmeteo\|median` | Hour‑by‑hour actual temps for one ISO week |

## Config knobs (all in `server.js`)

`cities` · `APP_TIMEZONE` / `PREP_TZ` · `VERIFY` (verification thresholds) ·
`CROSSCHECK` (models, `DEVIATION_C`, `MIN_SOURCES`, cache, User‑Agent) · `LIVE_CACHE_MS` ·
the `cron.schedule('0 */6 * * *', …)` refresh interval.

---

## Known behaviour (by design, not bugs)

- **Recent past days are provisional.** Open‑Meteo's forecast endpoint returns continuously
  re‑analysed *model* data for past days (not final observations), and the app overwrites its
  whole cache every 6 h — so an already‑happened day's line can shift a few degrees between
  refreshes. The verification badge (ERA5 cross‑check) will flag it when it drifts. If you ever
  need **immutable history**, the fix is write‑once freezing of past days and/or sourcing days
  older than ~5 days from the ERA5 archive endpoint. See README → "Data stability".

- **Cross‑check only flags, never edits.** It marks hours where the shown value disagrees with
  the consensus of independent sources by > 4 °C. Genuine fast changes that all sources agree
  on are deliberately not flagged, so real fronts/storms don't false‑trigger.

- **Cross‑check runs on single cities**, not the Czechia average (the LIVE tab and cross‑check
  skip the average).

---

## Testing status

Logic is covered by ad‑hoc offline unit tests (run during development, all passing) for the
exported pure functions — `parseLive`, `liveDir`, `analyzeCrossCheck`, `localHourIndex`,
`runDataChecks`, `parsePreparation`, `buildNotes`, `getDateString`, plus the front‑end
render/toggle helpers. **There is no test runner wired into `package.json` yet** — adding
`"test": "node --test"` and a `tests/` folder is a good early next step so these run in CI.

---

## Suggested backlog / next steps

1. Do the live smoke‑test + set `METNO_USER_AGENT` (see Action items).
2. Add a proper test suite + `npm test`.
3. Decide "Praha" vs "Prague" label on the LIVE tab (currently "Prague", to match dropdowns).
4. Optional: implement immutable history (freeze past days) if the shifting historic lines
   ever cause confusion for trading.
5. Optional: extend cross‑check to tomorrow/forecast days, or surface it in the Table view.
6. When 1.1 is confirmed stable in production, snapshot it as `Temperature1.1/` following the
   same versioning pattern as `Temperature1.0/`.

---

## Version history

- **1.1.0 (Jul 2026)** — LIVE tab (`/api/live`), version snapshot workflow. Baseline archived
  as `Temperature1.0/`.
- **1.0.x (Jun–Jul 2026)** — Chart.js CDN pinned; client timezone fix; clickable legends;
  weekday in CZ/HU headers; GitHub README; multi‑source cross‑check / confidence
  (`/api/crosscheck`, ECMWF/ICON/GFS/Météo‑France + MET Norway); documented provisional‑history
  behaviour; dependency floors + Node engines updated.

See README.md → "Changelog" for the detailed list.
