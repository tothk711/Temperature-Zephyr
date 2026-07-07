// Offline unit tests — no network, no database. Run with:  npm test
// Covers the v1.3.0 additions (History tab helpers, 6-day / 5-row prep)
// plus the exported pure helpers they build on.
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../server.js');

// ---- ISO week helpers -------------------------------------------------------

test('isoWeekOf: regular dates and year boundaries', () => {
  assert.deepEqual(s.isoWeekOf('2026-07-07'), { year: 2026, week: 28 });
  assert.deepEqual(s.isoWeekOf('2026-01-01'), { year: 2026, week: 1 });
  // ISO oddities: Dec 31 2025 belongs to 2026-W1, Jan 1 2027 to 2026-W53.
  assert.deepEqual(s.isoWeekOf('2025-12-31'), { year: 2026, week: 1 });
  assert.deepEqual(s.isoWeekOf('2027-01-01'), { year: 2026, week: 53 });
});

test('isoWeekDates: Mon..Sun, consistent with isoWeekOf', () => {
  const w28 = s.isoWeekDates(2026, 28);
  assert.equal(w28.length, 7);
  assert.equal(w28[0], '2026-07-06');
  assert.equal(w28[6], '2026-07-12');
  assert.equal(s.isoWeekDates(2026, 1)[0], '2025-12-29');
  for (const d of w28) assert.deepEqual(s.isoWeekOf(d), { year: 2026, week: 28 });
});

test('addDays / daysBetween', () => {
  assert.equal(s.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(s.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(s.daysBetween('2026-07-01', '2026-07-07'), 6);
  assert.equal(s.daysBetween('2026-07-07', '2026-07-01'), -6);
});

// ---- median -----------------------------------------------------------------

test('medianOf: odd, even, junk, empty', () => {
  assert.equal(s.medianOf([3, 1, 2]), 2);
  assert.equal(s.medianOf([1, 2, 3, 10]), 2.5);
  assert.equal(s.medianOf([null, 5, undefined, NaN]), 5);
  assert.equal(s.medianOf([]), null);
  assert.equal(s.medianOf(null), null);
});

// ---- history table assembly -------------------------------------------------

const DAYS = s.isoWeekDates(2026, 28); // 2026-07-06 .. 2026-07-12
const SRC = (id, label, values) => ({ id, label, values });
const PER_SOURCE = [
  SRC('best_match', 'Open-Meteo', { '2026-07-06T00:00': 20, '2026-07-07T05:00': 10 }),
  SRC('ecmwf_ifs025', 'ECMWF',    { '2026-07-06T00:00': 22, '2026-07-07T05:00': 14, '2026-07-09T03:00': 9 }),
];

test('buildHistoryTable: median mode fills everything a source supplies', () => {
  const r = s.buildHistoryTable(PER_SOURCE, DAYS, 'median');
  assert.equal(r.temps.length, 24);
  assert.equal(r.temps[0].length, 7);
  assert.equal(r.temps[0][0], 21);    // median(20, 22)
  assert.equal(r.temps[5][1], 12);    // median(10, 14)
  assert.equal(r.temps[3][3], 9);     // single-source (forecast) hour kept
  assert.equal(r.temps[13][1], null); // no source supplied this hour
  assert.equal(r.sources.length, 2);
  assert.equal(r.sources[1].hours, 3); // ECMWF: all three points counted
});

test('buildHistoryTable: openmeteo mode uses best_match only', () => {
  const r = s.buildHistoryTable(PER_SOURCE, DAYS, 'openmeteo');
  assert.equal(r.temps[0][0], 20);
  assert.equal(r.temps[5][1], 10);
  assert.equal(r.temps[3][3], null);  // ECMWF-only hour ignored in this mode
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].id, 'best_match');
});

