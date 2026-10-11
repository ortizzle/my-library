// Unit tests for the vocabulary list: the review schedule, which question a
// word gets, the fill-in-the-blank matching, definition parsing, and that
// words survive sync like books do (including deletes).

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions, extractConst } from './extract.mjs';

const V = loadFunctions(['vocabInterval', 'addDaysStr', 'vocabStatus', 'vocabGrade', 'vocabDue',
                         'vocabNextDue', 'escRegExp', 'vocabBlank', 'vocabNorm', 'vocabCheckAnswer',
                         'vocabDistractorPool', 'vocabChoices', 'vocabFormat', 'parseDefinition',
                         'parseDictionary']);
const M = loadFunctions(
  ['mergeDeleted', 'mergeBooks', 'entryKey', 'entryId', 'mergeEntryMap', 'dropDeletedEntries',
   'mergeIdMap', 'mergeState', 'remoteState'],
  `const TOMBSTONE_TTL=${extractConst('TOMBSTONE_TTL')};`
);

const word = (id, w, extra = {}) => ({ id, word: w, definition: `meaning of ${w}`, box: 0, reviews: 0,
                                       due: '2026-10-11', addedAt: 1, ...extra });

// ── schedule ─────────────────────────────────────────────────────────────

test('dates move by calendar day, across months and DST', () => {
  assert.equal(V.addDaysStr('2026-10-11', 1), '2026-10-12');
  assert.equal(V.addDaysStr('2026-10-31', 3), '2026-11-03');
  assert.equal(V.addDaysStr('2026-12-31', 1), '2027-01-01');
  assert.equal(V.addDaysStr('2026-11-01', 1), '2026-11-02', 'US clocks change this day');
});

test('each right answer pushes the next review further out', () => {
  let w = word('w1', 'lugubrious');
  const seen = [];
  for (let i = 0; i < 7; i++) {
    w = V.vocabGrade(w, true, '2026-10-11', 1000 + i);
    seen.push([w.box, w.due]);
  }
  assert.deepEqual(seen.map(s => s[1]), ['2026-10-12', '2026-10-14', '2026-10-18', '2026-10-25',
                                         '2026-11-10', '2026-12-10', '2026-12-10'],
                   '1, 3, 7, 14, 30, 60 days, and it stays at the top box');
  assert.equal(w.box, 6);
  assert.equal(w.reviews, 7);
  assert.equal(w.updatedAt, 1006, 'a review is an edit, so it wins a sync');
});

test('a wrong answer sends the word back to the start, due tomorrow', () => {
  const w = V.vocabGrade(word('w1', 'x', { box: 5, reviews: 9 }), false, '2026-10-11', 5);
  assert.equal(w.box, 0);
  assert.equal(w.due, '2026-10-12');
  assert.equal(w.lapses, 1);
  assert.equal(w.reviews, 10);
});

test('grading returns a copy and leaves the original alone', () => {
  const w = word('w1', 'x');
  V.vocabGrade(w, true, '2026-10-11', 5);
  assert.equal(w.box, 0);
  assert.equal(w.reviews, 0);
});

test('status: new until reviewed, mastered from box 5', () => {
  assert.equal(V.vocabStatus(word('a', 'a')), 'new');
  assert.equal(V.vocabStatus(word('a', 'a', { reviews: 1, box: 1 })), 'learning');
  assert.equal(V.vocabStatus(word('a', 'a', { reviews: 4, box: 4 })), 'learning');
  assert.equal(V.vocabStatus(word('a', 'a', { reviews: 5, box: 5 })), 'mastered');
  assert.equal(V.vocabStatus(word('a', 'a', { reviews: 12, box: 0 })), 'learning', 'a lapse is not new');
});

test('due words: overdue first, future and undefined words left out', () => {
  const list = [
    word('later', 'later', { due: '2026-10-20' }),
    word('today', 'today', { due: '2026-10-11', addedAt: 5 }),
    word('old', 'old', { due: '2026-10-01' }),
    word('nodef', 'nodef', { definition: '' }),
    word('today2', 'today2', { due: '2026-10-11', addedAt: 2 }),
  ];
  assert.deepEqual(V.vocabDue(list, '2026-10-11').map(w => w.id), ['old', 'today2', 'today']);
  assert.equal(V.vocabNextDue(list, '2026-10-11'), '2026-10-20');
  assert.equal(V.vocabNextDue([], '2026-10-11'), '');
});

