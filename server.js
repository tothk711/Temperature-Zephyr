const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection. The DB is a cache, not the source of truth — if it is
// missing or unreachable the app must still serve data, so every DB access is
// guarded by `dbReady` and backed by an in-memory fallback cache.
const DB_ENABLED = !!process.env.DATABASE_URL;
let dbReady = false;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: DB_ENABLED ? { rejectUnauthorized: false } : false
});
// Never let an idle-client error (e.g. DB restart) crash the process.
pool.on('error', err => console.error('Postgres pool error:', err.message));

// In-memory fallback: { cityName: { data, updatedAt } }. Used when the DB is
// unavailable, and always written so a DB outage never blanks the app.
const memWeatherCache = {};

// Cities configuration
const cities = [
  { name: "Prague",   lat: 50.08, lon: 14.42 },
  { name: "Brno",     lat: 49.19, lon: 16.61 },
  { name: "Plzen",    lat: 49.75, lon: 13.38 },
  { name: "Ostrava",  lat: 49.83, lon: 18.29 },
  { name: "Berlin",   lat: 52.52, lon: 13.40 },
  { name: "Munich",   lat: 48.14, lon: 11.58 },
  { name: "Budapest", lat: 47.50, lon: 19.04 },
  { name: "Debrecen", lat: 47.53, lon: 21.63 },
];

// Initialize database (simple cache table). Failure is not fatal — the app
// falls back to the in-memory cache and keeps running.
async function initDB() {
  if (!DB_ENABLED) {
    console.warn('DATABASE_URL not set — running with in-memory cache only (no persistence across restarts).');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS weather_cache (
        id SERIAL PRIMARY KEY,
        city_name VARCHAR(50) NOT NULL UNIQUE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    dbReady = true;
    console.log('Database initialized');
  } catch (err) {
    console.error('Database unavailable — continuing with in-memory cache only:', err.message);
  }
}

// Timezone used for all date math. The weather API returns timestamps in this
// zone (see &timezone=Europe%2FPrague in the request URLs), so day boundaries
// must be computed in the same zone — not in UTC.
const APP_TIMEZONE = 'Europe/Prague';

// Get date string in YYYY-MM-DD format for "today + offsetDays" in APP_TIMEZONE.
//
// Previously this used new Date().toISOString(), which is UTC. On a server
// running in UTC, that made the day labels disagree with the Prague-local
// timestamps returned by the API for the first 1-2 hours after local midnight,
// shifting every series by a day and corrupting the charts during that window.
function getDateString(offsetDays = 0) {
  // Today's calendar date in the app timezone, as YYYY-MM-DD.
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  const [y, m, d] = todayLocal.split('-').map(Number);
  // Anchor at noon UTC so adding/subtracting whole days can never cross a DST
  // change or a midnight boundary into the wrong date.
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  return anchor.toISOString().split('T')[0];
}

// Every upstream request shares a hard timeout: one hanging connection must
// never freeze a route (or "Refresh All Data") for minutes.
const UPSTREAM_TIMEOUT_MS = 15000;
function tFetch(url, opts = {}) {
  return fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), ...opts });
}

