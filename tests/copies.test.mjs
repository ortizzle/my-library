// How a reader has a book: each format owned or borrowed. Old records (a flat
// formats list where "borrowed" didn't say which format) are read through
// copiesFromLegacy until they're next saved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions, extractConst } from './extract.mjs';

const C = loadFunctions(['copiesFromLegacy', 'bookCopies', 'copiesNeedReview', 'formatsFromCopies', 'copiesText', 'ownsAny'],
  `const COPY_FORMATS=${extractConst('COPY_FORMATS')};`);

test('old records: no library loan means everything is owned, notes carried over', () => {
  assert.deepEqual(C.copiesFromLegacy({ formats: ['physical', 'audio', 'ebook'], srcPhysical: 'Hardcover', srcAudio: 'Audible', srcEbook: 'Kindle' }),
    { physical: { how: 'own', note: 'Hardcover' }, ebook: { how: 'own', note: 'Kindle' }, audio: { how: 'own', note: 'Audible' } });
  assert.deepEqual(C.copiesFromLegacy({}), {});
  assert.deepEqual(C.copiesFromLegacy({ formats: ['wishlist'] }), {}, 'the old wishlist chip is dropped');
});

test('old records: a library loan with one format borrows that format', () => {
  assert.deepEqual(C.copiesFromLegacy({ formats: ['audio', 'borrowed'], srcBorrowed: 'Libby' }), { audio: { how: 'borrowed', note: 'Libby' } });
  assert.equal(C.copiesNeedReview({ formats: ['audio', 'borrowed'] }), false);
});

test('old records: a library loan with several formats guesses the digital copy, and asks to be checked', () => {
  const b = { formats: ['physical', 'audio', 'borrowed'], srcPhysical: 'Paperback', srcBorrowed: 'Libby' };
  assert.deepEqual(C.copiesFromLegacy(b), { physical: { how: 'own', note: 'Paperback' }, audio: { how: 'borrowed', note: 'Libby' } });
  assert.equal(C.copiesNeedReview(b), true);
  assert.equal(C.copiesNeedReview({ formats: ['borrowed'] }), true, 'a loan with no format recorded');
  assert.equal(C.copiesNeedReview({ ...b, copies: { physical: { how: 'own', note: '' } } }), false, 'once saved, nothing to check');
});

test('new records win; the flat list and text follow from them', () => {
  const copies = { physical: { how: 'own', note: 'Hardcover, signed' }, audio: { how: 'borrowed', note: 'Libby' } };
  const b = { copies, formats: ['ebook'] };
  assert.deepEqual(C.bookCopies(b), copies);
  assert.deepEqual(C.formatsFromCopies(copies), ['physical', 'audio', 'borrowed']);
  assert.equal(C.copiesText(copies), 'Print (own: Hardcover, signed); Audio (borrowed: Libby)');
  assert.equal(C.ownsAny(b), true);
  assert.equal(C.ownsAny({ copies: { audio: { how: 'borrowed', note: '' } } }), false, 'a borrowed copy isn’t owned');
});
