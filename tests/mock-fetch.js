// Preload that replaces global.fetch with a deterministic Open-Meteo /
// MET Norway mock, so the whole app can be booted and exercised with zero
// network access (build sandboxes cannot reach the real APIs):
//
//   node --require ./tests/mock-fetch.js server.js
//
// Values are synthetic but shaped exactly like the real API responses.
// models=metno_seamless deliberately returns the real API's "no data for
// this location" error, so the History tab's source-skipping path is
// exercised the way it will behave in production for CZ/HU cities.
'use strict';

const TZ = 'Europe/Prague';
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function addDaysStr(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function datesFromQuery(q) {
  if (q.get('start_date') && q.get('end_date')) {
    const out = [];
    let d = q.get('start_date');
    while (d <= q.get('end_date')) { out.push(d); d = addDaysStr(d, 1); }
    return out;
  }
  const past = parseInt(q.get('past_days') || '0', 10);
  const fut = parseInt(q.get('forecast_days') || '7', 10);
  const t = todayStr();
  const out = [];
  for (let i = -past; i < fut; i++) out.push(addDaysStr(t, i));
  return out;
}

// Smooth plausible numbers; they vary by hour/day/model so medians and
// day-over-day colouring are actually testable.
const MODEL_SHIFT = {
  best_match: 0, ecmwf_ifs025: 0.4, icon_seamless: -0.2,
  gfs_seamless: 1.0, meteofrance_seamless: -0.6
};
function valFor(varName, dayIndex, hour, shift) {
  const base = 18 + 6 * Math.sin(((hour - 6) / 24) * 2 * Math.PI) + dayIndex * 0.3 + shift;
  if (varName.startsWith('temperature')) return Math.round(base * 10) / 10;
  if (varName.includes('apparent')) return Math.round(base * 10) / 10;
  if (varName.includes('pressure')) return 1013 + shift;
  if (varName.includes('cloud')) return 40;
  if (varName.includes('wind')) return 20;
  if (varName.includes('radiation')) return (hour >= 8 && hour <= 16) ? 400 : 0;
  if (varName.includes('precipitation') || varName.includes('rain') || varName.includes('showers') || varName.includes('snowfall')) return 0;
  if (varName.includes('weather_code')) return 1;
  if (varName.includes('humidity')) return 60;
  return 1;
}

function openMeteoPayload(u) {
  const q = u.searchParams;
  const modelsParam = q.get('models');
  const models = modelsParam ? modelsParam.split(',') : null;
  if (models && models.length === 1 && models[0] === 'metno_seamless') {
    return { status: 400, body: { error: true, reason: 'No data is available for this location' } };
  }
  const shiftOf = m => (m && MODEL_SHIFT[m] !== undefined) ? MODEL_SHIFT[m] : 0;
  const days = datesFromQuery(q);
  const payload = {
    latitude: Number(q.get('latitude')), longitude: Number(q.get('longitude')),
    timezone: q.get('timezone') || 'GMT', utc_offset_seconds: 7200
  };
  if (q.get('hourly')) {
    const time = [];
    days.forEach(d => { for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, '0')}:00`); });
    payload.hourly = { time };
    q.get('hourly').split(',').forEach(v => {
      if (models && models.length > 1) {
        // Real API: several models -> per-model suffixed arrays; a model
        // without coverage (metno) contributes no array at all.
        models.forEach(m => {
          if (m === 'metno_seamless') return;
          payload.hourly[`${v}_${m}`] = time.map((t, i) => valFor(v, Math.floor(i / 24), i % 24, shiftOf(m)));
        });
      } else {
        payload.hourly[v] = time.map((t, i) => valFor(v, Math.floor(i / 24), i % 24, shiftOf(models ? models[0] : null)));
      }
    });
  }
  if (q.get('daily')) {
    payload.daily = { time: days.slice() };
    q.get('daily').split(',').forEach(v => {
      payload.daily[v] = days.map((d, i) => {
        if (v === 'weather_code') return 1;
        if (v.includes('_max')) return 24 + i * 0.3;
        if (v.includes('_min')) return 12 + i * 0.3;
        if (v.includes('radiation_sum')) return 20;
        if (v.includes('precipitation_sum')) return 0;
        if (v.includes('sunshine')) return 30000;
        return 1;
      });
    });
  }
  if (q.get('current')) {
    payload.current = { time: `${todayStr()}T12:00` };
    q.get('current').split(',').forEach(v => { payload.current[v] = valFor(v, 0, 12, 0); });
  }
  return { status: 200, body: payload };
}

let mockCallCount = 0;
process.on('SIGTERM', () => {
  console.log(`[mock-fetch] total upstream calls: ${mockCallCount}`);
  process.exit(0);
});

global.fetch = async (url) => {
  mockCallCount++;
  const u = new URL(String(url));
  let out;
  if (u.hostname === 'api.met.no') {
    const t = todayStr();
    const timeseries = [];
    for (let h = 0; h < 24; h++) {
      timeseries.push({
        time: `${t}T${String(h).padStart(2, '0')}:00:00Z`,
        data: { instant: { details: { air_temperature: 20 + 0.1 * h } } }
      });
    }
    out = { status: 200, body: { properties: { timeseries } } };
  } else if (u.hostname === 'geocoding-api.open-meteo.com') {
    out = { status: 200, body: { results: [] } };
  } else if (u.hostname.endsWith('open-meteo.com')) {
    out = openMeteoPayload(u);
  } else {
    out = { status: 404, body: { error: true, reason: `unmocked host ${u.hostname}` } };
  }
  return {
    ok: out.status >= 200 && out.status < 300,
    status: out.status,
    json: async () => out.body,
    text: async () => JSON.stringify(out.body)
  };
};
console.log('[mock-fetch] global.fetch replaced — all weather API calls are synthetic');
