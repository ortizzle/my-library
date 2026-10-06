// Regression tests for the Gist sync merge.
//
// Every case here corresponds to a bug that actually shipped. Before this
// merge existed, sync was a wholesale replace decided by one global timestamp:
// whichever device wrote last overwrote the other device's entire library.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions, extractConst } from './extract.mjs';

const M = loadFunctions(
  ['mergeDeleted', 'mergeBooks', 'entryKey', 'entryId', 'mergeEntryMap', 'dropDeletedEntries',
   'mergeIdMap', 'mergeState', 'remoteState', 'normEntries'],
  `const TOMBSTONE_TTL=${extractConst('TOMBSTONE_TTL')};`
);

// Must be recent: tombstones older than TOMBSTONE_TTL are purged, so fixtures
// dated in the distant past would exercise the purge instead of the merge.
const T0 = Date.now() - 86400000; // yesterday
const book = (id, title, updatedAt, extra = {}) => ({ id, title, updatedAt, addedAt: updatedAt, ...extra });
const state = (o = {}) => ({
  books: [], prog: {}, journal: {}, covers: {}, cacheQ: {}, favQ: {},
  streak: {}, rooms: [], goals: {}, deleted: {}, ...o
});
const titles = s => s.books.map(b => b.title).sort();

test('two devices adding different books keeps both (the original data-loss bug)', () => {
  // Phone adds Piranesi offline at T0; laptop pushes a Dune edit at T0+1h.
  // The old pull replaced the phone's whole array and Piranesi was gone.
  const phone = state({ books: [book('b1', 'Dune', T0), book('b2', 'Piranesi', T0)] });
  const gist = state({ books: [book('b1', 'Dune', T0 + 3600_000, { status: 'reading' })] });

  const merged = M.mergeState(phone, gist);

  assert.deepEqual(titles(merged), ['Dune', 'Piranesi']);
  assert.equal(merged.books.find(b => b.id === 'b1').status, 'reading', 'newer edit wins per book');
});

test('a later edit wins over an older one for the same book', () => {
  const local = state({ books: [book('b1', 'Dune', T0 + 5000, { rating: 5 })] });
  const remote = state({ books: [book('b1', 'Dune', T0, { rating: 2 })] });
  assert.equal(M.mergeState(local, remote).books[0].rating, 5);
  assert.equal(M.mergeState(remote, local).books[0].rating, 5, 'merge is order-independent');
});

test('a delete propagates and does not resurrect', () => {
  // Device A deleted b2. Device B still has it and pushes it back.
  const a = state({ books: [book('b1', 'Dune', T0)], deleted: { b2: T0 + 1000 } });
  const b = state({ books: [book('b1', 'Dune', T0), book('b2', 'Piranesi', T0)] });

  const merged = M.mergeState(a, b);
  assert.deepEqual(titles(merged), ['Dune']);
  assert.ok(merged.deleted.b2, 'tombstone survives so the other device converges');

  // And it stays deleted across a second round-trip.
  assert.deepEqual(titles(M.mergeState(b, merged)), ['Dune']);
});

test('re-adding a book after deleting it beats the tombstone', () => {
  const local = state({ books: [book('b2', 'Piranesi', T0 + 9000)], deleted: { b2: T0 + 1000 } });
  const merged = M.mergeState(local, state());
  assert.deepEqual(titles(merged), ['Piranesi'], 'edit newer than the tombstone wins');
});

test('tombstones older than the TTL are purged', () => {
  const old = Date.now() - 61 * 86400000;
  const merged = M.mergeState(state({ deleted: { gone: old } }), state());
  assert.equal(merged.deleted.gone, undefined);
});

test('reading history is unioned, never replaced (the import bug)', () => {
  // Restoring an old backup used to spread-replace these arrays, destroying
  // every entry newer than the backup on every book in it.
  const live = state({
    books: [book('b1', 'Dune', T0)],
    prog: { b1: [{ date: '2026-07-01', type: 'pages', cur: 100, total: 300 },
                 { date: '2026-07-20', type: 'pages', cur: 250, total: 300 }] },
    journal: { b1: [{ date: '2026-07-20', time: '9:00 AM', text: 'the spice must flow' }] }
  });
  const backup = state({
    books: [book('b1', 'Dune', T0)],
    prog: { b1: [{ date: '2026-07-01', type: 'pages', cur: 100, total: 300 }] },
    journal: { b1: [{ date: '2026-04-02', time: '8:00 PM', text: 'started it' }] }
  });

  const merged = M.mergeState(live, backup);
  assert.equal(merged.prog.b1.length, 2, 'newer progress entry survives the restore');
  assert.deepEqual(merged.journal.b1.map(e => e.text).sort(),
    ['started it', 'the spice must flow'], 'both journal entries kept');
});