// Fetch weather data from Open-Meteo for a city
async function fetchWeatherFromAPI(city) {
  // Get 8 days of history (for 7 days ago to yesterday) and 3 days forecast
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&past_days=8&forecast_days=3&timezone=Europe%2FPrague`;

  // Previous Runs API - get both current forecast AND yesterday's forecast in one call
  // temperature_2m = current/latest forecast
  // temperature_2m_previous_day1 = forecast from 1 day ago (yesterday ~11 AM)
  const previousRunUrl = `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m_previous_day1&forecast_days=3&timezone=Europe%2FPrague`;

  try {
    // Fetch both APIs in parallel
    const [response, prevResponse] = await Promise.all([
      tFetch(url),
      tFetch(previousRunUrl).catch(err => {
        console.log(`Previous runs API failed for ${city.name}:`, err.message);
        return null;
      })
    ]);

    if (!response.ok) {
      throw new Error(`API responded with HTTP ${response.status}`);
    }

    const data = await response.json();

    // Open-Meteo reports problems as { error: true, reason: "..." } with a 200,
    // so check explicitly instead of assuming the payload is valid.
    if (data.error) {
      throw new Error(`API error: ${data.reason || 'unknown reason'}`);
    }

    let prevData = null;
    if (prevResponse && prevResponse.ok) {
      prevData = await prevResponse.json();
    }

    if (!data.hourly || !Array.isArray(data.hourly.time) || !Array.isArray(data.hourly.temperature_2m)) {
      throw new Error('No hourly data in response');
    }

    return parseWeatherPayload(data, prevData);
  } catch (error) {
    console.error(`Error fetching weather for ${city.name}:`, error.message);
    return null;
  }
}

// Pure: build the app's per-day series structure from raw Open-Meteo payloads
// (`data` = forecast response, `prevData` = previous-runs response or null).
// Exported for tests; reused by the Global-median fetcher below.
function parseWeatherPayload(data, prevData) {
    // Parse the data into our days
    const days = {
      sevenDaysAgo: getDateString(-7),
      sixDaysAgo: getDateString(-6),
      fiveDaysAgo: getDateString(-5),
      fourDaysAgo: getDateString(-4),
      threeDaysAgo: getDateString(-3),
      twoDaysAgo: getDateString(-2),
      yesterday: getDateString(-1),
      today: getDateString(0),
      tomorrow: getDateString(1),
      dayAfterTomorrow: getDateString(2),
    };

    const result = {
      sevenDaysAgo: { date: days.sevenDaysAgo, temps: Array(24).fill(null) },
      sixDaysAgo: { date: days.sixDaysAgo, temps: Array(24).fill(null) },
      fiveDaysAgo: { date: days.fiveDaysAgo, temps: Array(24).fill(null) },
      fourDaysAgo: { date: days.fourDaysAgo, temps: Array(24).fill(null) },
      threeDaysAgo: { date: days.threeDaysAgo, temps: Array(24).fill(null) },
      twoDaysAgo: { date: days.twoDaysAgo, temps: Array(24).fill(null) },
      yesterday: { date: days.yesterday, temps: Array(24).fill(null) },
      today: { date: days.today, temps: Array(24).fill(null) },
      todayForecast: { date: days.today, temps: Array(24).fill(null) }, // Yesterday's forecast for today
      tomorrow: { date: days.tomorrow, temps: Array(24).fill(null) },
      dayAfterTomorrow: { date: days.dayAfterTomorrow, temps: Array(24).fill(null) },
      updatedAt: new Date().toISOString()
    };

    // Fill in temperatures from current data
    const times = data.hourly.time;
    const temps = data.hourly.temperature_2m;

    for (let i = 0; i < times.length; i++) {
      const dateStr = times[i].split('T')[0];
      const hour = parseInt(times[i].split('T')[1].split(':')[0]);
      const temp = temps[i];

      // Match to the correct day (skip todayForecast, that comes from prevData)
      for (const [key, dayData] of Object.entries(result)) {
        if (key !== 'updatedAt' && key !== 'todayForecast' && dayData.date === dateStr) {
          dayData.temps[hour] = temp;
          break;
        }
      }
    }

    // Fill in yesterday's forecast for today (from previous run API)
    // The field is named temperature_2m_previous_day1
    if (prevData && prevData.hourly && prevData.hourly.temperature_2m_previous_day1) {
      const prevTimes = prevData.hourly.time;
      const prevTemps = prevData.hourly.temperature_2m_previous_day1;

      for (let i = 0; i < prevTimes.length; i++) {
        const dateStr = prevTimes[i].split('T')[0];
        const hour = parseInt(prevTimes[i].split('T')[1].split(':')[0]);
        const temp = prevTemps[i];

        // Only get data for today's date
        if (dateStr === days.today) {
          result.todayForecast.temps[hour] = temp;
        }
      }
    }

    // Calculate average of past days (3 to 7 days ago)
    const pastDaysAvg = { date: 'avg', temps: Array(24).fill(null) };
    for (let hour = 0; hour < 24; hour++) {
      let sum = 0;
      let count = 0;
      ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo', 'fourDaysAgo', 'threeDaysAgo'].forEach(day => {
        if (result[day].temps[hour] !== null) {
          sum += result[day].temps[hour];
          count++;
        }
      });
      pastDaysAvg.temps[hour] = count > 0 ? sum / count : null;
    }
    result.pastDaysAvg = pastDaysAvg;

    return result;
}

// ---------------------------------------------------------------------------
// Global-median weather (Graphs tab "Source" selector)
//
// The same per-day series as fetchWeatherFromAPI, but every hour is the MEDIAN
// across the implemented sources, fetched one model per call exactly like the
// cross-check / History tab (a model with no coverage here is skipped — MET
// Norway's Nordic domain does not reach these cities). The previous-runs
// "Today Forecast" series is medianed the same way. Cached in memory only:
// the Postgres cache stays reserved for the canonical best_match data.
// ---------------------------------------------------------------------------

// NOTE (v1.4.1): MET Norway's Nordic model is gone from this list — it has no
// coverage for any of our cities, so requesting it only burned rate-limit
// budget (the real MET Norway API is still used by the cross-check).
const MEDIAN_MODELS = ['best_match', 'ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'meteofrance_seamless'];
const memMedianCache = {};
const medianInFlight = {};              // coalesce concurrent requests per city
const MEDIAN_CACHE_MS = 60 * 60 * 1000; // same freshness rule as /api/weather

// Pull each model's series out of a multi-model response. With several models
// requested Open-Meteo suffixes every variable (temperature_2m_<model>); with
// a single one the name stays plain. A model without coverage simply has no
// array — skipped, never fatal.
function extractModelSeries(raw, field, ids) {
  const h = (raw && raw.hourly) || {};
  if (!Array.isArray(h.time)) return [];
  const out = [];
  for (const id of ids) {
    const arr = Array.isArray(h[`${field}_${id}`]) ? h[`${field}_${id}`]
              : (ids.length === 1 && Array.isArray(h[field]) ? h[field] : null);
    if (arr) out.push({ model: id, time: h.time, values: arr });
  }
  if (!out.length && Array.isArray(h[field])) {
    out.push({ model: ids[0] || 'best_match', time: h.time, values: h[field] });
  }
  return out;
}

// Median-merge {time, values} series onto the first series' time grid.
function medianSeries(seriesList) {
  const maps = seriesList.map(s => {
    const m = {};
    for (let i = 0; i < s.time.length; i++) {
      const v = s.values[i];
      if (typeof v === 'number' && !Number.isNaN(v)) m[s.time[i]] = v;
    }
    return m;
  });
  const time = seriesList[0].time.slice();
  return { time, values: time.map(t => medianOf(maps.map(m => m[t]))) };
}

// TWO requests per city (forecast + previous-runs), all models batched into
// each — v1.4.0 did TWELVE separate requests here, which tripped Open-Meteo's
// rate limits and took the whole app down (Market/LIVE/prep all share that
// host). Batching is the fix, not a nicety.
async function fetchWeatherMedianFromAPI(city) {
  const models = MEDIAN_MODELS.join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&past_days=8&forecast_days=3&timezone=Europe%2FPrague&models=${models}`;
  const prevUrl = `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m_previous_day1&forecast_days=3&timezone=Europe%2FPrague&models=${models}`;
  try {
    const [r, pr] = await Promise.all([
      tFetch(url),
      tFetch(prevUrl).catch(() => null)
    ]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    if (raw.error) throw new Error(raw.reason || 'API error');
    const mains = extractModelSeries(raw, 'temperature_2m', MEDIAN_MODELS);
    if (!mains.length) throw new Error('no model series in response');
    const main = medianSeries(mains);

    let prevData = null;
    if (pr && pr.ok) {
      const praw = await pr.json().catch(() => null);
      if (praw && !praw.error) {
        const prevs = extractModelSeries(praw, 'temperature_2m_previous_day1', MEDIAN_MODELS);
        if (prevs.length) {
          const pm = medianSeries(prevs);
          prevData = { hourly: { time: pm.time, temperature_2m_previous_day1: pm.values } };
        }
      }
    }

    const result = parseWeatherPayload({ hourly: { time: main.time, temperature_2m: main.values } }, prevData);
    if (result) result.sources = mains.map(s => s.model);
    return result;
  } catch (err) {
    console.error(`Median weather failed for ${city.name}:`, err.message);
    return null;
  }
}

async function getMedianWeather(city) {
  const c = memMedianCache[city.name];
  if (c && (Date.now() - new Date(c.updatedAt).getTime()) < MEDIAN_CACHE_MS) return c;
  // The Czechia average asks for four cities at once; if the same city is
  // already being fetched, piggyback instead of doubling the traffic.
  if (medianInFlight[city.name]) return medianInFlight[city.name];
  medianInFlight[city.name] = (async () => {
    try {
      const data = await fetchWeatherMedianFromAPI(city);
      if (!data) return c || null; // stale beats nothing
      const entry = { data, updatedAt: new Date() };
      memMedianCache[city.name] = entry;
      return entry;
    } finally {
      delete medianInFlight[city.name];
    }
  })();
  return medianInFlight[city.name];
}

// Store weather data in cache (memory always; DB when available)
async function cacheWeatherData(cityName, data) {
  memWeatherCache[cityName] = { data, updatedAt: new Date() };
  if (!dbReady) return;
  try {
    await pool.query(`
      INSERT INTO weather_cache (city_name, data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (city_name)
      DO UPDATE SET data = $2, updated_at = NOW()
    `, [cityName, JSON.stringify(data)]);
    console.log(`Cached weather data for ${cityName}`);
  } catch (err) {
    console.error(`Error caching data for ${cityName}:`, err.message);
  }
}

// Get cached weather data (DB first, then in-memory fallback)
async function getCachedWeather(cityName) {
  if (dbReady) {
    try {
      const result = await pool.query(`
        SELECT data, updated_at FROM weather_cache WHERE city_name = $1
      `, [cityName]);

      if (result.rows.length > 0) {
        return {
          data: result.rows[0].data,
          updatedAt: result.rows[0].updated_at
        };
      }
    } catch (err) {
      console.error(`Error getting cached data for ${cityName}:`, err.message);
    }
  }
  return memWeatherCache[cityName] || null;
}

// Fetch and cache data for all cities
async function fetchAllCities() {
  console.log('Starting weather data fetch for all cities...');

  // All cities in parallel, bounded by the fetch timeout. The old sequential
  // loop (with per-city delays) could hold "Refresh All Data" for minutes
  // when the API was slow or throttling.
  await Promise.allSettled(cities.map(async (city) => {
    const data = await fetchWeatherFromAPI(city);
    if (data) await cacheWeatherData(city.name, data);
  }));

  // The underlying data just changed, so drop any cached verification and
  // cross-check results (defined further down) to force a fresh check next time.
  if (typeof verifyCache === 'object') {
    Object.keys(verifyCache).forEach(k => delete verifyCache[k]);
  }
  if (typeof crossCheckCache === 'object') {
    Object.keys(crossCheckCache).forEach(k => delete crossCheckCache[k]);
  }
  if (typeof marketCache === 'object') {
    Object.keys(marketCache).forEach(k => delete marketCache[k]);
  }

  console.log('Finished fetching weather data for all cities');
}

// ---------------------------------------------------------------------------
// Data verification
//
// Answers the question "is the data we downloaded actually correct?" with two
// layers: cheap sanity checks on the values themselves, and an independent
// cross-check of the historical days against Open-Meteo's ERA5 reanalysis
// archive (a separate dataset from the forecast endpoint the app normally
// uses). The pure logic lives in runDataChecks() so it can be unit tested
// without any network access.
// ---------------------------------------------------------------------------

const VERIFY = {
  MIN_TEMP: -45,          // °C, plausible lower bound for these cities
  MAX_TEMP: 48,           // °C, plausible upper bound
  MAX_HOURLY_JUMP: 12,    // °C between two adjacent hours
  MAX_MISSING_RECENT: 4,  // allowed null hours across yesterday + today
  GEO_MAX_KM: 30,         // configured coords must be within this of the named city
  ERA5_MAE_LIMIT: 3.0,    // °C average error vs reanalysis before warning
  ERA5_MAX_LIMIT: 6.0,    // °C worst-hour error vs reanalysis before warning
  CACHE_MS: 6 * 3600000   // re-verify at most once per 6 hours per city
};

// Great-circle distance between two points in kilometres.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Pure verification logic (no network) so it is easy to test.
//   city : { name, lat, lon }
//   data : the stored weather object for that city
//   geo  : { lat, lon, name } from the geocoder, or null if unavailable
//   era5 : { 'YYYY-MM-DDTHH': temp } reanalysis map, or null if unavailable
function runDataChecks(city, data, geo, era5) {
  const checks = [];
  const dayKeys = ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo', 'fourDaysAgo',
                   'threeDaysAgo', 'twoDaysAgo', 'yesterday', 'today',
                   'tomorrow', 'dayAfterTomorrow'];

  // 1) The coordinates really belong to the city we think they do.
  if (geo && typeof geo.lat === 'number') {
    const dist = haversineKm(city.lat, city.lon, geo.lat, geo.lon);
    checks.push({
      name: 'Coordinates match city',
      pass: dist <= VERIFY.GEO_MAX_KM,
      detail: `Configured point is ${dist.toFixed(1)} km from geocoded "${city.name}" (limit ${VERIFY.GEO_MAX_KM} km).`
    });
  } else {
    checks.push({ name: 'Coordinates match city', pass: true, skipped: true,
      detail: 'Geocoder unavailable — coordinate check skipped.' });
  }

  // 2) Every temperature is within a physically plausible range.
  let outOfRange = 0, total = 0, gMin = Infinity, gMax = -Infinity;
  for (const k of dayKeys) {
    if (!data[k] || !Array.isArray(data[k].temps)) continue;
    for (const t of data[k].temps) {
      if (t === null || t === undefined) continue;
      total++;
      if (t < gMin) gMin = t;
      if (t > gMax) gMax = t;
      if (t < VERIFY.MIN_TEMP || t > VERIFY.MAX_TEMP) outOfRange++;
    }
  }
  checks.push({
    name: 'Temperatures in plausible range',
    pass: outOfRange === 0 && total > 0,
    detail: total === 0 ? 'No temperature values found.'
      : `${total} values from ${gMin.toFixed(1)}°C to ${gMax.toFixed(1)}°C; ${outOfRange} out of range.`
  });

  // 3) The most important recent days are reasonably complete.
  let missingRecent = 0;
  for (const k of ['yesterday', 'today']) {
    if (!data[k] || !Array.isArray(data[k].temps)) { missingRecent += 24; continue; }
    missingRecent += data[k].temps.filter(t => t === null || t === undefined).length;
  }
  checks.push({
    name: 'Recent days complete',
    pass: missingRecent <= VERIFY.MAX_MISSING_RECENT,
    detail: `${missingRecent} missing hour(s) across yesterday + today (limit ${VERIFY.MAX_MISSING_RECENT}).`
  });

  // 4) No impossible hour-to-hour temperature jumps (a sign of corruption).
  let worstJump = 0, worstWhen = '';
  for (const k of dayKeys) {
    if (!data[k] || !Array.isArray(data[k].temps)) continue;
    const t = data[k].temps;
    for (let h = 1; h < t.length; h++) {
      if (t[h] == null || t[h - 1] == null) continue;
      const jump = Math.abs(t[h] - t[h - 1]);
      if (jump > worstJump) { worstJump = jump; worstWhen = `${data[k].date} ${h - 1}:00→${h}:00`; }
    }
  }
  checks.push({
    name: 'No impossible hourly jumps',
    pass: worstJump <= VERIFY.MAX_HOURLY_JUMP,
    detail: worstWhen
      ? `Largest change ${worstJump.toFixed(1)}°C (${worstWhen}); limit ${VERIFY.MAX_HOURLY_JUMP}°C.`
      : 'Not enough data to evaluate.'
  });

  // 5) Historical days agree with the independent ERA5 reanalysis archive.
  if (era5 && Object.keys(era5).length) {
    let sumAbs = 0, n = 0, maxErr = 0, maxWhen = '';
    for (const k of ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo']) {
      if (!data[k] || !Array.isArray(data[k].temps)) continue;
      for (let h = 0; h < data[k].temps.length; h++) {
        const ours = data[k].temps[h];
        const ref = era5[`${data[k].date}T${String(h).padStart(2, '0')}`];
        if (ours == null || ref == null) continue;
        const err = Math.abs(ours - ref);
        sumAbs += err; n++;
        if (err > maxErr) { maxErr = err; maxWhen = `${data[k].date} ${h}:00`; }
      }
    }
    if (n > 0) {
      const mae = sumAbs / n;
      checks.push({
        name: 'Matches ERA5 reference archive',
        pass: mae <= VERIFY.ERA5_MAE_LIMIT && maxErr <= VERIFY.ERA5_MAX_LIMIT,
        detail: `${n} hours compared: avg diff ${mae.toFixed(2)}°C, worst ${maxErr.toFixed(1)}°C at ${maxWhen} (limits ${VERIFY.ERA5_MAE_LIMIT}/${VERIFY.ERA5_MAX_LIMIT}°C).`
      });
    } else {
      checks.push({ name: 'Matches ERA5 reference archive', pass: true, skipped: true,
        detail: 'No overlapping hours available to compare yet.' });
    }
  } else {
    checks.push({ name: 'Matches ERA5 reference archive', pass: true, skipped: true,
      detail: 'Reference archive unavailable — cross-check skipped.' });
  }

  const hardFail = checks.some(c => c.pass === false && !c.skipped);
  return {
    city: city.name,
    status: hardFail ? 'warning' : 'ok',
    checkedAt: new Date().toISOString(),
    checks
  };
}

