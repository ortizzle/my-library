// Unit tests for mind maps: model output is coerced into something safe to
// draw, Claude's reply is parsed even when wrapped, maps merge across devices
// like books do, and the layout fits a phone screen without bubbles colliding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctions, extractConst } from './extract.mjs';

const MM = loadFunctions(['mergeMindmaps', 'mmStr', 'mmColor', 'normalizeMindmap', 'parseMindmapReply',
                          'mmTextOn', 'mindmapLayout'],
  `const MM_MOTIFS=${extractConst('MM_MOTIFS')};`);

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cerulean-map.json', import.meta.url), 'utf8'));
const node = (title, extra = {}) => ({ title, sub: 'sub', remind: 'r', ...extra });

// ── normalizeMindmap ─────────────────────────────────────────────────────

test('the fixture normalizes with every branch, node and timeline beat', () => {
  const m = MM.normalizeMindmap(fixture);
  assert.equal(m.branches.length, 5);
  assert.equal(m.branches.flatMap(b => b.nodes).length, 18);
  assert.equal(m.motif, 'sea');
  assert.equal(m.timeline.length, 7);
  const ids = m.branches.flatMap(b => b.nodes.map(n => n.id));
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const n of m.branches.flatMap(b => b.nodes))
    for (const l of n.links) assert.ok(ids.includes(l), `link ${l} resolves`);
});

test('caps branches and nodes so the layout always fits', () => {
  const many = n => Array.from({ length: n }, (_, i) => node(`Node ${i}`));
  const m = MM.normalizeMindmap({ branches: Array.from({ length: 8 }, (_, i) => ({ label: `B${i}`, nodes: many(10) })) });
  assert.equal(m.branches.length, 5);
  assert.equal(m.branches[0].nodes.length, 6);
  for (const b of m.branches.slice(1)) assert.equal(b.nodes.length, 4);
});

test('rejects junk and drops empty branches and untitled nodes', () => {
  assert.equal(MM.normalizeMindmap(null), null);
  assert.equal(MM.normalizeMindmap({}), null);
  assert.equal(MM.normalizeMindmap({ branches: 'nope' }), null);
  assert.equal(MM.normalizeMindmap({ branches: [{ label: 'X', nodes: [{ sub: 'no title' }] }] }), null);
  const m = MM.normalizeMindmap({ branches: [{ label: '', nodes: [node('A')] }, { label: 'Ok', nodes: [null, 5, node('B')] }] });
  assert.equal(m.branches.length, 1);
  assert.deepEqual(m.branches[0].nodes.map(n => n.title), ['B']);
});

test('links resolve by id or title, drop self-links and unknowns', () => {
  const m = MM.normalizeMindmap({ branches: [{ label: 'People', nodes: [
    node('Linus Baker', { id: 'linus', links: ['arthur', 'Zoe', 'linus', 'nobody'] }),
    node('Arthur', { id: 'arthur' }), node('Zoe')] }],
    timeline: [{ title: 'Start', links: ['Linus Baker', 'ghost'] }, { summary: 'untitled beat' }] });
  const [linus] = m.branches[0].nodes;
  assert.deepEqual(linus.links, ['arthur', 'zoe']);
  assert.deepEqual(m.timeline, [{ title: 'Start', summary: '', links: ['linus'] }]);
});

test('style falls back safely: unknown motif, bad colours, long emblem', () => {
  const m = MM.normalizeMindmap({ motif: 'volcano', palette: ['#zzz', 'red', '#ABCDEF'], emblem: 'not an emoji',
    kind: 'poetry', branches: [{ label: 'A', nodes: [node('x')] }] });
  assert.equal(m.motif, 'plain');
  assert.equal(m.palette.length, 5, 'too few valid colours: default palette');
  assert.equal(m.emblem, '📖');
  assert.equal(m.kind, 'fiction');
  assert.equal(MM.mmColor(' #ABCDEF '), '#abcdef');
  assert.equal(MM.mmColor('url(javascript:1)'), '');
});

test('strings are trimmed, collapsed and length-capped; non-strings become empty', () => {
  assert.equal(MM.mmStr('  a \n\n b  ', 10), 'a b');
  assert.equal(MM.mmStr('x'.repeat(50), 40).length, 40);
  assert.equal(MM.mmStr({ toString: () => 'hi' }, 10), '');
  assert.equal(MM.mmStr(42, 10), '');
});

