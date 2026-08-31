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

// ── Lookup fallback ───────────────────────────────────────────────────────
// Neither catalogue is reachable from CI, so both are stubbed at the network
// layer. This drives the real lookupISBN() against those stubs.

const ALGORITHM_GB = {
  totalItems: 1,
  items: [{
    volumeInfo: {
      title: 'The Algorithm',
      subtitle: 'The Hypergrowth Formula that Transformed Tesla, Lululemon, General Motors and SpaceX',
      authors: ['Jon McNeill'],
      publishedDate: '2025-09-02',
      pageCount: 272,
      categories: ['Business & Economics / Leadership'],
      industryIdentifiers: [{ type: 'ISBN_13', identifier: '9798217177530' }],
      imageLinks: { thumbnail: 'http://books.google.com/books/content?id=X&img=1&zoom=1&edge=curl' }
    }
  }]
};

/**
 * Stub both catalogues, routing by path so the two OpenLibrary endpoints can
 * answer independently: /api/books is the ISBN lookup, /search.json backs both
 * title search and the cover-by-title fallback.
 */
async function stubCatalogues(page, { olBooks = {}, olSearch = { docs: [] }, gb = { totalItems: 0, items: [] } } = {}) {
  const calls = [];
  await page.route('**://openlibrary.org/**', route => {
    const isSearch = route.request().url().includes('/search.json');
    calls.push(isSearch ? 'ol-search' : 'ol-books');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(isSearch ? olSearch : olBooks) });
  });
  await page.route('**://www.googleapis.com/books/**', route => {
    calls.push('google');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(gb) });
  });
  // Cover image probes must not hang the test.
  await page.route('**://covers.openlibrary.org/**', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**://books.google.com/**', route => route.fulfill({ status: 404, body: '' }));
  return calls;
}

const isbnLookup = async (page, isbn) => page.evaluate(async i => {
  showView('library');
  openAddModal();
  document.getElementById('isbnInput').value = i;
  await lookupISBN();
  return {
    title: document.getElementById('bTitle').value,
    author: document.getElementById('bAuthor').value,
    genre: document.getElementById('bGenre').value,
    pages: document.getElementById('progTotalPage').value,
    status: document.getElementById('isbnStatus').textContent
  };
}, isbn);

test('an ISBN missing from OpenLibrary falls through to Google Books', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const calls = await stubCatalogues(page, { gb: ALGORITHM_GB });

  const r = await isbnLookup(page, '9798217177530');

  assert.match(r.title, /^The Algorithm/, 'the fallback filled the form');
  assert.equal(r.author, 'Jon McNeill');
  assert.equal(r.pages, '272');
  assert.equal(r.genre, 'Business', 'categories map to a genre');
  assert.match(r.status, /Google Books/, 'the user is told which catalogue answered');
  assert.ok(calls.includes('ol-books'), 'OpenLibrary is still tried first');
  assert.ok(calls.includes('google'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('OpenLibrary still wins when it has the book', async () => {
  const { ctx, page } = await openApp(browser, base);
  const calls = await stubCatalogues(page, {
    olBooks: { 'ISBN:9780441013593': { title: 'Dune', authors: [{ name: 'Frank Herbert' }], number_of_pages: 412, subjects: ['Science Fiction'] } },
    olSearch: { docs: [{ cover_i: 123 }] },   // OpenLibrary also supplies the cover
    gb: ALGORITHM_GB
  });

  const r = await isbnLookup(page, '9780441013593');

  assert.equal(r.title, 'Dune');
  assert.equal(r.pages, '412');
  assert.equal(r.genre, 'Science Fiction', 'not Literary Fiction — specific genres win');
  assert.doesNotMatch(r.status, /Google Books/, 'the record came from OpenLibrary');
  assert.ok(!calls.includes('google'), 'Google Books is not consulted at all when OpenLibrary covers it');
  await ctx.close();
});

test('a miss in both catalogues reports it instead of half-filling the form', async () => {
  const { ctx, page } = await openApp(browser, base);
  await stubCatalogues(page, {});   // both catalogues empty

  const r = await isbnLookup(page, '9999999999999');

  assert.equal(r.title, '');
  assert.match(r.status, /Not found in either/);
  await ctx.close();
});

test('a failing OpenLibrary does not stop the Google Books fallback', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.route('**://openlibrary.org/**', route => route.abort('failed'));
  await page.route('**://www.googleapis.com/books/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALGORITHM_GB) }));
  await page.route('**://covers.openlibrary.org/**', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**://books.google.com/**', route => route.fulfill({ status: 404, body: '' }));

  const r = await isbnLookup(page, '9798217177530');
  assert.match(r.title, /^The Algorithm/, 'a network error is a miss, not a dead end');
  await ctx.close();
});

test('title search falls back to Google Books and renders the results', async () => {
  // The result list was rewritten to a shared record shape; this drives the
  // real render rather than the data layer alone.
  const { ctx, page, errors } = await openApp(browser, base);
  await stubCatalogues(page, { olSearch: { docs: [] }, gb: ALGORITHM_GB });

  const rendered = await page.evaluate(async () => {
    showView('library');
    openAddModal();
    document.getElementById('titleSearchInput').value = 'the algorithm mcneill';
    await searchByTitle();
    const wrap = document.getElementById('titleSearchResults');
    return { visible: wrap.style.display, rows: wrap.querySelectorAll('[onclick^="selectTitleResult"]').length, text: wrap.textContent };
  });

  assert.equal(rendered.visible, 'block');
  assert.equal(rendered.rows, 1);
  assert.match(rendered.text, /The Algorithm/);
  assert.match(rendered.text, /Jon McNeill/);
  assert.match(rendered.text, /2025/, 'the year comes through the normalised shape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('picking a search result fills the form', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await stubCatalogues(page, { olSearch: { docs: [] }, gb: ALGORITHM_GB });

  const filled = await page.evaluate(async () => {
    showView('library');
    openAddModal();
    document.getElementById('titleSearchInput').value = 'the algorithm';
    await searchByTitle();
    await selectTitleResult(0);
    return {
      title: document.getElementById('bTitle').value,
      author: document.getElementById('bAuthor').value,
      pages: document.getElementById('progTotalPage').value,
      isbn: document.getElementById('isbnInput').value
    };
  });

  assert.match(filled.title, /^The Algorithm/);
  assert.equal(filled.author, 'Jon McNeill');
  assert.equal(filled.pages, '272');
  assert.equal(filled.isbn, '9798217177530');
  assert.deepEqual(errors, []);
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