// In-memory cache of verification results (verification is comparatively heavy).
const verifyCache = {};

// Confirm the configured coordinates resolve to the named city.
async function fetchGeo(city) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.name)}&count=1&language=en&format=json`;
    const r = await tFetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (j && Array.isArray(j.results) && j.results.length) {
      return { lat: j.results[0].latitude, lon: j.results[0].longitude, name: j.results[0].name };
    }
  } catch (e) {
    console.log(`Geocode failed for ${city.name}:`, e.message);
  }
  return null;
}

// Fetch the ERA5 reanalysis for the oldest historical days, keyed by hour.
async function fetchEra5(city) {
  try {
    const start = getDateString(-7);
    const end = getDateString(-5);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&start_date=${start}&end_date=${end}&hourly=temperature_2m&timezone=Europe%2FPrague`;
    const r = await tFetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.hourly || !Array.isArray(j.hourly.time)) return null;
    const map = {};
    for (let i = 0; i < j.hourly.time.length; i++) {
      // "2026-06-08T00:00" -> key "2026-06-08T00"
      map[j.hourly.time[i].slice(0, 13)] = j.hourly.temperature_2m[i];
    }
    return map;
  } catch (e) {
    console.log(`ERA5 fetch failed for ${city.name}:`, e.message);
    return null;
  }
}

// Verify one city, using cached results when fresh enough.
async function verifyCity(city) {
  const cached = verifyCache[city.name];
  if (cached && (Date.now() - cached.ts) < VERIFY.CACHE_MS) return cached.result;

  let weather = await getCachedWeather(city.name);
  if (!weather) {
    const fresh = await fetchWeatherFromAPI(city);
    if (fresh) {
      await cacheWeatherData(city.name, fresh);
      weather = { data: fresh };
    }
  }
  if (!weather) {
    return {
      city: city.name, status: 'warning', checkedAt: new Date().toISOString(),
      checks: [{ name: 'Data available', pass: false, detail: 'No weather data to verify.' }]
    };
  }

  const [geo, era5] = await Promise.all([fetchGeo(city), fetchEra5(city)]);
  const result = runDataChecks(city, weather.data, geo, era5);
  verifyCache[city.name] = { result, ts: Date.now() };
  return result;
}

// ---------------------------------------------------------------------------
// Country preparation overview (CZ / HU)
//
// A 6-day "what's coming" table for a capital city (used as the country proxy:
// Prague = CZ, Budapest = HU). Shows temperatures at 08:00/12:00/16:00/20:00/
// 00:00 plus pressure, wind, weather, cloud cover and solar (FVE) potential, with
// auto-generated notes. Every value comes straight from Open-Meteo; anything
// the API does not return is left null and rendered blank — never invented.
// The pure functions (parsePreparation, buildNotes, classify*) are exported so
// they can be unit tested without any network access.
// ---------------------------------------------------------------------------

const PREP_TZ = { Prague: 'Europe/Prague', Budapest: 'Europe/Budapest' };
const PREP_LABELS = ['Today', 'Tomorrow', 'D+2', 'D+3', 'D+4', 'D+5'];

// WMO weather code -> short human description.
const WMO_DESC = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail'
};

function describeWeather(code) {
  if (code === null || code === undefined) return null;
  return WMO_DESC[code] || `Code ${code}`;
}
function isStormCode(code) { return code === 95 || code === 96 || code === 99; }

function classifyPressure(hPa) {
  if (hPa === null || hPa === undefined) return null;
  if (hPa < 1005) return 'Low';
  if (hPa > 1020) return 'High';
  return 'Normal';
}
function classifyWind(gustKmh) {
  if (gustKmh === null || gustKmh === undefined) return null;
  if (gustKmh >= 50) return 'Strong';
  if (gustKmh >= 20) return 'Normal';
  return 'Light';
}
function classifyClouds(pct) {
  if (pct === null || pct === undefined) return null;
  if (pct < 10) return 'None';
  if (pct < 35) return 'Low';
  if (pct < 65) return 'Medium';
  if (pct < 85) return 'High';
  return 'Very high';
}