test('markup in model output survives as plain text (rendered via textContent)', () => {
  const m = MM.normalizeMindmap({ branches: [{ label: '<b>X</b>', nodes: [node('<img src=x onerror=alert(1)>')] }] });
  assert.equal(m.branches[0].label, '<b>X</b>');
  assert.equal(m.branches[0].nodes[0].title, '<img src=x onerror=alert(1)>');
});

// ── parseMindmapReply ────────────────────────────────────────────────────

test('parses a reply with a code fence or a sentence around the JSON', () => {
  assert.deepEqual(MM.parseMindmapReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(MM.parseMindmapReply('Here you go: {"a":{"b":2}} Enjoy!'), { a: { b: 2 } });
  assert.equal(MM.parseMindmapReply('no json here'), null);
  assert.equal(MM.parseMindmapReply('{"a":'), null);
  assert.equal(MM.parseMindmapReply(undefined), null);
});

// ── mergeMindmaps ────────────────────────────────────────────────────────

test('merge: newer map wins per book, both sides kept, deleted books dropped', () => {
  const map = { branches: [] };
  const local = { a: { map, updatedAt: 5, seen: ['x'] }, b: { map, updatedAt: 1 } };
  const remote = { a: { map, updatedAt: 3 }, b: { map, updatedAt: 9 }, c: { map, updatedAt: 2 }, gone: { map, updatedAt: 9 } };
  const out = MM.mergeMindmaps(local, remote, { gone: 100 });
  assert.equal(out.a.updatedAt, 5);
  assert.deepEqual(out.a.seen, ['x']);
  assert.equal(out.b.updatedAt, 9);
  assert.ok(out.c);
  assert.equal(out.gone, undefined);
});

test('merge ignores malformed records and missing sides', () => {
  assert.deepEqual(MM.mergeMindmaps(undefined, { x: null, y: 'str', z: { updatedAt: 1 } }, undefined), {});
});

// ── layout ───────────────────────────────────────────────────────────────

const boxes = L => {
  const out = [];
  L.branches.forEach((b, i) => b && b.nodes.forEach((n, j) =>
    out.push({ id: `${i}.${j}`, x0: n.x - n.maxW / 2, x1: n.x + n.maxW / 2, y0: n.y - 20, y1: n.y + 20 })));
  return out;
};
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

for (const shape of [[6, 4, 4, 4, 4], [1, 1, 1, 1, 1], [3, 2, 4, 1], [6], [2, 4, 4, 3], [5, 3, 3, 4, 2]]) {
  test(`layout for branch sizes ${shape.join('/')} fits 412px with no bubbles overlapping`, () => {
    const map = { branches: shape.map((n, i) => ({ label: `B${i}`, nodes: Array.from({ length: n }, (_, j) => ({ title: `${i}${j}` })) })) };
    const L = MM.mindmapLayout(map);
    const bs = boxes(L);
    assert.equal(bs.length, shape.reduce((a, b) => a + b, 0));
    for (const b of bs) {
      assert.ok(b.x0 >= 0 && b.x1 <= 412, `bubble ${b.id} inside the width (${b.x0}..${b.x1})`);
      assert.ok(b.y0 > 0 && b.y1 < L.height - 30, `bubble ${b.id} clear of the top and footer`);
    }
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++)
      assert.ok(!overlap(bs[i], bs[j]), `bubbles ${bs[i].id} and ${bs[j].id} overlap`);
    const c = L.center;
    for (const b of bs) {
      const nx = Math.max(b.x0, Math.min(c.x, b.x1)), ny = Math.max(b.y0, Math.min(c.y, b.y1));
      assert.ok(Math.hypot(nx - c.x, ny - c.y) >= c.r - 8, `bubble ${b.id} clear of the centre emblem`);
    }
  });
}

test('text on a branch pill picks light or dark for contrast', () => {
  assert.equal(MM.mmTextOn('#ffffff'), '#1d2b3a');
  assert.equal(MM.mmTextOn('#e9a03b'), '#1d2b3a');
  assert.equal(MM.mmTextOn('#1f3a68'), '#ffffff');
});