// ── fill in the blank ────────────────────────────────────────────────────

test('blanks the word in its sentence, keeping the rest exactly', () => {
  const b = V.vocabBlank('The room had a lugubrious air about it.', 'lugubrious');
  assert.deepEqual(b, { before: 'The room had a ', after: ' air about it.', form: 'lugubrious' });
});

test('finds the word when the book inflects it', () => {
  assert.equal(V.vocabBlank('She kept obfuscating the point.', 'obfuscate').form, 'obfuscating');
  assert.equal(V.vocabBlank('He parried every question.', 'parry').form, 'parried');
  assert.equal(V.vocabBlank('Two ephemera drifted past.', 'ephemera').form, 'ephemera');
  assert.equal(V.vocabBlank('Sesquipedalian words, all of them.', 'sesquipedalian').form, 'Sesquipedalian');
  assert.equal(V.vocabBlank('They were inured to it.', 'inure').form, 'inured');
});

test('does not match the word inside a longer one', () => {
  assert.equal(V.vocabBlank('That was cathartic.', 'cat'), null);
  assert.equal(V.vocabBlank('A scattered crowd.', 'cat'), null);
  assert.equal(V.vocabBlank('', 'cat'), null);
  assert.equal(V.vocabBlank('No word here', ''), null);
});

test('regex characters in a word are taken literally', () => {
  assert.equal(V.vocabBlank('It was a sort of déjà vu.', 'déjà vu').form, 'déjà vu');
  assert.equal(V.vocabBlank('Write C++ daily.', 'c++').form, 'C++', 'plus signs matched literally');
  assert.equal(V.vocabBlank('aaaa', 'a.'), null, 'the dot is not a wildcard');
});

test('accepts the word or the form in the sentence, ignoring case and punctuation', () => {
  assert.equal(V.vocabCheckAnswer('Obfuscate', 'obfuscate', 'obfuscating'), true);
  assert.equal(V.vocabCheckAnswer(' obfuscating. ', 'obfuscate', 'obfuscating'), true);
  assert.equal(V.vocabCheckAnswer('obfuscated', 'obfuscate', 'obfuscating'), false);
  assert.equal(V.vocabCheckAnswer('', 'obfuscate', 'obfuscating'), false);
  assert.equal(V.vocabCheckAnswer('don’t', "don't", null), true, 'curly apostrophe from the keyboard');
});

// ── multiple choice ──────────────────────────────────────────────────────

test('choices: the right definition plus three different wrong ones', () => {
  const list = [word('a', 'alpha'), word('b', 'beta'), word('c', 'gamma'), word('d', 'delta'), word('e', 'epsilon')];
  const opts = V.vocabChoices(list[0], list, () => 0.5);
  assert.equal(opts.length, 4);
  assert.equal(opts.filter(o => o.correct).length, 1);
  assert.equal(opts.find(o => o.correct).text, 'meaning of alpha');
  assert.equal(new Set(opts.map(o => o.text)).size, 4, 'no duplicate options');
});

test('wrong answers never repeat the right definition or the same word', () => {
  const w = word('a', 'alpha');
  const list = [w, word('b', 'beta', { definition: 'meaning of alpha' }), word('c', 'Alpha', { definition: 'other' }),
                word('d', 'delta'), word('e', 'eps', { definition: 'meaning of delta' })];
  assert.deepEqual(V.vocabDistractorPool(w, list).map(o => o.id), ['d']);
});

test('question type follows the box, falling back when it cannot be asked', () => {
  const others = [word('b', 'beta'), word('c', 'gamma'), word('d', 'delta')];
  const s = 'A lugubrious tune.';
  const w = box => word('a', 'lugubrious', { box, sentence: s });
  assert.equal(V.vocabFormat(w(0), [w(0), ...others]), 'flash', 'new word: flashcard');
  assert.equal(V.vocabFormat(w(1), [w(1), ...others]), 'choice');
  assert.equal(V.vocabFormat(w(2), [w(2), ...others]), 'choice');
  assert.equal(V.vocabFormat(w(3), [w(3), ...others]), 'blank', 'well known: use it in the sentence');
  assert.equal(V.vocabFormat(w(1), [w(1), others[0]]), 'flash', 'too few words for four choices');
  const noSentence = word('a', 'lugubrious', { box: 4 });
  assert.equal(V.vocabFormat(noSentence, [noSentence, ...others]), 'choice', 'no sentence: no blank');
  assert.equal(V.vocabFormat(noSentence, [noSentence]), 'flash');
});