// Build the per-day structure from a raw Open-Meteo response. Pure + testable.
// Any value not present in the response becomes null.
function parsePreparation(raw) {
  if (!raw || !raw.daily || !Array.isArray(raw.daily.time)) return [];
  const h = raw.hourly || {};
  const hTime = Array.isArray(h.time) ? h.time : [];
  const idxByTime = {};
  for (let i = 0; i < hTime.length; i++) idxByTime[hTime[i]] = i;

  const numAt = (arr, t) => {
    const i = idxByTime[t];
    if (i === undefined || !Array.isArray(arr)) return null;
    const v = arr[i];
    return (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  };
  const dailyNum = (arr, di) => {
    if (!Array.isArray(arr)) return null;
    const v = arr[di];
    return (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  };

  const days = [];
  const nDays = Math.min(raw.daily.time.length, 6);
  for (let di = 0; di < nDays; di++) {
    const date = raw.daily.time[di];

    // Mean cloud cover across that day's hours (only counting real values).
    let cloudSum = 0, cloudN = 0;
    if (Array.isArray(h.cloud_cover)) {
      for (let i = 0; i < hTime.length; i++) {
        if (typeof hTime[i] === 'string' && hTime[i].slice(0, 10) === date) {
          const v = h.cloud_cover[i];
          if (typeof v === 'number' && !Number.isNaN(v)) { cloudSum += v; cloudN++; }
        }
      }
    }
    const cloudMean = cloudN > 0 ? cloudSum / cloudN : null;

    let wCode = null;
    if (Array.isArray(raw.daily.weather_code) && typeof raw.daily.weather_code[di] === 'number') {
      wCode = raw.daily.weather_code[di];
    }
    const pressure = numAt(h.pressure_msl, `${date}T12:00`);
    const gustMax = dailyNum(raw.daily.wind_gusts_10m_max, di);

    days.push({
      label: PREP_LABELS[di] || `D+${di}`,
      date,
      temp: {
        h8: numAt(h.temperature_2m, `${date}T08:00`),
        h12: numAt(h.temperature_2m, `${date}T12:00`),
        h16: numAt(h.temperature_2m, `${date}T16:00`),
        h20: numAt(h.temperature_2m, `${date}T20:00`),
        h0: numAt(h.temperature_2m, `${date}T00:00`)
      },
      tempMax: dailyNum(raw.daily.temperature_2m_max, di),
      tempMin: dailyNum(raw.daily.temperature_2m_min, di),
      pressure: { value: pressure, class: classifyPressure(pressure) },
      wind: { gustMax, class: classifyWind(gustMax) },
      weather: { code: wCode, desc: describeWeather(wCode) },
      clouds: { meanPct: cloudMean === null ? null : Math.round(cloudMean), class: classifyClouds(cloudMean) },
      solar: { radSum: dailyNum(raw.daily.shortwave_radiation_sum, di) },
      precipSum: dailyNum(raw.daily.precipitation_sum, di),
      notes: []
    });
  }
  return days;
}

// ~11 simple IF/THEN rules — no AI needed at runtime. Pure + testable.
// prev may be null for the first day.
function buildNotes(prev, day) {
  const notes = [];
  const r = Math.round;
  const num = v => (typeof v === 'number' && !Number.isNaN(v));

  if (prev) {
    if (num(day.tempMax) && num(prev.tempMax)) {
      const d = day.tempMax - prev.tempMax;
      if (d >= 6) notes.push(`Much warmer (+${r(d)}°C)`);
      else if (d <= -6) notes.push(`Sharp cooldown (${r(d)}°C)`);
    }
    if (num(day.clouds.meanPct) && num(prev.clouds.meanPct)) {
      const d = day.clouds.meanPct - prev.clouds.meanPct;
      if (d >= 35) notes.push('Clouding over — solar drops');
      else if (d <= -35) notes.push('Clearing up — solar boost');
    }
    if (num(day.pressure.value) && num(prev.pressure.value)) {
      if (day.pressure.value - prev.pressure.value <= -8) notes.push('Pressure dropping — unsettled');
    }
    if (num(day.solar.radSum) && num(prev.solar.radSum) && prev.solar.radSum > 0) {
      const rel = (day.solar.radSum - prev.solar.radSum) / prev.solar.radSum;
      if (rel >= 0.3) notes.push('Stronger solar day');
      else if (rel <= -0.3) notes.push('Weaker solar day');
    }
  }
  if (isStormCode(day.weather.code)) notes.push('Storm risk');
  if (num(day.precipSum) && day.precipSum >= 15) notes.push(`Heavy rain (${r(day.precipSum)} mm)`);
  if (num(day.wind.gustMax) && day.wind.gustMax >= 60) notes.push(`Strong winds (${r(day.wind.gustMax)} km/h)`);
  if (num(day.tempMax) && day.tempMax >= 30) notes.push(`Hot day (${r(day.tempMax)}°C)`);
  if (num(day.tempMin) && day.tempMin <= 0) notes.push(`Frost (${r(day.tempMin)}°C)`);
  return notes;
}

// In-memory cache for the (heavier) preparation queries.
const prepCache = {};
const PREP_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function fetchPreparation(city) {
  const cached = prepCache[city.name];
  if (cached && (Date.now() - cached.ts) < PREP_CACHE_MS) return cached.result;

  try {
  const tz = PREP_TZ[city.name] || APP_TIMEZONE;
  const hourly = 'temperature_2m,cloud_cover,pressure_msl,wind_gusts_10m,shortwave_radiation,weather_code';
  const daily = 'weather_code,temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,precipitation_sum,wind_gusts_10m_max,sunshine_duration';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=${hourly}&daily=${daily}&forecast_days=6&timezone=${encodeURIComponent(tz)}&wind_speed_unit=kmh`;

  const r = await tFetch(url);
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const raw = await r.json();
  if (raw.error) throw new Error(`Open-Meteo: ${raw.reason || 'error'}`);

  const days = parsePreparation(raw);
  for (let i = 0; i < days.length; i++) {
    days[i].notes = buildNotes(i > 0 ? days[i - 1] : null, days[i]);
  }

  const result = {
    city: city.name,
    generatedAt: new Date().toISOString(),
    units: { temp: '°C', pressure: 'hPa', wind: 'km/h gusts', clouds: '%', solar: 'MJ/m² (daily)' },
    days
  };
  prepCache[city.name] = { result, ts: Date.now() };
  return result;
  } catch (err) {
    if (cached) {
      console.warn(`Preparation fetch failed for ${city.name} — serving stale:`, err.message);
      return cached.result;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cross-check / confidence
//
// A single weather model can produce an unrealistic value for an hour (e.g. a
// sudden multi-degree drop that turns out to be a model artefact). To catch
// this we compare the value the app actually shows for TODAY (Open-Meteo's
// default "best_match" model) against several independent sources:
//   - other individual Open-Meteo models (ECMWF, DWD ICON, NOAA GFS, Météo-France)
//   - MET Norway (a completely separate provider / different agency)
// If the shown value disagrees with the consensus (median) of the others by
// more than a threshold, that hour is flagged as low-confidence — and when the
// other sources agree TIGHTLY among themselves, the displayed value is
// replaced by their median (the raw model value is always preserved).
// The pure comparison (analyzeCrossCheck) does no network I/O and is unit
// tested.
// ---------------------------------------------------------------------------

const CROSSCHECK = {
  // Open-Meteo model ids fetched one-per-call (so the response is always plain
  // `temperature_2m`, no suffix guessing). Any id a location doesn't return is
  // skipped automatically, so an unknown/renamed id is harmless.
  MODELS: ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'meteofrance_seamless'],
  DEVIATION_C: 4,     // shown value vs median of the others, before flagging
  MIN_SOURCES: 2,     // need at least this many other sources to judge an hour
  // Consensus override: if the primary is off by > DEVIATION_C while the OTHER
  // sources agree among themselves (spread <= CONSENSUS_SPREAD_C across at
  // least CONSENSUS_MIN_SOURCES of them), the primary is almost certainly the
  // outlier — the displayed value becomes the median of the others. When the
  // other sources disagree among themselves we only flag, never substitute
  // (a median of a scattered set is not a trustworthy number).
  CONSENSUS_SPREAD_C: 2,
  CONSENSUS_MIN_SOURCES: 3,
  CACHE_MS: 60 * 60 * 1000,
  // MET Norway requires a User-Agent identifying your app + contact. Override
  // via env so you can put a real contact address (per met.no terms of service).
  METNO_UA: process.env.METNO_USER_AGENT || 'TemperatureZephyr/1.0 (weather cross-check; set METNO_USER_AGENT)'
};

const MODEL_LABELS = {
  ecmwf_ifs025: 'ECMWF', ecmwf_ifs04: 'ECMWF', icon_seamless: 'DWD ICON',
  gfs_seamless: 'NOAA GFS', meteofrance_seamless: 'Météo-France', ukmo_seamless: 'UK Met Office'
};
function modelLabel(id) { return MODEL_LABELS[id] || id; }

// Map a UTC ISO instant to a "today-local" hour index 0..23 in `tz`, or null if
// it does not fall on `todayLocal` (YYYY-MM-DD). Lets us line up MET Norway's
// UTC timestamps with the app's Europe/Prague hours.
function localHourIndex(utcIso, tz, todayLocal) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  }).formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (date !== todayLocal) return null;
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // some ICU builds report midnight as 24
  return (hh >= 0 && hh <= 23) ? hh : null;
}

// Pure: compare shown values against other sources, hour by hour. No network.
//   primary : number[24]         best_match "today" (may contain nulls)
//   sources : { label: number[24] }  other models / providers
//
// Per-hour outcomes:
//   - agree                      -> display = primary
//   - primary off, others TIGHT  -> display = median of others (corrected=true)
//   - primary off, others LOOSE  -> flag only (suspect=true), display = primary
//   - primary missing, others TIGHT -> display = median (filled=true)
// The raw primary value is always kept in `primary`; corrections only ever
// change `display`. Stored/cached data is never modified.
function analyzeCrossCheck(primary, sources, cfg = CROSSCHECK) {
  const labels = Object.keys(sources || {});
  const prim = Array.isArray(primary) ? primary : [];
  const hours = [];
  const suspectHours = [];
  const correctedHours = [];
  const filledHours = [];
  for (let h = 0; h < 24; h++) {
    const others = [];
    for (const lbl of labels) {
      const v = sources[lbl] && sources[lbl][h];
      if (typeof v === 'number' && !Number.isNaN(v)) others.push({ label: lbl, temp: v });
    }
    const p = (typeof prim[h] === 'number' && !Number.isNaN(prim[h])) ? prim[h] : null;
    let median = null, min = null, max = null, spread = null, deviation = null;
    let suspect = false, corrected = false, filled = false, display = p;
    if (others.length) {
      const vals = others.map(o => o.temp).sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      min = vals[0]; max = vals[vals.length - 1]; spread = max - min;
      const tight = others.length >= cfg.CONSENSUS_MIN_SOURCES &&
                    spread <= cfg.CONSENSUS_SPREAD_C;
      if (p !== null && others.length >= cfg.MIN_SOURCES) {
        deviation = Math.abs(p - median);
        if (deviation > cfg.DEVIATION_C) {
          if (tight) { corrected = true; display = median; }
          else       { suspect = true; }
        }
      } else if (p === null && tight) {
        filled = true; display = median;
      }
    }
    if (suspect) suspectHours.push(h);
    if (corrected) correctedHours.push(h);
    if (filled) filledHours.push(h);
    hours.push({ hour: h, primary: p, display, others, median, min, max,
                 spread, deviation, suspect, corrected, filled });
  }
  return { hours, suspectHours, correctedHours, filledHours,
           sourceCount: labels.length, sources: labels };
}

// Fetch one Open-Meteo model's today temps as a 24-slot local-hour array, or null.
async function fetchModelTemps(city, model) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&models=${model}&forecast_days=2&timezone=Europe%2FPrague`;
  try {
    const r = await tFetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.error || !j.hourly || !Array.isArray(j.hourly.time) || !Array.isArray(j.hourly.temperature_2m)) return null;
    const today = getDateString(0);
    const day = Array(24).fill(null);
    let any = false;
    for (let i = 0; i < j.hourly.time.length; i++) {
      const t = j.hourly.time[i];
      if (typeof t !== 'string' || t.slice(0, 10) !== today) continue;
      const hh = parseInt(t.slice(11, 13), 10);
      const v = j.hourly.temperature_2m[i];
      if (typeof v === 'number' && !Number.isNaN(v) && hh >= 0 && hh <= 23) { day[hh] = v; any = true; }
    }
    return any ? day : null;
  } catch (e) {
    console.log(`Model ${model} cross-check fetch failed for ${city.name}:`, e.message);
    return null;
  }
}

// Fetch MET Norway (a fully independent provider) today temps as a 24-slot array.
async function fetchMetno(city) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${city.lat}&lon=${city.lon}`;
  try {
    const r = await tFetch(url, { headers: { 'User-Agent': CROSSCHECK.METNO_UA, 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const series = j && j.properties && j.properties.timeseries;
    if (!Array.isArray(series)) return null;
    const today = getDateString(0);
    const day = Array(24).fill(null);
    let any = false;
    for (const pt of series) {
      const temp = pt && pt.data && pt.data.instant && pt.data.instant.details
        ? pt.data.instant.details.air_temperature : null;
      if (typeof temp !== 'number' || Number.isNaN(temp)) continue;
      const hh = localHourIndex(pt.time, APP_TIMEZONE, today);
      if (hh === null) continue;
      day[hh] = temp; any = true;
    }
    return any ? day : null;
  } catch (e) {
    console.log(`MET Norway cross-check fetch failed for ${city.name}:`, e.message);
    return null;
  }
}

const crossCheckCache = {};

// Cross-check one city's shown "today" values against the independent sources.
async function crossCheckCity(city) {
  const cached = crossCheckCache[city.name];
  if (cached && (Date.now() - cached.ts) < CROSSCHECK.CACHE_MS) return cached.result;

  // Primary = what the app actually shows for today (best_match), from cache.
  let weather = await getCachedWeather(city.name);
  if (!weather) {
    const fresh = await fetchWeatherFromAPI(city);
    if (fresh) { await cacheWeatherData(city.name, fresh); weather = { data: fresh }; }
  }
  const primary = (weather && weather.data && weather.data.today && Array.isArray(weather.data.today.temps))
    ? weather.data.today.temps : Array(24).fill(null);

  // Gather independent sources in parallel; any failure just drops that source.
  const jobs = CROSSCHECK.MODELS.map(m => fetchModelTemps(city, m).then(day => ({ label: modelLabel(m), day })));
  jobs.push(fetchMetno(city).then(day => ({ label: 'MET Norway', day })));
  const results = await Promise.all(jobs);

  const sources = {};
  for (const { label, day } of results) if (day && !sources[label]) sources[label] = day;

  const analysis = analyzeCrossCheck(primary, sources, CROSSCHECK);
  const result = {
    city: city.name,
    generatedAt: new Date().toISOString(),
    timezone: APP_TIMEZONE,
    deviationLimit: CROSSCHECK.DEVIATION_C,
    consensusSpreadLimit: CROSSCHECK.CONSENSUS_SPREAD_C,
    consensusMinSources: CROSSCHECK.CONSENSUS_MIN_SOURCES,
    ...analysis,
    status: analysis.sourceCount === 0 ? 'unavailable'
          : analysis.correctedHours.length ? 'corrected'
          : (analysis.suspectHours.length ? 'warning' : 'ok')
  };
  crossCheckCache[city.name] = { result, ts: Date.now() };
  return result;
}

// ---------------------------------------------------------------------------
// LIVE snapshot
//
// "Right now" conditions for a city plus whether each metric is higher or lower
// than the same hour yesterday. Current values come from Open-Meteo's `current`
// block; "yesterday" is the matching hour from the hourly series (past_days=1).
// parseLive is pure/testable and never invents data — missing values stay null.
// ---------------------------------------------------------------------------

const LIVE_CACHE_MS = 10 * 60 * 1000; // 10 minutes
const liveCache = {};

// Direction of change vs yesterday, with a small dead-band so tiny wiggles read
// as "flat".
function liveDir(delta, eps) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'flat';
  if (delta > eps) return 'up';
  if (delta < -eps) return 'down';
  return 'flat';
}

// Pure: turn a raw Open-Meteo response into the LIVE structure. No network.
function parseLive(raw) {
  if (!raw || !raw.current) return null;
  const cur = raw.current;
  const h = raw.hourly || {};
  const times = Array.isArray(h.time) ? h.time : [];
  const idx = {};
  for (let i = 0; i < times.length; i++) idx[times[i]] = i;

  // Find the "same hour yesterday" key from the current timestamp.
  let yKey = null;
  const curTime = typeof cur.time === 'string' ? cur.time : null;
  if (curTime && curTime.length >= 13) {
    const [y, m, d] = curTime.slice(0, 10).split('-').map(Number);
    const hh = curTime.slice(11, 13);
    const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    anchor.setUTCDate(anchor.getUTCDate() - 1);
    yKey = `${anchor.toISOString().slice(0, 10)}T${hh}:00`;
  }
  const yi = (yKey !== null && idx[yKey] !== undefined) ? idx[yKey] : null;
  const num = v => (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  const yVal = arr => (yi !== null && Array.isArray(arr)) ? num(arr[yi]) : null;

  const metric = (nowRaw, ydayRaw, eps) => {
    const now = num(nowRaw), yday = num(ydayRaw);
    const delta = (now !== null && yday !== null) ? +(now - yday).toFixed(2) : null;
    return { value: now, yesterday: yday, delta, dir: liveDir(delta, eps) };
  };

  const code = num(cur.weather_code);
  // Compare like with like: the hourly series is pressure_msl, so only compute
  // a yesterday-delta when "now" is also MSL. If we have to fall back to
  // surface_pressure (a different quantity, ~30-45 hPa lower at these cities'
  // altitudes), show the value but no comparison.
  const usingMsl = num(cur.pressure_msl) !== null;
  const pressureNow = usingMsl ? cur.pressure_msl : cur.surface_pressure;
  const pressureYday = usingMsl ? yVal(h.pressure_msl) : null;
  return {
    time: curTime,
    yesterdayTime: yi !== null ? yKey : null,
    temperature: { ...metric(cur.temperature_2m, yVal(h.temperature_2m), 0.1), unit: '°C' },
    wind: { ...metric(cur.wind_speed_10m, yVal(h.wind_speed_10m), 0.5),
            gust: num(cur.wind_gusts_10m), unit: 'km/h' },
    rain: { ...metric(cur.precipitation, yVal(h.precipitation), 0.05),
            weatherCode: code, weather: describeWeather(code), storm: isStormCode(code), unit: 'mm' },
    pressure: { ...metric(pressureNow, pressureYday, 0.3), unit: 'hPa' }
  };
}

async function fetchLive(city) {
  const cached = liveCache[city.name];
  if (cached && (Date.now() - cached.ts) < LIVE_CACHE_MS) return cached.result;

  try {
  const current = 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,pressure_msl,surface_pressure';
  const hourly = 'temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,pressure_msl';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=${current}&hourly=${hourly}&past_days=1&forecast_days=1&timezone=Europe%2FPrague`;

  const r = await tFetch(url);
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const raw = await r.json();
  if (raw.error) throw new Error(`Open-Meteo: ${raw.reason || 'error'}`);

  const parsed = parseLive(raw);
  if (!parsed) throw new Error('No current data in response');
  const result = { city: city.name, generatedAt: new Date().toISOString(), timezone: APP_TIMEZONE, ...parsed };
  liveCache[city.name] = { result, ts: Date.now() };
  return result;
  } catch (err) {
    if (cached) {
      console.warn(`Live fetch failed for ${city.name} — serving stale:`, err.message);
      return cached.result;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Market brief (CZ / HU)
//
// Turns raw weather into the power-market fundamentals a trader actually acts
// on, per country, for Yesterday (context) / Today / Tomorrow / D+2:
//   - Demand:  population-weighted temperature across the country's cities,
//              expressed as heating/cooling degree days (HDD base 18 °C,
//              CDD base 21 °C).
//   - Solar:   daily shortwave radiation total, normalised 0-100 % against a
//              clear-sky-ish monthly maximum (a *display index*, not a
//              generation forecast).
//   - Wind:    hourly hub-height (120 m) wind speeds pushed through a
//              simplified turbine power curve (cut-in 11, rated 43, cut-out
//              90 km/h), averaged into a 0-100 % index.
//   - Risks:   storms, cut-out-level gusts, morning fog, snow, heat, frost,
//              heavy rain — anything that jolts load or generation.
// Everything numeric comes straight from Open-Meteo; the indexes are
// documented normalisations of it. Pure functions (parseMarketCity,
// buildMarketBrief, windPowerIndex, solarIndex, degreeDays) are exported for
// unit tests. Fundamentals only — this is not price advice.
// ---------------------------------------------------------------------------

const MARKET = {
  CACHE_MS: 30 * 60 * 1000,
  HDD_BASE: 18,   // °C — below this daily mean, heating demand grows
  CDD_BASE: 21,   // °C — above this daily mean, cooling (AC) demand grows
  // Approximate clear-sky daily shortwave totals (MJ/m²/day) at ~47-50°N by
  // month (Jan..Dec). Used ONLY to normalise the solar index for display.
  SOLAR_MAX_BY_MONTH: [6, 10, 16, 22, 27, 29, 28, 24, 18, 11, 7, 5],
  // Simplified turbine power curve at hub height, in km/h: zero below CUT_IN,
  // cubic ramp to RATED, flat 100 % until CUT_OUT, zero above (storm stop).
  WIND: { CUT_IN: 11, RATED: 43, CUT_OUT: 90 },
  // Population-based weights (millions, rough) — proxies for national demand.
  COUNTRIES: {
    CZ: {
      name: 'Czechia', tz: 'Europe/Prague',
      cities: [ { name: 'Prague', weight: 1.30 }, { name: 'Brno', weight: 0.40 },
                { name: 'Plzen', weight: 0.18 }, { name: 'Ostrava', weight: 0.28 } ]
    },
    HU: {
      name: 'Hungary', tz: 'Europe/Budapest',
      cities: [ { name: 'Budapest', weight: 1.75 }, { name: 'Debrecen', weight: 0.20 } ]
    }
  }
};

const MARKET_LABELS = ['Yesterday', 'Today', 'Tomorrow', 'D+2'];

// 0..1 output of a simplified turbine for one hub-height speed (km/h).
function windPowerAt(kmh, w = MARKET.WIND) {
  if (typeof kmh !== 'number' || Number.isNaN(kmh)) return null;
  if (kmh < w.CUT_IN || kmh >= w.CUT_OUT) return 0;
  if (kmh >= w.RATED) return 1;
  const x = (kmh ** 3 - w.CUT_IN ** 3) / (w.RATED ** 3 - w.CUT_IN ** 3);
  return Math.min(1, Math.max(0, x));
}

// Mean 0..1 power index across a day's hourly hub-height speeds.
function windPowerIndex(speeds, w = MARKET.WIND) {
  if (!Array.isArray(speeds)) return null;
  let sum = 0, n = 0;
  for (const s of speeds) {
    const p = windPowerAt(s, w);
    if (p !== null) { sum += p; n++; }
  }
  return n ? sum / n : null;
}

// 0..1 solar index: daily radiation total vs the clear-sky-ish monthly max.
function solarIndex(radSumMJ, monthIndex0, cfg = MARKET) {
  if (typeof radSumMJ !== 'number' || Number.isNaN(radSumMJ)) return null;
  const max = cfg.SOLAR_MAX_BY_MONTH[monthIndex0] || 20;
  return Math.min(1, Math.max(0, radSumMJ / max));
}

// Heating / cooling degree days from daily max+min (simple mean method).
function degreeDays(tmax, tmin, cfg = MARKET) {
  if (typeof tmax !== 'number' || typeof tmin !== 'number' ||
      Number.isNaN(tmax) || Number.isNaN(tmin)) {
    return { mean: null, hdd: null, cdd: null };
  }
  const mean = (tmax + tmin) / 2;
  return {
    mean: +mean.toFixed(1),
    hdd: Math.max(0, +(cfg.HDD_BASE - mean).toFixed(1)),
    cdd: Math.max(0, +(mean - cfg.CDD_BASE).toFixed(1))
  };
}

// Pure: one city's Open-Meteo response -> per-day market metrics. No network.
function parseMarketCity(raw, cfg = MARKET) {
  if (!raw || !raw.daily || !Array.isArray(raw.daily.time)) return [];
  const h = raw.hourly || {};
  const hTime = Array.isArray(h.time) ? h.time : [];
  const num = v => (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  const dnum = (arr, i) => Array.isArray(arr) ? num(arr[i]) : null;

  const days = [];
  for (let di = 0; di < raw.daily.time.length; di++) {
    const date = raw.daily.time[di];
    const winds = [];
    let stormy = false, fogMorning = false, snow = false, cloudSum = 0, cloudN = 0;
    for (let i = 0; i < hTime.length; i++) {
      if (typeof hTime[i] !== 'string' || hTime[i].slice(0, 10) !== date) continue;
      const hr = parseInt(hTime[i].slice(11, 13), 10);
      const w = num(Array.isArray(h.wind_speed_120m) ? h.wind_speed_120m[i] : null);
      if (w !== null) winds.push(w);
      const code = num(Array.isArray(h.weather_code) ? h.weather_code[i] : null);
      if (code !== null) {
        if (isStormCode(code)) stormy = true;
        if ((code === 45 || code === 48) && hr >= 5 && hr <= 10) fogMorning = true;
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) snow = true;
      }
      if (hr >= 9 && hr <= 17) {
        const c = num(Array.isArray(h.cloud_cover) ? h.cloud_cover[i] : null);
        if (c !== null) { cloudSum += c; cloudN++; }
      }
    }
    const tmax = dnum(raw.daily.temperature_2m_max, di);
    const tmin = dnum(raw.daily.temperature_2m_min, di);
    const radSum = dnum(raw.daily.shortwave_radiation_sum, di);
    const monthIdx = parseInt(String(date).slice(5, 7), 10) - 1;
    days.push({
      date, tmax, tmin,
      dd: degreeDays(tmax, tmin, cfg),
      radSum,
      solarIdx: solarIndex(radSum, monthIdx, cfg),
      windMean: winds.length ? winds.reduce((a, b) => a + b, 0) / winds.length : null,
      windIdx: windPowerIndex(winds, cfg.WIND),
      gustMax: dnum(raw.daily.wind_gusts_10m_max, di),
      precipSum: dnum(raw.daily.precipitation_sum, di),
      cloudDaytimePct: cloudN ? Math.round(cloudSum / cloudN) : null,
      stormy, fogMorning, snow
    });
  }
  return days;
}

// Signal direction from a change in an index (percentage points) or degree days.
function signalDir(delta, upAt, downAt) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return null;
  if (delta >= upAt) return 'up';
  if (delta <= downAt) return 'down';
  return 'flat';
}

// Pure: merge per-city days into one weighted country brief. No network.
//   perCity: [{ city, weight, days: parseMarketCity() output }]
function buildMarketBrief(countryCode, perCity, cfg = MARKET) {
  const country = cfg.COUNTRIES[countryCode];
  const valid = (perCity || []).filter(c => Array.isArray(c.days) && c.days.length);
  if (!country || !valid.length) return null;
  const nDays = Math.min(4, ...valid.map(c => c.days.length));

  // Weighted average of one numeric field across cities for day index di.
  const wAvg = (di, getter) => {
    let sum = 0, w = 0;
    for (const c of valid) {
      const v = getter(c.days[di]);
      if (typeof v === 'number' && !Number.isNaN(v)) { sum += v * c.weight; w += c.weight; }
    }
    return w > 0 ? sum / w : null;
  };
  const anyCity = (di, getter) => valid.filter(c => getter(c.days[di])).map(c => c.city);
  const round1 = v => (v === null ? null : +v.toFixed(1));
  const pct = v => (v === null ? null : Math.round(v * 100));

  const days = [];
  for (let di = 0; di < nDays; di++) {
    const dd = { hdd: round1(wAvg(di, d => d.dd.hdd)), cdd: round1(wAvg(di, d => d.dd.cdd)) };
    const risks = [];
    const stormCities = anyCity(di, d => d.stormy);
    if (stormCities.length) risks.push(`⛈ Thunderstorms (${stormCities.join(', ')})`);
    const gust = Math.max(...valid.map(c => c.days[di].gustMax ?? -Infinity));
    if (gust >= cfg.WIND.CUT_OUT) risks.push(`🌪 Gusts ${Math.round(gust)} km/h — turbine cut-out risk`);
    else if (gust >= 70) risks.push(`💨 Strong gusts ${Math.round(gust)} km/h`);
    if (anyCity(di, d => d.fogMorning).length) risks.push('🌫 Morning fog — late solar ramp');
    if (anyCity(di, d => d.snow).length) risks.push('❄ Snow — PV soiling / load risk');
    const tmax = round1(wAvg(di, d => d.tmax));
    const tmin = round1(wAvg(di, d => d.tmin));
    if (tmax !== null && tmax >= 30) risks.push(`🔥 Heat ${Math.round(tmax)}° — AC load, thermal derating`);
    if (tmin !== null && tmin <= 0) risks.push(`🧊 Frost ${Math.round(tmin)}° — heating load`);
    const precip = round1(wAvg(di, d => d.precipSum));
    if (precip !== null && precip >= 15) risks.push(`🌧 Heavy rain ${Math.round(precip)} mm`);

    days.push({
      label: MARKET_LABELS[di] || `D+${di - 1}`,
      date: valid[0].days[di].date,
      context: di === 0, // yesterday: context only
      tempMax: tmax, tempMin: tmin,
      hdd: dd.hdd, cdd: dd.cdd,
      solar: { sumMJ: round1(wAvg(di, d => d.radSum)),
               index: pct(wAvg(di, d => d.solarIdx)),
               cloudPct: Math.round(wAvg(di, d => d.cloudDaytimePct) ?? -1) >= 0
                 ? Math.round(wAvg(di, d => d.cloudDaytimePct)) : null },
      wind: { meanKmh: round1(wAvg(di, d => d.windMean)),
              index: pct(wAvg(di, d => d.windIdx)),
              gustMax: Number.isFinite(gust) ? Math.round(gust) : null },
      risks,
      signals: {}, headline: ''
    });
  }

  // Day-over-day signals + plain-language headline (skip the context day).
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1], day = days[i];
    const sDelta = (day.solar.index !== null && prev.solar.index !== null)
      ? day.solar.index - prev.solar.index : null;
    const wDelta = (day.wind.index !== null && prev.wind.index !== null)
      ? day.wind.index - prev.wind.index : null;
    const ddNow = (day.hdd ?? 0) + (day.cdd ?? 0);
    const ddPrev = (prev.hdd ?? 0) + (prev.cdd ?? 0);
    const dDelta = (day.hdd === null && day.cdd === null) ? null : +(ddNow - ddPrev).toFixed(1);

    day.signals = {
      solar: signalDir(sDelta, 10, -10),
      wind: signalDir(wDelta, 10, -10),
      demand: signalDir(dDelta, 1.5, -1.5)
    };

    const bits = [];
    if (sDelta !== null) {
      bits.push(sDelta >= 10 ? `solar stronger (+${sDelta}pp)`
        : sDelta <= -10 ? `solar weaker (${sDelta}pp)` : 'solar similar');
    }
    if (wDelta !== null) {
      bits.push(wDelta >= 10 ? `wind up (+${wDelta}pp)`
        : wDelta <= -10 ? `wind down (${wDelta}pp)` : 'wind similar');
    }
    if (dDelta !== null) {
      const kind = (day.cdd ?? 0) > (day.hdd ?? 0) ? 'cooling' : 'heating';
      bits.push(dDelta >= 1.5 ? `${kind} demand rising`
        : dDelta <= -1.5 ? `${kind} demand easing` : 'demand steady');
    }
    day.headline = bits.length
      ? bits.join(', ').replace(/^./, ch => ch.toUpperCase()) + '.'
      : '';

    // Net residual-load direction (renewable supply vs temperature demand).
    const renew = (sDelta ?? 0) + (wDelta ?? 0);
    if (sDelta === null && wDelta === null) day.net = '';
    else if (renew >= 10 && (dDelta ?? 0) <= 0) day.net = 'More renewables into flat/lower demand → softer residual load.';
    else if (renew <= -10 && (dDelta ?? 0) >= 0) day.net = 'Less sun/wind while demand holds/climbs → tighter residual load.';
    else if (renew >= 10 && (dDelta ?? 0) > 1.5) day.net = 'Both renewables and demand up — watch the evening ramp.';
    else if (renew <= -10 && (dDelta ?? 0) < -1.5) day.net = 'Renewables and demand both easing — direction unclear.';
    else day.net = 'No big shift in fundamentals vs the previous day.';
  }

  return {
    country: countryCode,
    name: country.name,
    timezone: country.tz,
    cities: valid.map(c => `${c.city} (${c.weight})`),
    days
  };
}

