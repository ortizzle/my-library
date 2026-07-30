// Regression tests for the daily page/minute rollup behind the Stats page.
//
// buildDailyMap used to diff each entry against the immediately-preceding array
// element regardless of its kind. Every reading session appends a `nocount`
// marker with cur:0, so the next real page entry was diffed against zero and
// counted its whole page number as pages-read-that-day.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions } from './extract.mjs';

function dailyMap(progressByBook) {
  const { buildDailyMap, setState } = loadFunctions(
    ['buildDailyMap'],
    `let books=[],progressDB={};
     const setState=(b,p)=>{books=b;progressDB=p;};`,
    ['setState']
  );
  setState(Object.keys(progressByBook).map(id => ({ id })), progressByBook);
  return buildDailyMap();
}

test('a nocount marker does not reset the page baseline', () => {
  const map = dailyMap({
    b1: [
      { date: '2026-07-01', type: 'pages', cur: 100, total: 300 },
      { date: '2026-07-01', type: 'nocount', cur: 0, total: 0, note: 'Reading session' },
      { date: '2026-07-02', type: 'pages', cur: 120, total: 300 },
    ]
  });
  assert.equal(map['2026-07-01'].pages, 100, 'first entry counts from zero');
  assert.equal(map['2026-07-02'].pages, 20, 'p.100 -> p.120 is 20 pages, not 120');
});

test('consecutive page entries still diff correctly', () => {
  const map = dailyMap({
    b1: [
      { date: '2026-07-01', type: 'pages', cur: 50, total: 300 },
      { date: '2026-07-02', type: 'pages', cur: 90, total: 300 },
      { date: '2026-07-03', type: 'pages', cur: 140, total: 300 },
    ]
  });
  assert.equal(map['2026-07-02'].pages, 40);
  assert.equal(map['2026-07-03'].pages, 50);
});

test('an audio entry between page entries does not corrupt the page delta', () => {
  const map = dailyMap({
    b1: [
      { date: '2026-07-01', type: 'pages', cur: 100, total: 300 },
      { date: '2026-07-02', type: 'audio', cur: 40, total: 100 },
      { date: '2026-07-03', type: 'pages', cur: 130, total: 300 },
    ]
  });
  assert.equal(map['2026-07-03'].pages, 30);
});

test('going backwards never yields negative pages', () => {
  const map = dailyMap({
    b1: [
      { date: '2026-07-01', type: 'pages', cur: 200, total: 300 },
      { date: '2026-07-02', type: 'pages', cur: 150, total: 300 },
    ]
  });
  assert.equal(map['2026-07-02'].pages, 0);
});

test('nocount entries contribute nothing on their own', () => {
  const map = dailyMap({ b1: [{ date: '2026-07-05', type: 'nocount', cur: 0, total: 0 }] });
  assert.equal(map['2026-07-05'].pages, 0);
  assert.equal(map['2026-07-05'].mins, 0);
});

test('legacy entries without a type are treated as pages', () => {
  const map = dailyMap({
    b1: [
      { date: '2026-07-01', cur: 40, total: 200 },
      { date: '2026-07-02', cur: 70, total: 200 },
    ]
  });
  assert.equal(map['2026-07-02'].pages, 30);
});

test('percent-based audio entries are excluded from minutes', () => {
  const map = dailyMap({ b1: [{ date: '2026-07-01', type: 'audio', cur: 35, total: 100 }] });
  assert.equal(map['2026-07-01'].mins, 0);
});

test('minute-based audio entries diff against the previous minute-based entry', () => {
  const map = dailyMap({
    b1: [
      { date: '2026-07-01', type: 'audio', cur: 30, total: 600 },
      { date: '2026-07-01', type: 'nocount', cur: 0, total: 0 },
      { date: '2026-07-02', type: 'audio', cur: 75, total: 600 },
    ]
  });
  assert.equal(map['2026-07-02'].mins, 45, 'not 75 — the nocount marker is skipped');
});
