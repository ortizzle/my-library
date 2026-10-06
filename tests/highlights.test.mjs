// Unit tests for highlight capture: the crop geometry and how a highlight
// renders. A highlight is a journal entry with type 'highlight', so these also
// pin down that plain notes render exactly as they did before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions } from './extract.mjs';

const H = loadFunctions(['esc', 'isHighlight', 'journalBodyHtml', 'journalBodyText', 'journalTag',
                         'boxFromPoints', 'cropRect', 'fitWithin']);

// ── geometry ─────────────────────────────────────────────────────────────

test('a drag in any direction gives the same box', () => {
  const down = H.boxFromPoints(10, 20, 110, 70, 400, 600);
  const up = H.boxFromPoints(110, 70, 10, 20, 400, 600);
  assert.deepEqual(down, { x: 10, y: 20, w: 100, h: 50 });
  assert.deepEqual(up, down, 'dragging up-left is the same selection');
});

test('a drag past the edge of the photo is clamped to it', () => {
  assert.deepEqual(H.boxFromPoints(-30, -10, 450, 700, 400, 600), { x: 0, y: 0, w: 400, h: 600 });
});

test('a box in screen pixels maps back to the full-size photo', () => {
  // Photo shown at a quarter size: a 100x50 box at (10,20) is 400x200 at (40,80).
  assert.deepEqual(H.cropRect({ x: 10, y: 20, w: 100, h: 50 }, 0.25, 4000, 3000),
                   { x: 40, y: 80, w: 400, h: 200 });
});

test('the crop never runs off the image or collapses to nothing', () => {
  const r = H.cropRect({ x: 390, y: 290, w: 50, h: 50 }, 0.1, 4000, 3000);
  assert.ok(r.x + r.w <= 4000 && r.y + r.h <= 3000, 'stays inside the source');
  assert.ok(r.w >= 1 && r.h >= 1);
});

test('the image sent is capped on its long edge, and small ones are not enlarged', () => {
  assert.deepEqual(H.fitWithin(4000, 3000, 1600), { w: 1600, h: 1200 });
  assert.deepEqual(H.fitWithin(3000, 4000, 1600), { w: 1200, h: 1600 }, 'portrait too');
  assert.deepEqual(H.fitWithin(800, 300, 1600), { w: 800, h: 300 }, 'never scales up');
  assert.deepEqual(H.fitWithin(0, 0, 1600), { w: 1, h: 1 }, 'a degenerate size is not a divide by zero');
});

// ── rendering ────────────────────────────────────────────────────────────

const HL = { date: '2026-10-06', time: '9:00 PM', type: 'highlight',
             text: 'It was the best of times,\nit was the worst of times.', page: '1', note: 'the opening' };
const NOTE = { date: '2026-10-06', time: '9:00 PM', text: 'Loved chapter 3.\nMore tomorrow.' };

test('a plain journal note renders as before', () => {
  assert.equal(H.isHighlight(NOTE), false);
  assert.equal(H.journalBodyHtml(NOTE), 'Loved chapter 3.<br>More tomorrow.');
  assert.equal(H.journalBodyText(NOTE), NOTE.text);
  assert.equal(H.journalTag(NOTE), '');
});

test('a highlight renders as a quote with its page and note', () => {
  const html = H.journalBodyHtml(HL);
  assert.match(html, /class="hl-quote"/);
  assert.match(html, /best of times,<br>it was/);
  assert.match(html, /p\. 1 · the opening/);
  assert.equal(H.journalTag(HL), ' · ✦ Highlight');
});

test('the print view gets inline styles, since it has no stylesheet', () => {
  const html = H.journalBodyHtml(HL, true);
  assert.doesNotMatch(html, /class=/);
  assert.match(html, /style="display:block;border-left/);
});

test('copied text quotes the passage and keeps the page and note', () => {
  assert.equal(H.journalBodyText(HL),
    '“It was the best of times,\nit was the worst of times.” (p. 1)\nthe opening');
  assert.equal(H.journalBodyText({ ...HL, page: '', note: '' }),
    '“It was the best of times,\nit was the worst of times.”', 'no empty page or note clutter');
});

test('page and note are optional', () => {
  const html = H.journalBodyHtml({ type: 'highlight', text: 'Just the words.' });
  assert.doesNotMatch(html, /hl-meta/, 'no empty meta line');
});

test('passage, page and note are escaped — the text came from a photo and an OCR', () => {
  const html = H.journalBodyHtml({ type: 'highlight', text: '<img src=x onerror=alert(1)>',
                                   page: '<b>', note: '"><script>' });
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.match(html, /&lt;img/);
});