// Fetch one city's raw market data (single Open-Meteo call).
async function fetchMarketCity(city, tz) {
  const hourly = 'temperature_2m,cloud_cover,shortwave_radiation,wind_speed_120m,precipitation,weather_code';
  const daily = 'temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,precipitation_sum,wind_gusts_10m_max,sunshine_duration,weather_code';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=${hourly}&daily=${daily}&past_days=1&forecast_days=3&timezone=${encodeURIComponent(tz)}&wind_speed_unit=kmh`;
  const r = await tFetch(url);
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const raw = await r.json();
  if (raw.error) throw new Error(`Open-Meteo: ${raw.reason || 'error'}`);
  return parseMarketCity(raw);
}

const marketCache = {};

async function marketBrief(countryCode) {
  const cached = marketCache[countryCode];
  if (cached && (Date.now() - cached.ts) < MARKET.CACHE_MS) return cached.result;

  const country = MARKET.COUNTRIES[countryCode];
  if (!country) throw new Error(`Unknown country ${countryCode}`);

  // Any single city failing just drops out of the weighted average.
  const perCity = await Promise.all(country.cities.map(cc => {
    const city = cities.find(c => c.name === cc.name);
    if (!city) return { city: cc.name, weight: cc.weight, days: [] };
    return fetchMarketCity(city, country.tz)
      .then(days => ({ city: cc.name, weight: cc.weight, days }))
      .catch(err => {
        console.log(`Market fetch failed for ${cc.name}:`, err.message);
        return { city: cc.name, weight: cc.weight, days: [] };
      });
  }));

  const brief = buildMarketBrief(countryCode, perCity, MARKET);
  if (!brief) {
    if (cached) {
      console.warn(`Market brief failed for ${countryCode} — serving stale`);
      return cached.result;
    }
    throw new Error('No market data from any city');
  }
  const result = { generatedAt: new Date().toISOString(), ...brief };
  marketCache[countryCode] = { result, ts: Date.now() };
  return result;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes

// Get list of cities
app.get('/api/cities', (req, res) => {
  res.json(cities.map(c => c.name));
});

// Get weather data for a city.
// ?source=median -> per-hour median across all implemented sources (Graphs
// tab "Global median"); anything else -> canonical best_match (DB cache).
app.get('/api/weather/:city', async (req, res) => {
  const cityName = req.params.city;

  // Check if city exists
  const city = cities.find(c => c.name === cityName);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
  }

  if (req.query.source === 'median') {
    const entry = await getMedianWeather(city);
    if (entry) return res.json(entry.data);
    return res.status(500).json({ error: 'Could not fetch median weather data' });
  }

  // Try to get cached data first
  let cached = await getCachedWeather(cityName);

  // If no cache or cache is older than 1 hour, fetch fresh data
  if (!cached || (Date.now() - new Date(cached.updatedAt).getTime()) > 3600000) {
    console.log(`Fetching fresh data for ${cityName}...`);
    const freshData = await fetchWeatherFromAPI(city);
    if (freshData) {
      await cacheWeatherData(cityName, freshData);
      cached = { data: freshData, updatedAt: new Date() };
    }
  }

  if (cached) {
    res.json(cached.data);
  } else {
    res.status(500).json({ error: 'Could not fetch weather data' });
  }
});

// Manual trigger to fetch data for all cities
app.post('/api/fetch', async (req, res) => {
  try {
    await fetchAllCities();
    res.json({ success: true, message: 'Weather data fetched for all cities' });
  } catch (err) {
    console.error('Error in manual fetch:', err);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// Get status
app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT city_name, updated_at FROM weather_cache ORDER BY city_name
    `);
    res.json({
      cities: result.rows,
      totalCities: cities.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Verify the downloaded data for a city
app.get('/api/verify/:city', async (req, res) => {
  const city = cities.find(c => c.name === req.params.city);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
  }
  try {
    res.json(await verifyCity(city));
  } catch (err) {
    console.error(`Verify failed for ${req.params.city}:`, err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// 6-day preparation overview for a capital city (Prague = CZ, Budapest = HU)
app.get('/api/preparation/:city', async (req, res) => {
  const city = cities.find(c => c.name === req.params.city);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
  }
  try {
    res.json(await fetchPreparation(city));
  } catch (err) {
    console.error(`Preparation failed for ${req.params.city}:`, err.message);
    res.status(500).json({ error: 'Could not build preparation overview' });
  }
});

// Live "right now" snapshot for a city (+ direction vs same hour yesterday)
app.get('/api/live/:city', async (req, res) => {
  const city = cities.find(c => c.name === req.params.city);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
  }
  try {
    res.json(await fetchLive(city));
  } catch (err) {
    console.error(`Live fetch failed for ${req.params.city}:`, err.message);
    res.status(500).json({ error: 'Could not fetch live data' });
  }
});

// Cross-check today's shown values against independent models + MET Norway
app.get('/api/crosscheck/:city', async (req, res) => {
  const city = cities.find(c => c.name === req.params.city);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
  }
  try {
    res.json(await crossCheckCity(city));
  } catch (err) {
    console.error(`Cross-check failed for ${req.params.city}:`, err.message);
    res.status(500).json({ error: 'Cross-check failed' });
  }
});

// Market brief for a country (CZ or HU): demand / solar / wind / risks per day
app.get('/api/market/:country', async (req, res) => {
  const code = String(req.params.country || '').toUpperCase();
  if (!MARKET.COUNTRIES[code]) {
    return res.status(404).json({ error: 'Unknown country — use CZ or HU' });
  }
  try {
    res.json(await marketBrief(code));
  } catch (err) {
    console.error(`Market brief failed for ${code}:`, err.message);
    res.status(500).json({ error: 'Could not build market brief' });
  }
});

// ---------------------------------------------------------------------------
// History (📖 History tab)
//
// Actual past temperatures for one city and one ISO week (Mon–Sun) of the
// current ISO year, hour by hour: 24 rows × 7 day columns. Two source modes:
//   - "openmeteo": Open-Meteo's default best_match model only
//   - "median":    per-hour median across every implemented source
//                  (ECMWF, DWD ICON, NOAA GFS, Météo-France, MET Norway,
//                   Open-Meteo best_match)
// Finished weeks come from Open-Meteo's Historical Forecast archive; weeks
// touching the last few days use the forecast endpoint's past_days instead
// (the archive lags roughly a day behind). Like the cross-check, models are
// fetched ONE PER CALL so the response is always plain `temperature_2m`, and
// any model with no coverage for a location is skipped instead of failing the
// whole request (MET Norway's Nordic domain does not reach CZ/HU — the
// response's `sources` list shows what actually contributed). Hours that have
// not happened yet are filled from the models' FORECASTS (up to ~16 days out;
// the week dropdown goes to current+2), and the response's `cutoff` marks the
// past/future boundary so the UI can render forecast cells visibly differently.
// The date/median/table helpers below are pure and exported for unit tests.
// ---------------------------------------------------------------------------

const HISTORY = {
  SOURCES: [
    { id: 'best_match',           label: 'Open-Meteo' },
    { id: 'ecmwf_ifs025',         label: 'ECMWF' },
    { id: 'icon_seamless',        label: 'DWD ICON' },
    { id: 'gfs_seamless',         label: 'NOAA GFS' },
    { id: 'meteofrance_seamless', label: 'Météo-France' },
    // MET Norway's Nordic model has no coverage for these cities and its own
    // API has no history — requesting it only wasted rate-limit budget.
  ],
  ARCHIVE_URL: 'https://historical-forecast-api.open-meteo.com/v1/forecast',
  FORECAST_URL: 'https://api.open-meteo.com/v1/forecast',
  ARCHIVE_LAG_DAYS: 3,                // archive may miss the newest days
  FUTURE_WEEKS: 2,                    // week dropdown reaches current + this
  CACHE_MS_PAST: 6 * 60 * 60 * 1000,  // finished weeks barely change
  CACHE_MS_CURRENT: 15 * 60 * 1000,   // current week fills in as hours pass
};

// ---- pure date helpers (ISO-8601 weeks, Monday-first) ----------------------

// 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD' (UTC math, DST-proof).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Whole days from a to b ('YYYY-MM-DD' each); positive when b is later.
function daysBetween(a, b) {
  const toUTC = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

// ISO week number + ISO week-year for a 'YYYY-MM-DD' date.
function isoWeekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7;      // 0 = Monday … 6 = Sunday
  dt.setUTCDate(dt.getUTCDate() - dow + 3);  // this week's Thursday
  const year = dt.getUTCFullYear();          // ISO week-year
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Mon = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const week = 1 + Math.round(((dt - week1Mon) / 86400000 - 3) / 7);
  return { year, week };
}

// The 7 dates (Mon..Sun) of ISO week `week` in ISO week-year `year`.
function isoWeekDates(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4)); // Jan 4 is always in ISO week 1
  const week1Mon = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(week1Mon.getTime() + ((week - 1) * 7 + i) * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Median of the numeric entries of an array; null when none.
function medianOf(values) {
  const nums = (values || []).filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// Current local 'YYYY-MM-DD' + hour (0-23) in timezone `tz`.
function nowInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value;
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // some ICU builds report midnight as 24
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: hh };
}

// Pure: assemble the 24×7 matrix from per-source hourly maps.
//   perSource: [{ id, label, values: { 'YYYY-MM-DDTHH:00': number } }]
//   days:      the week's 7 'YYYY-MM-DD' dates (Mon..Sun)
//   mode:      'openmeteo' (best_match only) | 'median' (all sources)
// Fills every hour a source can supply — including future (forecast) hours;
// the caller reports the past/future boundary separately (`cutoff`).
// Returns { temps: (number|null)[24][7], sources: [{ id, label, hours }] }
// where `hours` counts the cells that source supplied.
function buildHistoryTable(perSource, days, mode) {
  const list = (perSource || []).filter(s => s && s.values);
  const used = mode === 'median' ? list : list.filter(s => s.id === 'best_match');

  const counts = {};
  const temps = [];
  for (let h = 0; h < 24; h++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      const date = days[d];
      const key = `${date}T${String(h).padStart(2, '0')}:00`;
      const vals = [];
      for (const s of used) {
        const v = s.values[key];
        if (typeof v === 'number' && !Number.isNaN(v)) {
          vals.push(v);
          counts[s.id] = (counts[s.id] || 0) + 1;
        }
      }
      row.push(mode === 'median' ? medianOf(vals) : (vals.length ? vals[0] : null));
    }
    temps.push(row);
  }
  const sources = used
    .filter(s => counts[s.id] > 0)
    .map(s => ({ id: s.id, label: s.label, hours: counts[s.id] }));
  return { temps, sources };
}

