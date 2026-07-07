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
const CUT = { date: '2026-07-07', hour: 12 };

test('buildHistoryTable: median mode', () => {
  const r = s.buildHistoryTable(PER_SOURCE, DAYS, CUT, 'median');
  assert.equal(r.temps.length, 24);
  assert.equal(r.temps[0].length, 7);
  assert.equal(r.temps[0][0], 21);    // median(20, 22)
  assert.equal(r.temps[5][1], 12);    // median(10, 14)
  assert.equal(r.temps[3][3], null);  // Thursday value is after the cutoff
  assert.equal(r.temps[13][1], null); // 13:00 today > cutoff hour 12
  assert.equal(r.sources.length, 2);
  assert.equal(r.sources[1].hours, 2); // ECMWF's Thursday point not counted
});

test('buildHistoryTable: openmeteo mode uses best_match only', () => {
  const r = s.buildHistoryTable(PER_SOURCE, DAYS, CUT, 'openmeteo');
  assert.equal(r.temps[0][0], 20);
  assert.equal(r.temps[5][1], 10);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].id, 'best_match');
});

test('buildHistoryTable: no sources -> all-null grid', () => {
  const r = s.buildHistoryTable([], DAYS, CUT, 'median');
  assert.equal(r.temps.every(row => row.every(v => v === null)), true);
  assert.deepEqual(r.sources, []);
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
