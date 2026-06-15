const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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

// Initialize database (simple cache table)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weather_cache (
      id SERIAL PRIMARY KEY,
      city_name VARCHAR(50) NOT NULL UNIQUE,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Database initialized');
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
      fetch(url),
      fetch(previousRunUrl).catch(err => {
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
  } catch (error) {
    console.error(`Error fetching weather for ${city.name}:`, error.message);
    return null;
  }
}

// Store weather data in cache
async function cacheWeatherData(cityName, data) {
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

// Get cached weather data
async function getCachedWeather(cityName) {
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
    return null;
  } catch (err) {
    console.error(`Error getting cached data for ${cityName}:`, err.message);
    return null;
  }
}

// Fetch and cache data for all cities
async function fetchAllCities() {
  console.log('Starting weather data fetch for all cities...');
  
  for (const city of cities) {
    const data = await fetchWeatherFromAPI(city);
    if (data) {
      await cacheWeatherData(city.name, data);
    }
    // Small delay to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // The underlying data just changed, so drop any cached verification results
  // (defined further down) to force a fresh check on the next request.
  if (typeof verifyCache === 'object') {
    Object.keys(verifyCache).forEach(k => delete verifyCache[k]);
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
    const r = await fetch(url);
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
    const r = await fetch(url);
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
// A 5-day "what's coming" table for a capital city (used as the country proxy:
// Prague = CZ, Budapest = HU). Shows temperatures at 08:00/16:00/00:00 plus
// pressure, wind, weather, cloud cover and solar (FVE) potential, with
// auto-generated notes. Every value comes straight from Open-Meteo; anything
// the API does not return is left null and rendered blank — never invented.
// The pure functions (parsePreparation, buildNotes, classify*) are exported so
// they can be unit tested without any network access.
// ---------------------------------------------------------------------------

const PREP_TZ = { Prague: 'Europe/Prague', Budapest: 'Europe/Budapest' };
const PREP_LABELS = ['Today', 'Tomorrow', 'D+2', 'D+3', 'D+4'];

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
  if (hPa < 1005) return 'LOW';
  if (hPa > 1020) return 'HIGH';
  return 'NORMAL';
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
  const nDays = Math.min(raw.daily.time.length, 5);
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
        h16: numAt(h.temperature_2m, `${date}T16:00`),
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

  const tz = PREP_TZ[city.name] || APP_TIMEZONE;
  const hourly = 'temperature_2m,cloud_cover,pressure_msl,wind_gusts_10m,shortwave_radiation,weather_code';
  const daily = 'weather_code,temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,precipitation_sum,wind_gusts_10m_max,sunshine_duration';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=${hourly}&daily=${daily}&forecast_days=5&timezone=${encodeURIComponent(tz)}&wind_speed_unit=kmh`;

  const r = await fetch(url);
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
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes

// Get list of cities
app.get('/api/cities', (req, res) => {
  res.json(cities.map(c => c.name));
});

// Get weather data for a city
app.get('/api/weather/:city', async (req, res) => {
  const cityName = req.params.city;
  
  // Check if city exists
  const city = cities.find(c => c.name === cityName);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
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

// 5-day preparation overview for a capital city (Prague = CZ, Budapest = HU)
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

// Initialize and start
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
  parsePreparation, buildNotes, classifyPressure, classifyWind, classifyClouds, describeWeather
};