// ---- fetching ---------------------------------------------------------------

// All requested models in ONE call (rate-limit friendly — v1.4.0's
// one-call-per-model version tripped Open-Meteo's limits). With several
// models the response suffixes each variable (temperature_2m_<model>);
// with one it stays plain. A model the location does not support simply
// has no array — skipped, never fatal.
async function fetchHistoryBatch(city, ids, days, tz, recentDays, forecastDays) {
  const base = `latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m` +
               `&models=${ids.join(',')}&timezone=${encodeURIComponent(tz)}`;
  const url = (recentDays === null)
    ? `${HISTORY.ARCHIVE_URL}?${base}&start_date=${days[0]}&end_date=${days[6]}`
    : `${HISTORY.FORECAST_URL}?${base}&past_days=${recentDays}&forecast_days=${forecastDays}`;
  const r = await tFetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const raw = await r.json();
  if (raw.error) throw new Error(raw.reason || 'API error');
  const h = raw.hourly || {};
  const time = Array.isArray(h.time) ? h.time : [];
  const out = [];
  for (const id of ids) {
    const arr = Array.isArray(h[`temperature_2m_${id}`]) ? h[`temperature_2m_${id}`]
              : (ids.length === 1 && Array.isArray(h.temperature_2m) ? h.temperature_2m : null);
    if (!arr) continue;
    const values = {};
    for (let i = 0; i < time.length; i++) {
      const v = arr[i];
      if (typeof v === 'number' && !Number.isNaN(v)) values[time[i]] = v;
    }
    const meta = HISTORY.SOURCES.find(s => s.id === id);
    out.push({ id, label: meta ? meta.label : id, values });
  }
  return out;
}