// ── definitions ──────────────────────────────────────────────────────────

test('reads Claude’s JSON, with or without a code fence', () => {
  const want = { pos: 'adjective', definition: 'mournful, dismal', note: 'from Latin lugere' };
  assert.deepEqual(V.parseDefinition('{"pos":"adjective","definition":"mournful, dismal","note":"from Latin lugere"}'), want);
  assert.deepEqual(V.parseDefinition('```json\n{"pos":"adjective","definition":"mournful, dismal","note":"from Latin lugere"}\n```'), want);
  assert.deepEqual(V.parseDefinition('Here you go: {"pos":"adjective","definition":"mournful, dismal","note":"from Latin lugere"}'), want);
});

test('a reply that is not JSON becomes the definition itself', () => {
  assert.deepEqual(V.parseDefinition('Mournful; gloomy.'), { pos: '', definition: 'Mournful; gloomy.', note: '' });
  assert.deepEqual(V.parseDefinition('{"definition":""}'), { pos: '', definition: '{"definition":""}', note: '' });
  assert.equal(V.parseDefinition('   '), null);
});

test('takes the first sense from the free dictionary', () => {
  const data = [{ word: 'lugubrious', meanings: [
    { partOfSpeech: 'adjective', definitions: [{ definition: 'Gloomy, mournful or dismal.', example: 'a lugubrious tune' }] },
    { partOfSpeech: 'noun', definitions: [{ definition: 'not this one' }] }] }];
  assert.deepEqual(V.parseDictionary(data), { pos: 'adjective', definition: 'Gloomy, mournful or dismal.', note: 'e.g. “a lugubrious tune”' });
  assert.equal(V.parseDictionary({ title: 'No Definitions Found' }), null);
  assert.equal(V.parseDictionary([{ meanings: [] }]), null);
});

// ── sync ─────────────────────────────────────────────────────────────────

const T0 = Date.now() - 86400000;
const state = (o = {}) => ({ books: [], prog: {}, journal: {}, covers: {}, cacheQ: {}, favQ: {},
                             streak: {}, rooms: [], goals: {}, deleted: {}, vocab: [], ...o });

test('words added on two devices are both kept', () => {
  const a = state({ vocab: [word('w_a', 'alpha', { updatedAt: T0, addedAt: T0 })] });
  const b = state({ vocab: [word('w_b', 'beta', { updatedAt: T0 + 5, addedAt: T0 + 5 })] });
  assert.deepEqual(M.mergeState(a, b).vocab.map(w => w.id), ['w_b', 'w_a']);
});

test('the more recent review wins', () => {
  const a = state({ vocab: [word('w1', 'alpha', { box: 3, updatedAt: T0 + 10 })] });
  const b = state({ vocab: [word('w1', 'alpha', { box: 1, updatedAt: T0 })] });
  assert.equal(M.mergeState(a, b).vocab[0].box, 3);
  assert.equal(M.mergeState(b, a).vocab[0].box, 3);
});

test('a deleted word does not come back from the other device', () => {
  const local = state({ deleted: { w1: T0 + 10 } });
  const remote = state({ vocab: [word('w1', 'alpha', { updatedAt: T0 })] });
  assert.deepEqual(M.mergeState(local, remote).vocab, []);
});

test('a gist from before vocabulary existed keeps the local words', () => {
  const local = state({ vocab: [word('w1', 'alpha', { updatedAt: T0 })] });
  const remote = M.remoteState({ books: [], streak: {} });
  assert.deepEqual(remote.vocab, []);
  assert.equal(M.mergeState(local, remote).vocab.length, 1);
  assert.deepEqual(M.remoteState({ vocab: { not: 'an array' } }).vocab, [], 'bad shape is ignored');
});