test('identical history entries are deduped rather than doubled', () => {
  const e = { date: '2026-07-01', type: 'pages', cur: 100, total: 300, note: '' };
  const merged = M.mergeState(state({ prog: { b1: [e] } }), state({ prog: { b1: [{ ...e }] } }));
  assert.equal(merged.prog.b1.length, 1);
});

test('history for a deleted book is dropped', () => {
  const merged = M.mergeState(
    state({ deleted: { b1: T0 + 1000 } }),
    state({ books: [book('b1', 'Dune', T0)], prog: { b1: [{ date: '2026-07-01', cur: 10 }] } })
  );
  assert.equal(merged.prog.b1, undefined);
});

test('streak days take the higher count so neither device loses a logged day', () => {
  const merged = M.mergeState(
    state({ streak: { '2026-07-01': 2, '2026-07-02': 1 } }),
    state({ streak: { '2026-07-01': 1, '2026-07-03': 3 } })
  );
  assert.deepEqual(merged.streak, { '2026-07-01': 2, '2026-07-02': 1, '2026-07-03': 3 });
});

test('rooms union and stay sorted', () => {
  const merged = M.mergeState(state({ rooms: ['Study', 'Bedroom'] }), state({ rooms: ['Kitchen', 'Study'] }));
  assert.deepEqual(merged.rooms, ['Bedroom', 'Kitchen', 'Study']);
});

test('merge converges — a second pass changes nothing', () => {
  const a = state({ books: [book('b1', 'Dune', T0)], prog: { b1: [{ date: '2026-07-01', cur: 10 }] }, streak: { '2026-07-01': 1 } });
  const b = state({ books: [book('b2', 'Piranesi', T0 + 1)], deleted: { b3: T0 } });
  const once = M.mergeState(a, b);
  const twice = M.mergeState(once, once);
  assert.deepEqual(twice, once, 'merging a merged state is a no-op (no sync ping-pong)');
});

test('books without updatedAt lose to any real edit but are still kept', () => {
  const legacy = state({ books: [{ id: 'b1', title: 'Dune' }] });      // pre-updatedAt record
  const edited = state({ books: [book('b1', 'Dune', T0, { rating: 4 })] });
  const merged = M.mergeState(legacy, edited);
  assert.equal(merged.books.length, 1);
  assert.equal(merged.books[0].rating, 4);

  // A legacy-only book is not dropped.
  assert.deepEqual(titles(M.mergeState(legacy, state())), ['Dune']);
});

test('remoteState coerces a malformed payload instead of poisoning state', () => {
  // A hand-edited gist used to be assigned straight into state and then throw
  // at render time, bricking the app on every subsequent reload.
  const bad = M.remoteState({ books: { nope: 1 }, prog: 'garbage', streak: null, rooms: 42 });
  assert.deepEqual(bad.books, []);
  assert.deepEqual(bad.prog, {});
  assert.deepEqual(bad.streak, {});
  assert.deepEqual(bad.rooms, []);

  assert.equal(M.remoteState(null), null);
  assert.equal(M.remoteState([1, 2, 3]), null, 'a bare array is not a valid payload');
});

test('malformed remote merges without losing local data', () => {
  const local = state({ books: [book('b1', 'Dune', T0)] });
  const merged = M.mergeState(local, M.remoteState({ books: 'not an array' }));
  assert.deepEqual(titles(merged), ['Dune']);
});

test('books missing an id are discarded rather than crashing the merge', () => {
  const merged = M.mergeState(state({ books: [{ title: 'no id' }, book('b1', 'Dune', T0)] }), state());
  assert.deepEqual(titles(merged), ['Dune']);
});

// ── Entry tombstones ─────────────────────────────────────────────────────
// Journal and progress entries were unioned with no way to express "removed",
// so deleting one took it out locally and the next push merged the gist's copy
// straight back in — even on a single device.

const J = (text, at, date = '2026-10-01') => ({ date, time: '9:00 PM', text, at });
const P = (cur, at, date = '2026-10-01') => ({ date, type: 'pages', cur, total: 300, note: '', at });
const idJ = (book, e) => M.entryId('j', book, e);
const idP = (book, e) => M.entryId('p', book, e);

test('a deleted journal entry stays deleted when the gist still has it', () => {
  // The bug as reproduced: delete locally, then the next push merges remote.
  const e = J('a passage I deleted', 1000);
  const local = state({ books: [book('b1', 'Dune', T0)], journal: { b1: [] }, entryDel: { [idJ('b1', e)]: T0 } });
  const remote = state({ books: [book('b1', 'Dune', T0)], journal: { b1: [e] } });
  assert.deepEqual(M.mergeState(local, remote).journal.b1, []);
});