const historyCache = {};

async function fetchHistory(city, week, source) {
  const tz = PREP_TZ[city.name] || APP_TIMEZONE;
  const now = nowInTz(tz);
  const { year } = isoWeekOf(now.date);
  const days = isoWeekDates(year, week);

  const cacheKey = `${city.name}|${days[0]}|${source}`;
  const ttl = days[6] < now.date ? HISTORY.CACHE_MS_PAST : HISTORY.CACHE_MS_CURRENT;
  const cached = historyCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < ttl) return cached.result;

  // Finished long enough ago -> stable archive; otherwise the forecast
  // endpoint with past_days for the elapsed part and forecast_days through
  // the end of the requested week (Open-Meteo caps forecasts at 16 days, so
  // the far end of week current+2 may stay blank).
  const useArchive = daysBetween(days[6], now.date) > HISTORY.ARCHIVE_LAG_DAYS;
  const recentDays = useArchive ? null
    : Math.min(92, Math.max(0, daysBetween(days[0], now.date)));
  const forecastDays = useArchive ? 1
    : Math.min(16, Math.max(1, daysBetween(now.date, days[6]) + 1));

  const ids = (source === 'median' ? HISTORY.SOURCES : HISTORY.SOURCES.filter(s => s.id === 'best_match'))
    .map(s => s.id);
  try {
  const perSource = await fetchHistoryBatch(city, ids, days, tz, recentDays, forecastDays);
  if (!perSource.length) throw new Error('No history source responded');

  const { temps, sources } = buildHistoryTable(perSource, days, source);

  const result = {
    city: city.name,
    year, week, start: days[0], end: days[6], days,
    source,
    sources,
    cutoff: now, // past/future boundary — cells after this are forecasts
    endpoint: useArchive ? 'historical-forecast archive' : 'forecast past_days',
    units: { temp: '°C' },
    generatedAt: new Date().toISOString(),
    temps
  };
  historyCache[cacheKey] = { result, ts: Date.now() };
  return result;
  } catch (err) {
    // Rate-limited / flaky upstream must not blank the tab — serve the last
    // good table if we have one, however old.
    if (cached) {
      console.warn(`History fetch failed for ${city.name} — serving stale:`, err.message);
      return cached.result;
    }
    throw err;
  }
}

