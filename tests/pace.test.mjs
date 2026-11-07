// Audiobook position (player times → percent) and reading pace (time or pages
// left, and the day the book would finish at the recent rate).

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions } from './extract.mjs';

const P = loadFunctions(['parseHMS', 'audioPosition', 'readingPace', 'paceText', 'minsToHM', 'ddAddDays', 'localDateStr', 'fmtShortDate']);

test('player times parse in the usual shapes', () => {
  assert.equal(P.parseHMS('8:09:43'), 8 * 60 + 9 + 43 / 60);
  assert.equal(P.parseHMS('8:09'), 489);
  assert.equal(P.parseHMS('489'), 489);
  assert.equal(P.parseHMS('8h 9m'), 489);
  assert.equal(P.parseHMS('-3:43:31'), -(3 * 60 + 43 + 31 / 60));
  assert.equal(P.parseHMS('−3:43'), -223, 'a typographic minus counts');
  for (const bad of ['', 'abc', '8:61:00', '1:2:3:4']) assert.equal(P.parseHMS(bad), null, bad);
});

test('position and length → percent; time remaining works too', () => {
  const r = P.audioPosition('8:09:43', '11:53:14');
  assert.equal(r.pct, 68.7);
  assert.equal(Math.round(r.len), 713);
  const left = P.audioPosition('8:09:43', '-3:43:31');
  assert.equal(left.pct, 68.7, 'same answer from the time left');
  assert.equal(P.audioPosition('12:00:00', '11:53:14'), null, 'past the end');
  assert.equal(P.audioPosition('', '11:53:14'), null);
});

const day = (d, type, cur, total) => ({ date: d, type, cur, total });

test('pace: time left from minutes, and a finish date from the last three weeks', () => {
  const entries = [day('2026-11-01', 'audio', 61, 713.23), day('2026-11-03', 'audio', 489.72, 713.23), day('2026-11-04', 'audio', 604.47, 713.23)];
  const p = P.readingPace(entries, '2026-11-04');
  assert.equal(p.left, '1h 49m left');
  assert.equal(p.finish, '2026-11-05', '~181 min/day since Nov 1, 109 min left → tomorrow');
  assert.match(P.paceText(p, '2026-11-04'), /≈ 1h 49m left · on pace for Thu, Nov 5/);
});

test('pace: pages left; no date without movement or history', () => {
  assert.equal(P.readingPace([day('2026-11-01', 'pages', 18, 416)], '2026-11-04').left, '398 pages left');
  assert.equal(P.readingPace([day('2026-11-01', 'pages', 18, 416)], '2026-11-04').finish, null, 'one entry: no rate');
  assert.equal(P.readingPace([day('2026-10-01', 'pages', 10, 400), day('2026-11-01', 'pages', 10, 400)], '2026-11-04').finish, null, 'no movement');
  assert.equal(P.readingPace([], '2026-11-04'), null);
  assert.equal(P.paceText(P.readingPace([day('2026-11-01', 'pages', 400, 400)], '2026-11-04'), '2026-11-04'), '', 'finished: nothing to say');
});

test('pace: an audio percentage uses the book’s known length; paces more than ~4 months out say no date', () => {
  const p = P.readingPace([day('2026-11-01', 'audio', 50, 100)], '2026-11-04', 600);
  assert.equal(p.left, '5h 0m left');
  const slow = P.readingPace([day('2026-10-20', 'pages', 10, 1000), day('2026-11-01', 'pages', 11, 1000)], '2026-11-04');
  assert.equal(slow.finish, null);
  const months = P.readingPace([day('2026-10-20', 'pages', 2, 416), day('2026-11-01', 'pages', 18, 416)], '2026-11-04');
  assert.equal(months.finish, null, 'about 300 days away: no date');
  assert.equal(months.left, '398 pages left');
  const late = P.readingPace([day('2026-10-01', 'pages', 0, 100), day('2026-10-02', 'pages', 90, 100)], '2026-11-04');
  assert.equal(late.finish, '2026-11-04', 'a predicted day already past shows as today');
});
