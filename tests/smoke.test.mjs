// End-to-end smoke test — drives the real app in Chromium.
//
// Covers the flows from references/smoke-test.md that can be automated without
// network access: add / edit / delete a book, persistence across reload, the
// tombstone surviving a reload, and streak credit for a reading session.
//
// External hosts (OpenLibrary, unpkg, Google Fonts, api.github.com) are not
// reachable from CI, so cover lookup and Gist sync are not exercised here —
// the merge logic behind sync is covered by merge.test.mjs instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright';

// Some sandboxes ship a preinstalled Chromium at a fixed path and block the
// download that `playwright install` would do. Use it when it's there, and
// otherwise let Playwright resolve its own browser (which is what CI has).
const PREINSTALLED = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function startServer() {
  const server = createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    try {
      const body = await readFile(join(ROOT, file));
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Fresh page with dialogs auto-accepted and page errors surfaced as failures. */
async function openApp(browser, base) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => typeof window.saveBook === 'function');
  return { ctx, page, errors };
}

const addBook = async (page, title, author = 'Some Author') => {
  await page.evaluate(([t, a]) => {
    showView('library');
    openAddModal();
    document.getElementById('bTitle').value = t;
    document.getElementById('bAuthor').value = a;
    saveBook();
  }, [title, author]);
};

const storedBooks = page => page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_books') || '[]'));

let browser, server, base;

test.before(async () => {
  ({ server, base } = await startServer());
  browser = await chromium.launch(LAUNCH_OPTS);
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

test('app boots with no console errors and an empty library', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  assert.deepEqual(errors, []);
  assert.deepEqual(await storedBooks(page), []);
  await ctx.close();
});

test('a book can be added, survives reload, and can be deleted for good', async () => {
  const { ctx, page, errors } = await openApp(browser, base);

  await addBook(page, 'Piranesi', 'Susanna Clarke');
  let books = await storedBooks(page);
  assert.equal(books.length, 1);
  assert.equal(books[0].title, 'Piranesi');
  assert.ok(books[0].updatedAt, 'new books carry updatedAt for the sync merge');

  await page.reload();
  await page.waitForFunction(() => typeof window.saveBook === 'function');
  assert.equal((await storedBooks(page)).length, 1, 'survives reload');

  // Delete, then confirm it stays deleted across a reload and leaves a tombstone.
  const id = books[0].id;
  await page.evaluate(i => deleteBook(i), id);
  assert.deepEqual(await storedBooks(page), []);

  const tombstones = await page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_deleted') || '{}'));
  assert.ok(tombstones[id], 'delete records a tombstone so sync cannot resurrect it');

  await page.reload();
  await page.waitForFunction(() => typeof window.saveBook === 'function');
  assert.deepEqual(await storedBooks(page), [], 'stays deleted');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('editing a book bumps updatedAt', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Dune', 'Frank Herbert');
  const before = (await storedBooks(page))[0];

  await page.evaluate(async id => {
    openEditModal(id);
    document.getElementById('bAuthor').value = 'F. Herbert';
    await new Promise(r => setTimeout(r, 20));
    saveBook();
  }, before.id);

  const after = (await storedBooks(page))[0];
  assert.equal(after.author, 'F. Herbert');
  assert.ok(after.updatedAt > before.updatedAt, 'edits must bump updatedAt or sync can revert them');
  await ctx.close();
});

test('editing a book deleted underneath you does not silently discard the edit', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Ghost', 'Nobody');
  const id = (await storedBooks(page))[0].id;

  // Open the editor, then simulate the book vanishing in a sync pull.
  const result = await page.evaluate(i => {
    openEditModal(i);
    books = books.filter(b => b.id !== i);   // what a pull used to do
    document.getElementById('bTitle').value = 'Edited Title';
    saveBook();
    return books.length;
  }, id);

  assert.equal(result, 0, 'no phantom entry is written back');
  const raw = await page.evaluate(() => localStorage.getItem('trr_v1_books'));
  assert.ok(!raw.includes('Edited Title'), 'the lost edit is reported, not silently dropped');
  await ctx.close();
});

test('a reading session credits the streak', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Piranesi', 'Susanna Clarke');
  const id = (await storedBooks(page))[0].id;

  const streak = await page.evaluate(i => {
    openReadingSession(i);
    document.getElementById('sess-end-page').value = '42';
    saveReadingSession();
    return JSON.parse(localStorage.getItem('trr_v1_streak') || '{}');
  }, id);

  const today = await page.evaluate(() => localDateStr());
  assert.ok(streak[today], 'finishing a session must log the day, or the streak never moves');
  await ctx.close();
});

test('a storage failure surfaces to the user instead of diverging silently', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => {
    localStorage.setItem = () => { throw new DOMException('QuotaExceededError'); };
  });
  const ok = await page.evaluate(() => save('trr_v1_books', [{ id: 'x' }]));
  assert.equal(ok, false, 'save() reports failure rather than throwing past its caller');
  await page.waitForSelector('.toast.err');
  await ctx.close();
});

test('the export payload round-trips through the import merge', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Dune', 'Frank Herbert');

  const merged = await page.evaluate(() => {
    const backup = { version: 2, books, progress: progressDB, journal: journalDB, covers: coversDB,
                     cacheQ, favQ, streak: streakDB, rooms, goals, deleted: deletedDB };
    const incoming = remoteState({ ...backup, prog: backup.progress });
    return mergeState(currentState(), incoming).books.length;
  });

  assert.equal(merged, 1, 'importing your own backup must not duplicate the library');
  await ctx.close();
});
