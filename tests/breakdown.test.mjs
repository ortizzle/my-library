// Unit tests for the Breakdown: what survives normalizing, how two devices'
// copies merge (and when a picked take carries over), where people sit in the
// connections map, and how a Breakdown shipped with the app finds its book.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctions } from './extract.mjs';

const B = loadFunctions(['mmStr', 'mmSources', 'ddShort', 'normalizeBreakdown', 'mergeBreakdowns', 'bdMapLayout', 'bdKey', 'takeShippedBreakdowns']);

const raw = {
  kind: 'fiction', hook: 'It is really about belonging.', intro: ['First.', 'Second.'],
  turns: [{ title: 'Home', text: 'He comes home.' }, { title: 'No text' }, { title: 'End', text: 'He gives up.' }],
  sections: [{ title: 'The twist', paras: ['It changes everything.'], points: [{ label: 'Personal', text: 'He hid it.' }, { label: 'Empty' }], pull: 'A line.' },
    { title: 'Nothing in it' }],
  people: [{ name: 'Tony', role: 'the returner' }, { name: 'Flute', role: 'the enforcer' }, { name: 'Philly' }, { name: 'tony' }],
  links: [{ a: 'tony', b: 'Flute', text: 'Desire and betrayal' }, { a: 'Tony', b: 'Nobody', text: 'x' }, { a: 'Tony', b: 'Tony', text: 'self' }, { a: 'Philly', b: 'Tony', text: 'A father figure' }],
  themes: [{ title: 'Love versus loyalty', text: 'He confuses them.' }],
  praised: ['The voice.'], criticized: ['The pace.', 'x', 'y', 'z'],
  questions: [{ q: 'Did he love him?', deeper: 'Both sides.', options: [{ label: 'Yes', holds: 'h', hard: 'd' }, { label: 'No' }, { label: 'Both' }, { label: 'A fourth' }] },
    { q: 'Only one option', options: [{ label: 'Yes' }] }],
  final: ['It lingers.'],
  sources: [{ url: 'https://example.com/a', title: 'A review' }, { url: 'javascript:alert(1)', title: 'bad' }]
};

test('a Breakdown keeps what is usable and drops what is not', () => {
  const bd = B.normalizeBreakdown(raw);
  assert.equal(bd.turns.length, 2, 'a turning point needs a title and text');
  assert.equal(bd.sections.length, 1, 'an empty section is dropped');
  assert.equal(bd.sections[0].points.length, 1);
  assert.deepEqual(bd.people.map(p => p.name), ['Tony', 'Flute', 'Philly'], 'the same name twice counts once');
  assert.deepEqual(bd.links.map(l => l.a + '-' + l.b), ['Tony-Flute', 'Philly-Tony'], 'links must join two different people on the list; names resolve whatever their case');
  assert.equal(bd.criticized.length, 3);
  assert.equal(bd.questions.length, 1, 'a question needs at least two answers');
  assert.equal(bd.questions[0].options.length, 3);
  assert.equal(bd.sources.length, 1, 'only http(s) links are kept');
});

test('no claim, or nothing to back it, is no Breakdown', () => {
  assert.equal(B.normalizeBreakdown(null), null);
  assert.equal(B.normalizeBreakdown({ turns: raw.turns }), null);
  assert.equal(B.normalizeBreakdown({ hook: 'A claim.' }), null);
  assert.equal(B.normalizeBreakdown({ kind: 'essay', hook: 'A claim.', turns: raw.turns }).kind, 'fiction');
});

const rec = (madeAt, updatedAt, takes = {}) => ({ bd: { hook: 'h' + madeAt }, madeAt, updatedAt, takes });

test('the newer copy of a Breakdown wins, and a deleted book loses its own', () => {
  const m = B.mergeBreakdowns({ a: rec(1, 5), b: rec(1, 1) }, { a: rec(1, 9), c: rec(2, 2), junk: { takes: {} } }, { b: 123 });
  assert.equal(m.a.updatedAt, 9);
  assert.ok(m.c && !m.b && !m.junk);
  assert.deepEqual(B.mergeBreakdowns(undefined, undefined, undefined), {});
});

test('takes picked on two devices are both kept — unless one side rewrote the Breakdown', () => {
  const same = B.mergeBreakdowns({ a: rec(1, 5, { 0: 2 }) }, { a: rec(1, 9, { 1: 0 }) }, {});
  assert.deepEqual(same.a.takes, { 0: 2, 1: 0 });
  const clash = B.mergeBreakdowns({ a: rec(1, 5, { 0: 2 }) }, { a: rec(1, 9, { 0: 1 }) }, {});
  assert.equal(clash.a.takes[0], 1, 'where both picked, the newer record’s stands');
  const rewritten = B.mergeBreakdowns({ a: rec(1, 5, { 0: 2 }) }, { a: rec(7, 9, {}) }, {});
  assert.deepEqual(rewritten.a.takes, {}, 'old takes answer old questions');
});

test('the most connected person sits in the middle of the map; everyone stays in frame', () => {
  const bd = B.normalizeBreakdown(raw);
  const L = B.bdMapLayout(bd.people, bd.links);
  assert.equal(L.hub, 'Tony');
  assert.deepEqual([L.pos.Tony.x, L.pos.Tony.y], [L.W / 2, L.H / 2]);
  for (const p of Object.values(L.pos)) assert.ok(p.x >= 40 && p.x <= L.W - 40 && p.y >= 15 && p.y <= L.H - 15);
  assert.equal(B.bdMapLayout(bd.people.slice(0, 2), bd.links), null, 'too few people to draw');
});

test('a shipped Breakdown lands on the matching finished book, once', () => {
  const books = [{ id: 'x', title: 'All Them Dogs: A Novel', author: 'Djamel White', status: 'read' },
    { id: 'y', title: 'All Them Dogs', author: 'Somebody Else', status: 'read' },
    { id: 'z', title: 'All Them Dogs', author: 'Djamel White', status: 'reading' }];
  const items = [{ title: 'All Them Dogs', author: 'Djamel White', at: 100, bd: raw }, { title: 'Broken', author: 'X', at: 100, bd: {} }];
  const db = {};
  assert.deepEqual(B.takeShippedBreakdowns(items, books, db), ['x'], 'title and author must match, and the book must be finished');
  assert.equal(db.x.from, 'shipped');
  assert.equal(db.x.madeAt, 100);
  db.x.takes = { 0: 1 };
  assert.deepEqual(B.takeShippedBreakdowns(items, books, db), [], 'the same copy is not taken twice');
  assert.deepEqual(db.x.takes, { 0: 1 });
  assert.deepEqual(B.takeShippedBreakdowns([{ ...items[0], at: 200 }], books, db), ['x'], 'a newer shipped copy replaces an older shipped one');
  const own = { x: { bd: { hook: 'mine' }, madeAt: 50, updatedAt: 50, takes: {} } };
  assert.deepEqual(B.takeShippedBreakdowns(items, books, own), [], 'one written in the app is never replaced');
});

test('breakdowns.json is valid and every shipped Breakdown is usable', () => {
  const data = JSON.parse(readFileSync(new URL('../breakdowns.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(data.items));
  for (const it of data.items) {
    assert.ok(it.title && it.at > 0, 'has a title and a timestamp');
    const bd = B.normalizeBreakdown(it.bd);
    assert.ok(bd, `${it.title} normalizes`);
    assert.equal(bd.questions.length, 3, `${it.title} has three questions`);
    for (const q of bd.questions) assert.equal(q.options.length, 3);
    assert.equal(bd.links.length, it.bd.links.length, `${it.title}: every link names two listed people`);
  }
});
