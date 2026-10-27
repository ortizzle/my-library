// Unit tests for the storage check: who owns each key, and how the report
// adds up. The old-version group is what the Clear button removes, so the
// boundary between trr_v1_* (current) and trr_/trr2_…trr4_ (old) matters.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions } from './extract.mjs';

const S = loadFunctions(['storageOwner', 'storageReport', 'fmtSize']);

test('current keys, old-version keys, Drive and other apps are told apart', () => {
  assert.equal(S.storageOwner('trr_v1_books').id, 'trr');
  assert.equal(S.storageOwner('trr_v1_gist_token').id, 'trr', 'the gist keys belong to the app too');
  for (const k of ['trr_books', 'trr2_covers', 'trr3_progress', 'trr4_api']) assert.equal(S.storageOwner(k).id, 'trr-old', k);
  assert.equal(S.storageOwner('ortizdrive:token').id, 'drive');
  assert.equal(S.storageOwner('howlers_v3_data').id, 'app:howlers');
  assert.equal(S.storageOwner('screening-room').id, 'app:screening');
  assert.notEqual(S.storageOwner('trr_v2_books').id, 'trr-old', 'a future storage version is never treated as old');
  assert.notEqual(S.storageOwner('trr5_books').id, 'trr-old');
});

test('the report totals sizes per owner, biggest first, and lists the biggest keys', () => {
  const r = S.storageReport([['trr_v1_books', 'x'.repeat(100)], ['trr4_books', 'y'.repeat(300)], ['howlers_data', 'z'.repeat(50)], ['trr_v1_maps', 'm'.repeat(20)]]);
  assert.equal(r.total, 100 + 12 + 300 + 10 + 50 + 12 + 20 + 11);
  assert.deepEqual(r.groups.map(g => g.id), ['trr-old', 'trr', 'app:howlers']);
  assert.equal(r.groups[1].keys, 2);
  assert.equal(r.biggest[0].key, 'trr4_books');
  assert.deepEqual(S.storageReport([]), { total: 0, groups: [], biggest: [] });
});

test('sizes read naturally', () => {
  assert.equal(S.fmtSize(512), '512 bytes');
  assert.equal(S.fmtSize(2048), '2 KB');
  assert.equal(S.fmtSize(3 * 1048576), '3.00 MB');
});
