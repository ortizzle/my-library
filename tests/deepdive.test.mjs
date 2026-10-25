// Unit tests for the Daily Deep Dive: which question a day gets, that it's
// the same all day, that it rotates through books and unexplored bubbles,
// that the answer is hidden in the clue, and how the streak counts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctions, extractConst } from './extract.mjs';

const D = loadFunctions(['localDateStr', 'ddHash', 'ddShuffle', 'ddShort', 'ddAddDays', 'ddTypeFor', 'ddMask', 'ddCan',
                         'deepDivePick', 'deepDiveStreak', 'mmStr', 'mmColor', 'normalizeMindmap'],
  `const MM_MOTIFS=${extractConst('MM_MOTIFS')};`);

const cerulean = D.normalizeMindmap(JSON.parse(readFileSync(new URL('./fixtures/cerulean-map.json', import.meta.url), 'utf8')));
const tiny = D.normalizeMindmap({ branches: [{ label: 'People', nodes: [
  { title: 'Ann', remind: 'Ann is the narrator.', q: 'Why Ann?' }, { title: 'Bo', remind: 'Bo is her brother.' }, { title: 'Cy', remind: 'Cy is a dog.' }] }] });
const books = [
  { id: 'c', title: 'Cerulean', status: 'read' }, { id: 't', title: 'Tiny', status: 'read' },
  { id: 'u', title: 'Unread', status: 'unread' }, { id: 'n', title: 'No map', status: 'read' }];
const maps = { c: { map: cerulean, seen: [] }, t: { map: tiny, seen: [] }, u: { map: tiny, seen: [] } };

test('Sundays are for thinking; other days alternate recall and chronology', () => {
  assert.equal(D.ddTypeFor('2026-10-25'), 'think', 'a Sunday');
  const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map(D.ddTypeFor);
  assert.ok(week.every(t => t === 'who' || t === 'order'));
  assert.notEqual(week[0], week[1]);
  assert.equal(week[0], week[2]);
});

test('the same day always gives the same question', () => {
  assert.deepEqual(D.deepDivePick('2026-10-26', books, maps, {}), D.deepDivePick('2026-10-26', books, maps, {}));
});

test('only finished books with a map are used', () => {
  for (let i = 0; i < 20; i++) {
    const q = D.deepDivePick(D.ddAddDays('2026-10-26', i), books, maps, {});
    assert.ok(['c', 't'].includes(q.bookId), q.bookId);
  }
  assert.equal(D.deepDivePick('2026-10-26', [books[2], books[3]], maps, {}), null);
  assert.equal(D.deepDivePick('2026-10-26', [], {}, {}), null);
});

test('a "who" question offers the answer and two others from the same book', () => {
  let q; for (let i = 0; !(q && q.type === 'who'); i++) q = D.deepDivePick(D.ddAddDays('2026-10-26', i), [books[0]], maps, {});
  assert.equal(q.options.length, 3);
  assert.ok(q.options.includes(q.nodeId));
  assert.equal(new Set(q.options).size, 3);
  const ids = cerulean.branches.flatMap(b => b.nodes.map(n => n.id));
  assert.ok(q.options.every(id => ids.includes(id)));
  const branchOf = id => cerulean.branches.find(b => b.nodes.some(n => n.id === id)).label;
  assert.ok(q.options.every(id => branchOf(id) === branchOf(q.nodeId)), 'distractors come from the same branch when it has enough');
});

test('a chronology question takes three beats in order and shows them shuffled', () => {
  let q; for (let i = 0; !(q && q.type === 'order'); i++) q = D.deepDivePick(D.ddAddDays('2026-10-26', i), [books[0]], maps, {});
  assert.equal(q.beats.length, 3);
  assert.deepEqual(q.beats, q.beats.slice().sort((a, b) => a - b));
  assert.deepEqual(q.shown.slice().sort((a, b) => a - b), q.beats);
  assert.ok(q.beats.every(i => cerulean.timeline[i]));
});

test('a book without a chronology still gets a question of another kind', () => {
  for (let i = 0; i < 14; i++) {
    const q = D.deepDivePick(D.ddAddDays('2026-10-26', i), [books[1]], maps, {});
    assert.notEqual(q.type, 'order');
  }
});

test('books not seen lately come first, and unexplored bubbles before explored ones', () => {
  const q = D.deepDivePick('2026-10-26', books, maps, { c: '2026-10-25' });
  assert.equal(q.bookId, 't', 'Cerulean was shown yesterday');
  const allButOne = cerulean.branches.flatMap(b => b.nodes.map(n => n.id)).filter(id => id !== 'lucy');
  const m2 = { c: { map: cerulean, seen: allButOne } };
  for (let i = 0; i < 10; i++) {
    const p = D.deepDivePick(D.ddAddDays('2026-10-26', i), [books[0]], m2, {});
    if (p.type === 'who') assert.equal(p.nodeId, 'lucy');
  }
});

test('the clue hides the answer', () => {
  assert.equal(D.ddMask('Ramiz Rafi Mirza, called Ramy, Robin\'s friend', 'Ramy'), 'Ramiz Rafi Mirza, called ___, Robin\'s friend');
  assert.equal(D.ddMask('Linus Baker inspects the house.', 'Linus Baker'), '___ inspects the house.');
  assert.equal(D.ddMask('The Hab breaches.', 'The Hab'), '___ breaches.');
  assert.equal(D.ddMask('a (weird) [title]?', '(weird)'), 'a ___ [title]?', 'regex characters in titles are safe');
});

test('the streak counts consecutive answered days, and isn\'t broken before today is done', () => {
  const days = { '2026-10-23': { done: true }, '2026-10-24': { done: true }, '2026-10-25': { done: false } };
  assert.equal(D.deepDiveStreak(days, '2026-10-25'), 2);
  days['2026-10-25'].done = true;
  assert.equal(D.deepDiveStreak(days, '2026-10-25'), 3);
  assert.equal(D.deepDiveStreak(days, '2026-10-27'), 0, 'a missed day resets it');
  assert.equal(D.deepDiveStreak({}, '2026-10-25'), 0);
});

test('subtitles are trimmed for the card', () => {
  assert.equal(D.ddShort('Babel : Or the Necessity of Violence'), 'Babel');
  assert.equal(D.ddShort('The Algorithm: The Hypergrowth Formula'), 'The Algorithm');
  assert.equal(D.ddShort('Dark Matter'), 'Dark Matter');
});
