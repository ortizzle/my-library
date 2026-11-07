// The learning tools: the per-book review deck (cards from the Companion or
// the map, Leitner scheduling) and Claude's connections across books.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctions, extractConst } from './extract.mjs';

const L = loadFunctions(['deckSlug', 'deckCards', 'deckDue', 'deckGrade', 'vocabInterval', 'ddAddDays', 'localDateStr',
  'linksInput', 'linksSig', 'normalizeLinks', 'mmStr', 'mmColor', 'mmSources', 'normalizeSummary', 'normalizeCompanion', 'normalizeMindmap'],
  `const MM_MOTIFS=${extractConst('MM_MOTIFS')};const CP_FORMS=${extractConst('CP_FORMS')};`);

const raw = JSON.parse(readFileSync(new URL('./fixtures/cerulean-map.json', import.meta.url), 'utf8'));
const plain = L.normalizeMindmap(raw);
const withCp = L.normalizeMindmap({ ...raw, companion: { form: 'fiction',
  moments: [{ title: 'Linus is summoned', where: 'Chapter 1', text: 'He is sent to the island.', why: 'It starts everything.' }],
  themes: [{ title: 'Chosen family', text: 'Traced through the dinners.', readings: 'Some find it too gentle.' }],
  arcs: [{ name: 'Linus', text: 'From rules to courage.' }] } });

test('a Companion makes moment, theme and arc cards; without one, the map’s bubbles do', () => {
  const c = L.deckCards(withCp);
  assert.deepEqual(c.map(x => x.kind), ['moment', 'theme', 'arc']);
  assert.match(c[0].front, /What happens here: “Linus is summoned” \(Chapter 1\)\?/);
  assert.equal(c[0].back, 'He is sent to the island.');
  assert.equal(c[1].note, 'Some find it too gentle.');
  const m = L.deckCards(plain);
  assert.ok(m.length >= 10 && m.every(x => x.kind === 'node' && x.back));
  assert.equal(new Set(m.map(x => x.key)).size, m.length, 'keys are unique');
  assert.deepEqual(L.deckCards(null), []);
});

test('due cards first, then a few new ones', () => {
  const cards = L.deckCards(plain);
  const st = { [cards[3].key]: { box: 1, due: '2026-11-01' }, [cards[4].key]: { box: 2, due: '2026-12-01' } };
  const due = L.deckDue(st, cards, '2026-11-07', 2);
  assert.equal(due[0].key, cards[3].key, 'the due card leads');
  assert.equal(due.length, 3, 'one due + two new; the not-yet-due card waits');
  assert.ok(!due.some(c => c.key === cards[4].key));
  assert.equal(L.deckDue(st, cards, '2026-11-07', 0).length, 1, 'no new cards when not asked');
});

test('grading moves a card up a box, or back to the start', () => {
  const r1 = L.deckGrade(undefined, true, '2026-11-07');
  assert.deepEqual([r1.box, r1.due, r1.reviews], [1, '2026-11-08', 1]);
  const r2 = L.deckGrade(r1, true, '2026-11-08');
  assert.deepEqual([r2.box, r2.due], [2, '2026-11-11']);
  const r3 = L.deckGrade(r2, false, '2026-11-11');
  assert.deepEqual([r3.box, r3.due, r3.lapses], [0, '2026-11-12', 1]);
});

test('connections: only finished books with maps go in; Claude’s answer is checked', () => {
  const books = [{ id: 'a', title: 'Kindred', status: 'read' }, { id: 'b', title: 'Piranesi', status: 'read' },
                 { id: 'c', title: 'Unread', status: 'unread' }, { id: 'd', title: 'No map', status: 'read' }];
  const maps = { a: { map: withCp }, b: { map: plain }, c: { map: plain } };
  const items = L.linksInput(books, maps);
  assert.deepEqual(items.map(i => i.id), ['a', 'b']);
  assert.deepEqual(items[0].themes, ['Chosen family'], 'Companion themes when there is one');
  assert.ok(items[1].themes.length > 0, 'otherwise the map’s theme bubbles');
  assert.equal(L.linksSig([{ id: 'b' }, { id: 'a' }]), 'a,b');
  const out = L.normalizeLinks({ themes: [
    { title: 'Found family', text: 'Families chosen, not given.', books: [{ id: 'a', note: 'x' }, { id: 'b', note: 'y' }, { id: 'zz', note: 'gone' }] },
    { title: 'Lonely', books: [{ id: 'a', note: 'only one' }] }, 'junk'] }, new Set(['a', 'b']));
  assert.equal(out.length, 1, 'a connection needs two real books');
  assert.deepEqual(out[0].books.map(b => b.id), ['a', 'b']);
});
