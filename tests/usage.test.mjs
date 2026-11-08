// The Claude usage log: which feature a request came from, and the tally.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions, extractConst } from './extract.mjs';

const U = loadFunctions(['usageFeature', 'usageAdd', 'fmtTok'], `const USAGE_FEATURES=${extractConst('USAGE_FEATURES')};`);

test('the feature is read off the call stack, automatic work named as such', () => {
  const st = fns => 'Error\n' + fns.map(f => `    at ${f} (index.html:1:1)`).join('\n');
  assert.equal(U.usageFeature(st(['wrapped', 'askClaude', 'requestMindmap', 'generateMindmap'])), 'Mind maps');
  assert.equal(U.usageFeature(st(['wrapped', 'askClaude', 'requestMindmap', 'runMindmapQueue'])), 'Mind maps (automatic)');
  assert.equal(U.usageFeature(st(['wrapped', 'askClaude', 'requestCompanion', 'autoCompanion', 'runMindmapQueue'])), 'Companions (automatic)');
  assert.equal(U.usageFeature(st(['wrapped', 'clubReply', 'sendBookClub'])), 'Book club');
  assert.equal(U.usageFeature(st(['wrapped', 'somethingNew'])), 'Other');
  assert.equal(U.usageFeature(st(['wrapped', 'requestMindmapX'])), 'Other', 'whole names only');
});

test('usage adds up by month and feature, and by day, counting cached input and searches', () => {
  let db = U.usageAdd({}, 'Mind maps', { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50, server_tool_use: { web_search_requests: 3 } }, '2026-11-08');
  db = U.usageAdd(db, 'Mind maps', { input_tokens: 1000, output_tokens: 10 }, '2026-11-08');
  db = U.usageAdd(db, 'Book club', { input_tokens: 5, output_tokens: 5 }, '2026-11-09');
  assert.deepEqual(db.months['2026-11']['Mind maps'], { n: 2, in: 2000, out: 60, s: 3 });
  assert.deepEqual(db.days['2026-11-08'], { n: 2, in: 2000, out: 60, s: 3 });
  assert.deepEqual(db.days['2026-11-09'], { n: 1, in: 5, out: 5, s: 0 });
});

test('old days and months are trimmed', () => {
  let db = {};
  for (let i = 1; i <= 70; i++) db = U.usageAdd(db, 'X', { input_tokens: 1 }, `2026-0${1 + Math.floor((i - 1) / 28)}-${String(1 + (i - 1) % 28).padStart(2, '0')}`);
  assert.equal(Object.keys(db.days).length, 62);
  assert.ok(!db.days['2026-01-01'] && db.days['2026-03-14']);
});

test('token counts read short', () => {
  assert.equal(U.fmtTok(0), '0');
  assert.equal(U.fmtTok(950), '950');
  assert.equal(U.fmtTok(12_400), '12k');
  assert.equal(U.fmtTok(1_240_000), '1.2M');
  assert.equal(U.fmtTok(124_000_000), '124M');
});