test('buildHistoryTable: no sources -> all-null grid', () => {
  const r = s.buildHistoryTable([], DAYS, 'median');
  assert.equal(r.temps.every(row => row.every(v => v === null)), true);
  assert.deepEqual(r.sources, []);
});

// ---- weather payload parsing + median helpers --------------------------------

test('parseWeatherPayload: maps hours to day series incl. previous-run forecast', () => {
  const today = s.getDateString(0), yest = s.getDateString(-1);
  const mk = (d, h) => `${d}T${String(h).padStart(2, '0')}:00`;
  const data = { hourly: { time: [mk(yest, 5), mk(today, 5)], temperature_2m: [10, 20] } };
  const prev = { hourly: { time: [mk(today, 5)], temperature_2m_previous_day1: [17] } };
  const r = s.parseWeatherPayload(data, prev);
  assert.equal(r.yesterday.temps[5], 10);
  assert.equal(r.today.temps[5], 20);
  assert.equal(r.todayForecast.temps[5], 17);
  assert.equal(r.tomorrow.temps[5], null);
});

test('medianSeries: per-timestamp median on the first grid, junk ignored', () => {
  const a = { time: ['t1', 't2', 't3'], values: [10, 20, 30] };
  const b = { time: ['t1', 't2'], values: [14, null] };
  const c = { time: ['t1', 't2', 't3'], values: [12, 26, NaN] };
  const m = s.medianSeries([a, b, c]);
  assert.deepEqual(m.time, ['t1', 't2', 't3']);
  assert.equal(m.values[0], 12);   // median(10, 14, 12)
  assert.equal(m.values[1], 23);   // median(20, 26)
  assert.equal(m.values[2], 30);   // only one real value
});

test('MEDIAN_MODELS covers all six implemented sources', () => {
  assert.deepEqual(s.MEDIAN_MODELS, [
    'best_match', 'ecmwf_ifs025', 'icon_seamless',
    'gfs_seamless', 'meteofrance_seamless', 'metno_seamless'
  ]);
});

test('HISTORY config lists all six implemented sources', () => {
  assert.deepEqual(s.HISTORY.SOURCES.map(x => x.id), [
    'best_match', 'ecmwf_ifs025', 'icon_seamless',
    'gfs_seamless', 'meteofrance_seamless', 'metno_seamless'
  ]);
});

// ---- preparation (6 days, 12:00 / 20:00 rows) --------------------------------

function prepRaw() {
  const days = ['2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13'];
  const time = []; const temps = [];
  days.forEach((d, di) => {
    for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      temps.push(10 + h * 0.5 + di);
    }
  });
  return {
    daily: { time: days, temperature_2m_max: [24, 25, 26, 27, 28, 29, 30], temperature_2m_min: [12, 12, 12, 12, 12, 12, 12] },
    hourly: { time, temperature_2m: temps }
  };
}

test('parsePreparation: caps at 6 days and labels the last D+5', () => {
  const days = s.parsePreparation(prepRaw());
  assert.equal(days.length, 6);
  assert.equal(days[0].label, 'Today');
  assert.equal(days[5].label, 'D+5');
});

test('parsePreparation: exposes 8/12/16/20/0 o\'clock temperatures', () => {
  const d0 = s.parsePreparation(prepRaw())[0];
  assert.equal(d0.temp.h8, 14);    // 10 + 8*0.5
  assert.equal(d0.temp.h12, 16);
  assert.equal(d0.temp.h16, 18);
  assert.equal(d0.temp.h20, 20);
  assert.equal(d0.temp.h0, 10);
});

test('parsePreparation: missing hours stay null (never invented)', () => {
  const raw = { daily: { time: ['2026-07-07'] }, hourly: { time: ['2026-07-07T08:00'], temperature_2m: [15] } };
  const d0 = s.parsePreparation(raw)[0];
  assert.equal(d0.temp.h8, 15);
  assert.equal(d0.temp.h12, null);
  assert.equal(d0.temp.h20, null);
});