test('a deleted progress entry stays deleted too', () => {
  const e = P(120, 1000);
  const local = state({ books: [book('b1', 'Dune', T0)], prog: { b1: [] }, entryDel: { [idP('b1', e)]: T0 } });
  const remote = state({ books: [book('b1', 'Dune', T0)], prog: { b1: [e] } });
  assert.deepEqual(M.mergeState(local, remote).prog.b1, []);
});

test('the delete survives a second round-trip and the tombstone travels', () => {
  const e = J('gone', 1000);
  const a = state({ books: [book('b1', 'Dune', T0)], journal: { b1: [] }, entryDel: { [idJ('b1', e)]: T0 } });
  const b = state({ books: [book('b1', 'Dune', T0)], journal: { b1: [e] } });
  const once = M.mergeState(a, b);
  assert.ok(once.entryDel[idJ('b1', e)], 'the tombstone is carried to the other side');
  assert.deepEqual(M.mergeState(b, once).journal.b1, [], 'and the other device converges');
});

test('re-adding an identical entry after deleting it is kept', () => {
  // Log p.120, delete it by mistake, log p.120 again — the second one is real.
  const old = P(120, 1000);
  const readded = P(120, T0 + 5000);
  const local = state({ books: [book('b1', 'Dune', T0)], prog: { b1: [readded] }, entryDel: { [idP('b1', old)]: T0 } });
  const remote = state({ books: [book('b1', 'Dune', T0)], prog: { b1: [old] } });
  const merged = M.mergeState(local, remote).prog.b1;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].at, T0 + 5000, 'the newer copy wins the dedupe and beats the tombstone');
});

test('a tombstone only removes that book\'s entry, not an identical one elsewhere', () => {
  const e = J('Read today', 1000);
  const merged = M.mergeState(
    state({ books: [book('b1', 'A', T0), book('b2', 'B', T0)], journal: { b1: [], b2: [e] }, entryDel: { [idJ('b1', e)]: T0 } }),
    state({ books: [book('b1', 'A', T0), book('b2', 'B', T0)], journal: { b1: [e], b2: [e] } })
  );
  assert.deepEqual(merged.journal.b1, []);
  assert.equal(merged.journal.b2.length, 1);
});

test('entries from an older app version count as oldest and lose to a tombstone', () => {
  // A device that hasn't updated sends entries with no `at` at all.
  const legacy = { date: '2026-10-01', time: '9:00 PM', text: 'old' };
  const merged = M.mergeState(
    state({ books: [book('b1', 'Dune', T0)], journal: { b1: [] }, entryDel: { [idJ('b1', legacy)]: T0 } }),
    state({ books: [book('b1', 'Dune', T0)], journal: { b1: [legacy] } })
  );
  assert.deepEqual(merged.journal.b1, []);
});

test('a journal tombstone does not touch a progress entry, and vice versa', () => {
  const j = J('same', 1000);
  const merged = M.mergeState(
    state({ books: [book('b1', 'Dune', T0)], journal: { b1: [j] }, prog: { b1: [P(50, 1000)] },
            entryDel: { [idP('b1', j)]: T0 } }),
    state({ books: [book('b1', 'Dune', T0)] })
  );
  assert.equal(merged.journal.b1.length, 1);
});

test('entry tombstones are forgotten after the TTL', () => {
  const merged = M.mergeState(state({ entryDel: { 'j|b1|x': Date.now() - 61 * 86400000 } }), state());
  assert.equal(merged.entryDel['j|b1|x'], undefined);
});

test('merging does not mutate the inputs', () => {
  const e = { date: '2026-10-01', time: '9:00 PM', text: 'untouched' };
  const local = state({ books: [book('b1', 'Dune', T0)], journal: { b1: [e] } });
  M.mergeState(local, state());
  assert.equal(e.at, undefined, 'the caller\'s objects are left alone');
});

test('merging with entry tombstones still converges', () => {
  const e = J('gone', 1000);
  const a = state({ books: [book('b1', 'Dune', T0)], journal: { b1: [J('kept', 2000)] }, entryDel: { [idJ('b1', e)]: T0 } });
  const b = state({ books: [book('b1', 'Dune', T0)], journal: { b1: [e, J('kept', 2000)] } });
  const once = M.mergeState(a, b);
  assert.deepEqual(M.mergeState(once, once), once);
});

test('normEntries marks existing entries as older than any tombstone', () => {
  const map = { b1: [{ text: 'a' }, { text: 'b', at: 5 }] };
  M.normEntries(map);
  assert.equal(map.b1[0].at, 1);
  assert.equal(map.b1[1].at, 5, 'a real timestamp is kept');
});
