// Unit tests for the Daily Deep Dive: which question a day gets, that it's
// the same all day, that it rotates through books and unexplored bubbles,
// that the answer is hidden in the clue, and how the streak counts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctions, extractConst } from './extract.mjs';

const D = loadFunctions(['localDateStr', 'ddHash', 'ddShuffle', 'ddShort', 'ddAddDays', 'ddTypeFor', 'ddMask', 'ddCan',
                         'deepDivePick', 'deepDiveStreak', 'mmStr', 'mmColor', 'mmSources', 'normalizeSummary', 'normalizeCompanion', 'normalizeMindmap'],
  `const MM_MOTIFS=${extractConst('MM_MOTIFS')};const CP_FORMS=${extractConst('CP_FORMS')};`);

const cerulean = D.normalizeMindmap(JSON.parse(readFileSync(new URL('./fixtures/cerulean-map.json', import.meta.url), 'utf8')));
const tiny = D.normalizeMindmap({ branches: [{ label: 'People', nodes: [
  { title: 'Ann', remind: 'Ann is the narrator.', q: 'Why Ann?' }, { title: 'Bo', remind: 'Bo is her brother.' }, { title: 'Cy', remind: 'Cy is a dog.' }] }] });
const books = [
  { id: 'c', title: 'Cerulean', status: 'read' }, { id: 't', title: 'Tiny', status: 'read' },
  { id: 'u', title: 'Unread', status: 'unread' }, { id: 'n', title: 'No map', status: 'read' }];
const maps = { c: { map: cerulean, seen: [] }, t: { map: tiny, seen: [] }, u: { map: tiny, seen: [] } };

test('Sundays are for thinking; other days alternate recall and debate', () => {
  assert.equal(D.ddTypeFor('2026-10-25'), 'think', 'a Sunday');
  const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map(D.ddTypeFor);
  assert.ok(week.every(t => t === 'who' || t === 'debate'));
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

test('chronology ("what came first?") questions are gone', () => {
  for (let i = 0; i < 28; i++) {
    const q = D.deepDivePick(D.ddAddDays('2026-10-26', i), books, maps, {});
    assert.notEqual(q.type, 'order');
    assert.notEqual(q.type, 'debate', 'and without a Breakdown there is nothing to debate');
  }
});

const bdRec = (takes = {}) => ({ takes, bd: { questions: [0, 1, 2].map(i => ({ q: 'Q' + i, deeper: '', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] })) } });

test('a book with a Breakdown gets debate questions — even with no mind map', () => {
  const lone = [{ id: 'n', title: 'No map', status: 'read' }];
  const kinds = new Set();
  for (let i = 0; i < 14; i++) {
    const q = D.deepDivePick(D.ddAddDays('2026-10-26', i), lone, {}, {}, { n: bdRec() });
    assert.equal(q.type, 'debate', 'the only kind a map-less book can have');
    assert.ok(q.qi >= 0 && q.qi < 3);
    kinds.add(q.qi);
  }
  assert.ok(kinds.size > 1, 'different questions on different days');
  const mixed = new Set();
  for (let i = 0; i < 28; i++) mixed.add(D.deepDivePick(D.ddAddDays('2026-10-26', i), [books[0]], maps, {}, { c: bdRec() }).type);
  assert.ok(mixed.has('debate') && mixed.has('who') && mixed.has('think'), 'debates join the map’s own questions');
});

test('debate questions not yet answered come first', () => {
  for (let i = 0; i < 14; i++) {
    const q = D.deepDivePick(D.ddAddDays('2026-10-26', i), [{ id: 'n', title: 'N', status: 'read' }], {}, {}, { n: bdRec({ 0: 1, 2: 0 }) });
    assert.equal(q.qi, 1);
  }
  const all = D.deepDivePick('2026-10-27', [{ id: 'n', title: 'N', status: 'read' }], {}, {}, { n: bdRec({ 0: 1, 1: 1, 2: 0 }) });
  assert.equal(all.type, 'debate', 'once all are answered they come round again');
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

test('books with a companion also get "remember this moment" questions', () => {
  const withCp = { ...cerulean, companion: D.normalizeCompanion({ form: 'fiction', moments: [
    { title: 'Linus is summoned', text: 'Extremely Upper Management send him to the island.' },
    { title: 'Lucy’s record player', text: 'Lucy shares his records with Linus.' }] }) };
  const m = { c: { map: withCp, seen: [] } };
  const kinds = new Set();
  for (let i = 0; i < 28; i++) {
    const q = D.deepDivePick(D.ddAddDays('2026-10-26', i), [books[0]], m, {});
    kinds.add(q.type);
    if (q.type === 'moment') assert.ok(withCp.companion.moments[q.moment], 'points at a real moment');
  }
  assert.ok(kinds.has('moment'), 'moments come round');
  assert.ok(kinds.has('who') && kinds.has('think'), 'and the map’s own questions still do');
  for (let i = 0; i < 14; i++) assert.notEqual(D.deepDivePick(D.ddAddDays('2026-10-26', i), [books[0]], maps, {}).type, 'moment', 'no companion, no moment');
});