// Historical hour-by-hour temperatures for one ISO week (📖 History tab)
app.get('/api/history/:city', async (req, res) => {
  const city = cities.find(c => c.name === req.params.city);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
  }
  const source = String(req.query.source || 'openmeteo');
  if (source !== 'openmeteo' && source !== 'median') {
    return res.status(400).json({ error: "source must be 'openmeteo' or 'median'" });
  }
  const tz = PREP_TZ[city.name] || APP_TIMEZONE;
  const cur = isoWeekOf(nowInTz(tz).date);
  const week = parseInt(req.query.week, 10);
  const maxWeek = cur.week + HISTORY.FUTURE_WEEKS;
  if (!Number.isInteger(week) || week < 1 || week > maxWeek) {
    return res.status(400).json({ error: `week must be between 1 and ${maxWeek}` });
  }
  try {
    res.json(await fetchHistory(city, week, source));
  } catch (err) {
    console.error(`History failed for ${req.params.city}:`, err.message);
    res.status(500).json({ error: 'Could not build history' });
  }
});

// Initialize and start. initDB never throws (it degrades to memory-only), so
// the server always comes up even when Postgres is down.
async function start() {
  await initDB();

  // Schedule fetch every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    console.log('Running scheduled weather fetch...');
    await fetchAllCities();
  });

  // Fetch on startup
  console.log('Fetching initial weather data...');
  await fetchAllCities();

  app.listen(PORT, () => {
    console.log(`Weather app running on port ${PORT}`);
  });
}

// Start only when run directly (`node server.js`); when required by a test the
// pure helpers below can be exercised without opening a DB connection or port.
if (require.main === module) {
  start().catch(console.error);
}

module.exports = {
  getDateString, haversineKm, runDataChecks, APP_TIMEZONE, VERIFY,
  parsePreparation, buildNotes, classifyPressure, classifyWind, classifyClouds, describeWeather,
  analyzeCrossCheck, localHourIndex, modelLabel, CROSSCHECK,
  parseLive, liveDir,
  parseMarketCity, buildMarketBrief, windPowerAt, windPowerIndex, solarIndex,
  degreeDays, signalDir, MARKET,
  addDays, daysBetween, isoWeekOf, isoWeekDates, medianOf, nowInTz,
  buildHistoryTable, HISTORY,
  parseWeatherPayload, medianSeries, MEDIAN_MODELS
};
