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
  // Service workers are blocked. Once the app's worker controls the page it
  // fetches cover images itself, and page.route never sees those requests — so
  // a stubbed cover was really fetched from the network. That made results
  // depend on the environment: a test that passed in a sandbox without
  // internet timed out on CI, where the real cover loaded. None of these tests
  // exercise the worker itself.
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  // Mind maps are made automatically for finished books with a key set. Most
  // tests seed exactly that and count Claude calls, so it starts off here; the
  // tests for it turn it on.
  await ctx.addInitScript(() => { if (localStorage.getItem('trr_v1_mm_auto') === null) localStorage.setItem('trr_v1_mm_auto', 'off'); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  // The free dictionary is never reached for real: a test that wants it
  // registers its own stub, which takes precedence over this one.
  await page.route('https://api.dictionaryapi.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
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
  assert.match(r.status, /Not in either catalogue/, 'a genuine miss still reads as a miss');
  await ctx.close();
});

test('a rate-limited Google Books reports the rate limit, not "not found"', async () => {
  // This is the bug that made the live failure undiagnosable: gbQuery returned
  // [] for a 429 exactly as it did for zero results, so a throttled lookup was
  // indistinguishable from a book no catalogue has.
  const { ctx, page } = await openApp(browser, base);
  await page.route('**://openlibrary.org/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**://www.googleapis.com/books/**', route =>
    route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":{"code":429}}' }));
  await page.route('**://covers.openlibrary.org/**', route => route.fulfill({ status: 404, body: '' }));

  const r = await isbnLookup(page, '9798217177530');

  assert.match(r.status, /Lookup failed/, 'a failure is reported as a failure');
  assert.match(r.status, /Google Books HTTP 429/, 'and names the actual cause');
  assert.doesNotMatch(r.status, /Not in either catalogue/);
  await ctx.close();
});

// Claude is the last resort: only with a key, only after both catalogues miss.
async function stubClaudeRoute(page, text) {
  const reqs = [];
  await page.route('**://api.anthropic.com/**', route => {
    reqs.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) });
  });
  return reqs;
}

test('an ISBN neither catalogue has is found by Claude web search', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await stubCatalogues(page, {});
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const reqs = await stubClaudeRoute(page, 'Here it is:\n```json\n{"found":true,"title":"Fruit Fly","authors":["Josh Silver"],"year":2025,"pages":384,"genre":"Mystery / Thriller","format":"hardcover"}\n```');

  const r = await isbnLookup(page, '9798892426367');

  assert.equal(r.title, 'Fruit Fly');
  assert.equal(r.author, 'Josh Silver');
  assert.equal(r.pages, '384');
  assert.equal(r.genre, 'Mystery / Thriller');
  assert.match(r.status, /found by Claude/, 'the user is told to check a web-found record');
  assert.equal(reqs.length, 1);
  assert.match(reqs[0].messages[0].content, /9798892426367/);
  assert.equal(reqs[0].tools[0].name, 'web_search');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Claude not finding the ISBN reads as a miss; no key means no Claude call', async () => {
  const { ctx, page } = await openApp(browser, base);
  await stubCatalogues(page, {});
  const reqs = await stubClaudeRoute(page, '{"found":false}');

  let r = await isbnLookup(page, '9999999999999');
  assert.equal(reqs.length, 0, 'no key, no request');
  assert.match(r.status, /Not in either catalogue\./);

  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  r = await isbnLookup(page, '9999999999999');
  assert.equal(reqs.length, 1);
  assert.equal(r.title, '');
  assert.match(r.status, /Claude couldn’t find it/);
  await ctx.close();
});

test('Claude is not asked when Google Books has the book', async () => {
  const { ctx, page } = await openApp(browser, base);
  await stubCatalogues(page, { gb: ALGORITHM_GB });
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const reqs = await stubClaudeRoute(page, '{"found":false}');
  const r = await isbnLookup(page, '9798217177530');
  assert.match(r.title, /^The Algorithm/);
  assert.equal(reqs.length, 0);
  await ctx.close();
});

test('a 403 from Google Books is reported too', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.route('**://openlibrary.org/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**://www.googleapis.com/books/**', route =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }));
  await page.route('**://covers.openlibrary.org/**', route => route.fulfill({ status: 404, body: '' }));

  const r = await isbnLookup(page, '9798217177530');
  assert.match(r.status, /Google Books HTTP 403/);
  await ctx.close();
});

test('both catalogues failing names both', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.route('**://openlibrary.org/**', route => route.fulfill({ status: 500, body: '' }));
  await page.route('**://www.googleapis.com/books/**', route => route.abort('failed'));
  await page.route('**://covers.openlibrary.org/**', route => route.fulfill({ status: 404, body: '' }));

  const r = await isbnLookup(page, '9798217177530');
  assert.match(r.status, /OpenLibrary HTTP 500/);
  assert.match(r.status, /Google Books network or CORS blocked/);
  await ctx.close();
});

test('the Google Books request carries a country so it is not 403d', async () => {
  // Google Books answers 403 in some regions when country is absent.
  const { ctx, page } = await openApp(browser, base);
  const urls = [];
  await page.route('**://openlibrary.org/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**://www.googleapis.com/books/**', route => {
    urls.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALGORITHM_GB) });
  });
  await page.route('**://books.google.com/**', route => route.fulfill({ status: 404, body: '' }));

  await isbnLookup(page, '9798217177530');
  assert.ok(urls.length > 0);
  assert.ok(urls.every(u => u.includes('country=US')), 'every Google Books call sets country');
  await ctx.close();
});

test('a failed title search reports why instead of "no results"', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.route('**://openlibrary.org/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"docs":[]}' }));
  await page.route('**://www.googleapis.com/books/**', route =>
    route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }));

  const status = await page.evaluate(async () => {
    showView('library');
    openAddModal();
    document.getElementById('titleSearchInput').value = 'the algorithm mcneill';
    await searchByTitle();
    return document.getElementById('isbnStatus').textContent;
  });

  assert.match(status, /Search failed/);
  assert.match(status, /Google Books HTTP 429/);
  await ctx.close();
});

test('a saved Google Books key is sent with every lookup', async () => {
  // Unauthenticated quota is per IP and shared with everyone on the network,
  // which is what was producing constant 429s on mobile data.
  const { ctx, page } = await openApp(browser, base);
  const urls = [];
  await page.route('**://openlibrary.org/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**://www.googleapis.com/books/**', route => {
    urls.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALGORITHM_GB) });
  });
  await page.route('**://books.google.com/**', route => route.fulfill({ status: 404, body: '' }));

  await page.evaluate(() => localStorage.setItem('trr_v1_gbkey', 'AIzaTESTKEY'));
  await isbnLookup(page, '9798217177530');

  assert.ok(urls.length > 0);
  assert.ok(urls.every(u => u.includes('key=AIzaTESTKEY')), 'the key rides along on every call');
  await ctx.close();
});

test('no key set means no key parameter, not an empty one', async () => {
  const { ctx, page } = await openApp(browser, base);
  const urls = [];
  await page.route('**://openlibrary.org/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**://www.googleapis.com/books/**', route => {
    urls.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALGORITHM_GB) });
  });
  await page.route('**://books.google.com/**', route => route.fulfill({ status: 404, body: '' }));

  await isbnLookup(page, '9798217177530');
  assert.ok(urls.every(u => !u.includes('key=')), 'an empty key= would be rejected by the API');
  await ctx.close();
});

test('a 429 with no key points at the fix; with a key it does not', async () => {
  const stub429 = async page => {
    await page.route('**://openlibrary.org/**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.route('**://www.googleapis.com/books/**', route =>
      route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }));
    await page.route('**://covers.openlibrary.org/**', route => route.fulfill({ status: 404, body: '' }));
    await page.route('**://m.media-amazon.com/**', route => route.fulfill({ status: 404, body: '' }));
  };

  const a = await openApp(browser, base);
  await stub429(a.page);
  const noKey = await isbnLookup(a.page, '9780593717202');
  assert.match(noKey.status, /Google Books HTTP 429/);
  assert.match(noKey.status, /Google Books API key in Settings/, 'a fixable failure says how to fix it');
  await a.ctx.close();

  const b = await openApp(browser, base);
  await stub429(b.page);
  await b.page.evaluate(() => localStorage.setItem('trr_v1_gbkey', 'AIzaTESTKEY'));
  const withKey = await isbnLookup(b.page, '9780593717202');
  assert.match(withKey.status, /Google Books HTTP 429/);
  assert.doesNotMatch(withKey.status, /key in Settings/, 'no point suggesting a key that is already set');
  await b.ctx.close();
});

test('a failed lookup still finds a cover from the ISBN alone', async () => {
  // The manual-entry path shouldn't mean typing everything AND hunting for art.
  const { ctx, page } = await openApp(browser, base);
  await page.route('**://openlibrary.org/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**://www.googleapis.com/books/**', route =>
    route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }));
  await page.route('**://covers.openlibrary.org/**', route => route.fulfill({ status: 404, body: '' }));
  // A real 200x300 PNG so the width check passes.
  await page.route('**://m.media-amazon.com/**', route => route.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300"/></svg>'
  }));

  const r = await isbnLookup(page, '9780593717202');
  const cover = await page.evaluate(() => {
    const img = document.getElementById('coverPreviewImg');
    return { shown: img.style.display !== 'none', src: img.src };
  });

  assert.match(r.status, /found a cover, though/);
  assert.ok(cover.shown, 'the cover preview is populated');
  assert.match(cover.src, /0593717201/, 'keyed on the ISBN-10 derived from the ISBN-13');
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

// ── Entry deletes under sync ─────────────────────────────────────────────
// Stub the Gist as already holding the entry (it was pushed earlier), delete
// it in the real UI, run the real push, and read what was written.

const GIST = 'reading-room-library.json';
async function withGist(page, remotePayload) {
  const pushed = [];
  await page.route('**://api.github.com/gists/**', async route => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      pushed.push(JSON.parse(JSON.parse(req.postData()).files[GIST].content));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ files: { [GIST]: { content: JSON.stringify(remotePayload) } } }) });
  });
  await page.evaluate(() => {
    localStorage.setItem('trr_v1_gist_token', 'test-token');
    localStorage.setItem('trr_v1_gist_id', 'test-gist');
  });
  return pushed;
}

const seed = (page, { journal = [], prog = [] } = {}) => page.evaluate(([j, p]) => {
  books = [{ id: 'b1', title: 'Dune', author: 'Frank Herbert', status: 'reading', addedAt: 1, updatedAt: 1 }];
  journalDB = { b1: j }; progressDB = { b1: p };
  save('trr_v1_books', books); save('trr_v1_journal', journalDB); save('trr_v1_prog', progressDB);
}, [journal, prog]);

test('a deleted journal entry is not pushed back from the gist', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const entry = { date: '2026-10-01', time: '9:00 PM', text: 'delete me', at: 1000 };
  await seed(page, { journal: [entry] });
  const pushed = await withGist(page, { v: 2, books: [{ id: 'b1', title: 'Dune', updatedAt: 1, addedAt: 1 }],
                                        journal: { b1: [entry] } });

  await page.evaluate(async () => {
    openEditModal('b1');
    deleteJournalEntry('b1', 0);
    await gistPush();
  });

  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].journal.b1, [], 'the gist copy did not resurrect it');
  assert.deepEqual(await page.evaluate(() => journalDB.b1), [], 'and it stays gone locally');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a deleted progress entry is not pushed back from the gist', async () => {
  const { ctx, page } = await openApp(browser, base);
  const entry = { date: '2026-10-01', type: 'pages', cur: 120, total: 300, note: '', at: 1000 };
  await seed(page, { prog: [entry] });
  const pushed = await withGist(page, { v: 2, books: [{ id: 'b1', title: 'Dune', updatedAt: 1, addedAt: 1 }],
                                        prog: { b1: [entry] } });

  await page.evaluate(async () => {
    openEditModal('b1');
    renderProgHistoryEdit('b1', true);
    delProgEntryEdit('b1', 0);
    await gistPush();
  });

  assert.deepEqual(pushed[0].prog.b1, []);
  await ctx.close();
});

test('undoing a quick log sticks even after the push already went out', async () => {
  // The undo window is 5s and the push fires at 2.5s, so undoing in the second
  // half meant the gist already had the entry.
  const { ctx, page } = await openApp(browser, base);
  await seed(page);
  const pushed = await withGist(page, { v: 2, books: [{ id: 'b1', title: 'Dune', updatedAt: 1, addedAt: 1 }] });

  const logged = await page.evaluate(async () => {
    showView('log');
    logQuick('b1', 'Listened today');
    await gistPush();                     // the push lands before the undo
    return JSON.parse(JSON.stringify(progressDB.b1));
  });
  assert.ok(logged.length > 0, 'the quick log wrote a progress entry');

  // Make the stub hold what was just pushed, as the real gist would.
  await page.unroute('**://api.github.com/gists/**');
  const pushed2 = await withGist(page, pushed[0]);

  await page.evaluate(async () => {
    document.querySelector('.toast button').click();   // tap Undo
    await gistPush();
  });

  assert.deepEqual(pushed2[0].prog.b1 || [], [], 'the undone entry was not merged back in');
  await ctx.close();
});

test('undoing a quick log removes the streak day it added, even after the push', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seed(page);
  const pushed = await withGist(page, { v: 2, books: [{ id: 'b1', title: 'Dune', updatedAt: 1, addedAt: 1 }] });

  const today = await page.evaluate(async () => {
    showView('log'); logQuick('b1', 'Listened today'); await gistPush(); return localDateStr();
  });
  assert.ok(pushed[0].streak[today] > 0, 'the day went out with the push');

  await page.unroute('**://api.github.com/gists/**');
  const pushed2 = await withGist(page, pushed[0]);   // the gist now holds that day
  await page.evaluate(async () => { document.querySelector('.toast button').click(); await gistPush(); });

  assert.equal(pushed2[0].streak[today], undefined, 'the undone day did not come back from the gist');
  assert.equal(await page.evaluate(d => d in streakDB, today), false);
  await ctx.close();
});

test('undo leaves a day that already had reading on it', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seed(page);
  const kept = await page.evaluate(() => {
    const today = localDateStr();
    logDay(today);                                   // read earlier today
    showView('log'); logQuick('b1', 'Listened today');
    document.querySelector('.toast button').click(); // undo the second log
    return today in streakDB;
  });
  assert.equal(kept, true, 'undo only removes days the action itself added');
  await ctx.close();
});

test('undo does not delete a day that a sync merged in during the undo window', async () => {
  // The old undo restored a full snapshot, wiping anything that arrived meanwhile.
  const { ctx, page } = await openApp(browser, base);
  await seed(page);
  const survived = await page.evaluate(() => {
    showView('log'); logQuick('b1', 'Listened today');
    streakDB['2026-01-15'] = 1;                      // a pull brings in another device's day
    document.querySelector('.toast button').click();
    return '2026-01-15' in streakDB;
  });
  assert.equal(survived, true);
  await ctx.close();
});

test('a delete removes the entry that was on screen even if a sync re-sorted the list', async () => {
  const { ctx, page } = await openApp(browser, base);
  const a = { date: '2026-09-01', time: '8:00 AM', text: 'older', at: 1000 };
  const b = { date: '2026-10-01', time: '8:00 AM', text: 'newer', at: 2000 };
  await seed(page, { journal: [a, b] });

  const left = await page.evaluate(() => {
    openEditModal('b1');                 // renders newest first: "newer" is idx 1
    journalDB.b1.reverse();              // a pull reorders the live array underneath
    deleteJournalEntry('b1', 1);         // the user taps ✕ on "newer"
    return journalDB.b1.map(e => e.text);
  });

  assert.deepEqual(left, ['older'], 'the entry the user saw is the one removed');
  await ctx.close();
});

// ── Highlights ───────────────────────────────────────────────────────────
// The whole capture flow: open a book, pick a photo, drag across the passage,
// read it (Claude stubbed), confirm, save — then check the entry lands in the
// journal and shows up everywhere entries do.

async function openCapture(page) {
  await page.evaluate(() => {
    books = [{ id: 'b1', title: 'A Tale of Two Cities', author: 'Charles Dickens', status: 'reading', addedAt: 1, updatedAt: 1 }];
    journalDB = {}; save('trr_v1_books', books); save('trr_v1_journal', journalDB);
    openEditModal('b1');
    document.getElementById('hlOpenBtn').click();
  });
  assert.equal(await page.isVisible('#hlModal'), true);
}

async function choosePhoto(page) {
  // Any real PNG will do — a screenshot is one we can make on the spot.
  const png = await page.screenshot({ type: 'png' });
  await page.setInputFiles('#hlFile', { name: 'page.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => document.getElementById('hlMark').style.display === 'block');
}

async function dragBox(page, fx0, fy0, fx1, fy1) {
  const b = await page.locator('#hlStage').boundingBox();
  await page.mouse.move(b.x + b.width * fx0, b.y + b.height * fy0);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * fx1, b.y + b.height * fy1, { steps: 6 });
  await page.mouse.up();
}

// Claude is stubbed inside the page rather than with page.route. The request is
// cross-origin with custom headers, so Chromium sends a CORS preflight first,
// and that preflight goes to the network instead of through page.route — the
// call fails before the stub ever sees it. Replacing fetch for this one URL
// still exercises everything the app controls: the request it builds and how
// it handles the reply. And it keeps the test off the real network.
async function stubClaude(page, reply) {
  const calls = [];
  await page.exposeFunction('__claudeCall', body => { calls.push(JSON.parse(body)); });
  await page.evaluate(reply => {
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://api.anthropic.com/v1/messages')) return real(url, opts);
      await window.__claudeCall(opts.body);
      const json = typeof reply === 'number'
        ? { error: { message: 'Overloaded' } }
        : { content: [{ type: 'text', text: reply }] };
      return new Response(JSON.stringify(json),
        { status: typeof reply === 'number' ? reply : 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, reply);
  return calls;
}

const sentSize = (page, b64) => page.evaluate(async d => {
  const i = new Image(); i.src = 'data:image/jpeg;base64,' + d; await i.decode();
  return { w: i.naturalWidth, h: i.naturalHeight };
}, b64);

test('a highlight goes from a photo to a journal entry', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const calls = await stubClaude(page, 'It was the best of times, it was the worst of times.');

  await openCapture(page);
  await choosePhoto(page);
  await dragBox(page, .1, .1, .6, .3);
  assert.equal(await page.textContent('#hlRead'), 'Read passage →', 'a drawn box reads just that');

  await page.click('#hlRead');
  await page.waitForFunction(() => document.getElementById('hlText').value.length > 0);
  assert.equal(await page.isDisabled('#hlText'), false, 'editable once read, to fix misreads');
  await page.fill('#hlPage', '1');
  await page.fill('#hlNote', 'the opening');
  await page.click('#hlSave');

  const j = await page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_journal')).b1);
  assert.equal(j.length, 1);
  assert.deepEqual({ type: j[0].type, text: j[0].text, page: j[0].page, note: j[0].note },
    { type: 'highlight', text: 'It was the best of times, it was the worst of times.', page: '1', note: 'the opening' });
  assert.ok(j[0].at > 1, 'stamped as new, so it beats any older tombstone');

  const msg = calls[0];
  assert.equal(calls.length, 1);
  assert.equal(msg.model, await page.evaluate(() => CLAUDE_MODEL));
  assert.equal(msg.messages[0].content[0].type, 'image');
  assert.equal(msg.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.match(msg.messages[0].content[1].text, /Transcribe the text exactly/);

  assert.equal(await page.isVisible('#hlModal'), false, 'the capture screen closes');
  assert.match(await page.textContent('#journalEntries'), /best of times/, 'and the book shows it straight away');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('only the marked passage is sent, not the whole photo', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const calls = await stubClaude(page, 'x');
  await openCapture(page);
  await choosePhoto(page);
  const src = await page.evaluate(() => ({ w: _hl.bitmap.width, h: _hl.bitmap.height }));
  await dragBox(page, .1, .1, .6, .3);           // half the width, a fifth of the height
  await page.click('#hlRead');
  await page.waitForFunction(() => document.getElementById('hlText').value.length > 0);

  const sent = await sentSize(page, calls[0].messages[0].content[0].source.data);
  assert.ok(Math.abs(sent.w / src.w - 0.5) < 0.03, `width ~50% of the photo, got ${sent.w}/${src.w}`);
  assert.ok(Math.abs(sent.h / src.h - 0.2) < 0.03, `height ~20% of the photo, got ${sent.h}/${src.h}`);
  await ctx.close();
});

test('a tap instead of a drag reads the whole photo', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const calls = await stubClaude(page, 'x');
  await openCapture(page);
  await choosePhoto(page);
  const src = await page.evaluate(() => ({ w: _hl.bitmap.width, h: _hl.bitmap.height }));
  await dragBox(page, .5, .5, .505, .505);       // a sliver is not a selection
  assert.equal(await page.textContent('#hlRead'), 'Read whole photo →');
  await page.click('#hlRead');
  await page.waitForFunction(() => document.getElementById('hlText').value.length > 0);

  const sent = await sentSize(page, calls[0].messages[0].content[0].source.data);
  assert.deepEqual(sent, src, 'the full photo, under the 1600px cap here');
  await ctx.close();
});

test('without an API key it still works — type the passage beside the photo', async () => {
  const { ctx, page } = await openApp(browser, base);
  const calls = await stubClaude(page, 'should not be called');
  await openCapture(page);
  await choosePhoto(page);
  await page.click('#hlRead');

  assert.equal(calls.length, 0, 'no request without a key');
  assert.match(await page.textContent('#hlStatus'), /Type the passage.*Settings/);
  assert.equal(await page.isVisible('#hlCrop'), true, 'the marked photo stays up for reference');
  await page.fill('#hlText', 'Typed by hand.');
  await page.click('#hlSave');
  const j = await page.evaluate(() => journalDB.b1);
  assert.equal(j[0].text, 'Typed by hand.');
  assert.equal(j[0].type, 'highlight');
  await ctx.close();
});

test('a failed read explains itself and falls back to typing', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  await stubClaude(page, 529);
  await openCapture(page);
  await choosePhoto(page);
  await page.click('#hlRead');
  await page.waitForFunction(() => /Couldn't read it/.test(document.getElementById('hlStatus').textContent));
  assert.match(await page.textContent('#hlStatus'), /Overloaded/, 'names the actual cause');
  assert.equal(await page.isDisabled('#hlText'), false);
  await ctx.close();
});

test('an empty passage is not saved', async () => {
  const { ctx, page } = await openApp(browser, base);
  await openCapture(page);
  await choosePhoto(page);
  await page.click('#hlRead');
  await page.click('#hlSave');
  assert.equal(await page.isVisible('#hlModal'), true, 'stays open');
  assert.deepEqual(await page.evaluate(() => journalDB.b1 || []), []);
  await ctx.close();
});

test('a highlight shows in the book, the library panel, the Journal tab and Keepsake', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => {
    books = [{ id: 'b1', title: 'A Tale of Two Cities', author: 'Charles Dickens', status: 'reading', addedAt: 1, updatedAt: 1 }];
    journalDB = {}; save('trr_v1_books', books); save('trr_v1_journal', journalDB);
    renderLibrary();
  });
  // Save through the real capture flow (no key: typed by hand) so the library
  // cards have to pick it up from the redraw, not from a fresh render.
  await page.evaluate(() => { openEditModal('b1'); document.getElementById('hlOpenBtn').click(); });
  await choosePhoto(page);
  await page.click('#hlRead');
  await page.fill('#hlText', 'Recalled to life.');
  await page.fill('#hlPage', '14');
  await page.click('#hlSave');

  const where = await page.evaluate(() => {
    const has = sel => { const el = document.querySelector(sel); return !!el && /Recalled to life/.test(el.innerHTML) && /hl-quote/.test(el.innerHTML); };
    const modal = has('#journalEntries'); closeM('bookModal');
    showView('library'); const panel = has('#booksGrid');
    showView('journal'); renderJournalView(); const tab = has('#view-journal');
    renderKeepsake();
    const ks = document.getElementById('ksContent').innerHTML;
    return { modal, panel, tab, keepsake: /✦ Highlights/.test(ks) && /Recalled to life/.test(ks) && /p\. 14/.test(ks) };
  });
  assert.deepEqual(where, { modal: true, panel: true, tab: true, keepsake: true });
  await ctx.close();
});

test('a passage that looks like HTML is shown as text, not run', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  await stubClaude(page, '<img src=x onerror="window.__pwned=1">');
  await openCapture(page);
  await choosePhoto(page);
  await page.click('#hlRead');
  await page.waitForFunction(() => document.getElementById('hlText').value.length > 0);
  await page.click('#hlSave');
  await page.evaluate(() => renderKeepsake());

  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#journalEntries img, #ksContent .ks-q img').count(), 0);
  await ctx.close();
});

test('deleting a highlight sticks under sync', async () => {
  const { ctx, page } = await openApp(browser, base);
  const hl = { date: '2026-10-06', time: '9:00 PM', type: 'highlight', text: 'Recalled to life.', at: 1000 };
  await seed(page, { journal: [hl] });
  const pushed = await withGist(page, { v: 2, books: [{ id: 'b1', title: 'Dune', updatedAt: 1, addedAt: 1 }], journal: { b1: [hl] } });
  await page.evaluate(async () => { openEditModal('b1'); deleteJournalEntry('b1', 0); await gistPush(); });
  assert.deepEqual(pushed[0].journal.b1, []);
  await ctx.close();
});

test('Escape closes the capture screen without saving', async () => {
  const { ctx, page } = await openApp(browser, base);
  await openCapture(page);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#hlModal'), false);
  assert.equal(await page.isVisible('#bookModal'), true, 'the book stays open underneath');
  await ctx.close();
});

// ── The floating + ───────────────────────────────────────────────────────

const seedShelf = (page, list) => page.evaluate(l => {
  books = l.map((b, i) => ({ author: 'A', addedAt: i + 1, updatedAt: 1, ...b }));
  save('trr_v1_books', books); renderLibrary();
}, list);

// ── The camera (the floating ＋) ─────────────────────────────────────────
// Headless Chromium has no camera and no BarcodeDetector, so stand both in:
// a canvas stream as the camera, and a detector that reports whatever the
// test puts in window.__detected.
async function fakeCamera(page, { deny = false } = {}) {
  await page.evaluate(deny => {
    window.__detected = null;
    navigator.mediaDevices.getUserMedia = async () => {
      if (deny) throw new DOMException('denied', 'NotAllowedError');
      const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480;
      const g = cv.getContext('2d');
      const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#000'; g.font = '36px serif'; g.fillText('A page of text ' + Date.now() % 10, 40, 200); };
      draw(); setInterval(draw, 100);
      const stream = cv.captureStream(10);
      window.__camStream = stream;
      return stream;
    };
    window.BarcodeDetector = class { constructor(o) { window.__formats = o.formats; }
      async detect() { return window.__detected ? [{ rawValue: window.__detected }] : []; } };
  }, deny);
}
const cameraLive = page => page.waitForFunction(() => !document.getElementById('lensShutter').disabled);

test('＋ opens the camera straight away, with the manual options underneath', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await fakeCamera(page);
  await page.click('#fab');
  assert.equal(await page.isVisible('#lens'), true);
  await cameraLive(page);
  assert.match(await page.textContent('#lensStatus'), /barcode.*page/i);
  assert.deepEqual(await page.$$eval('.lens-manual button span', els => els.map(e => e.textContent)),
                   ['Type a passage', 'Add a word', 'From gallery', 'Find a book']);
  assert.deepEqual(await page.evaluate(() => window.__formats), ['ean_13', 'ean_8', 'upc_a', 'upc_e']);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#lens'), false);
  assert.deepEqual(await page.evaluate(() => window.__camStream.getTracks().map(t => t.readyState)), ['ended'],
                   'the camera is released');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a book barcode in view starts adding that book', async () => {
  const { ctx, page } = await openApp(browser, base);
  await stubCatalogues(page);
  await fakeCamera(page);
  await page.click('#fab');
  await cameraLive(page);
  await page.evaluate(() => { window.__detected = '9780593328354'; });
  await page.waitForFunction(() => document.getElementById('bookModal').style.display === 'flex');
  assert.equal(await page.isVisible('#lens'), false);
  assert.equal(await page.inputValue('#isbnInput'), '9780593328354');
  assert.deepEqual(await page.evaluate(() => window.__camStream.getTracks().map(t => t.readyState)), ['ended']);
  await ctx.close();
});

test('a barcode that is not a book’s is ignored', async () => {
  const { ctx, page } = await openApp(browser, base);
  await fakeCamera(page);
  await page.click('#fab');
  await cameraLive(page);
  await page.evaluate(() => { window.__detected = '012345678905'; }); // a grocery UPC
  await page.waitForFunction(() => /isn’t a book’s/.test(document.getElementById('lensStatus').textContent));
  assert.equal(await page.isVisible('#lens'), true, 'still the camera');
  assert.equal(await page.isVisible('#bookModal'), false);
  await ctx.close();
});

test('Capture page goes to marking the passage, for the one book being read', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedShelf(page, [{ id: 'r1', title: 'Piranesi', author: 'Susanna Clarke', status: 'reading' },
                         { id: 'd1', title: 'Middlemarch', status: 'read' }]);
  await fakeCamera(page);
  await page.click('#fab');
  await cameraLive(page);
  await page.click('#lensShutter');
  await page.waitForFunction(() => document.getElementById('hlMark').style.display === 'block');
  assert.equal(await page.isVisible('#lens'), false);
  assert.match(await page.textContent('#hlBook'), /Piranesi · Susanna Clarke/, 'the book being read is chosen for you');
  await page.click('#hlRead');
  assert.equal(await page.isVisible('#hlBooks'), true, 'and can be changed');
  assert.equal(await page.textContent('#hlBooks .hl-bookchip.on'), 'Piranesi');
  await page.fill('#hlText', 'There is no knowledge that is not valuable.');
  await page.click('#hlSave');
  assert.equal((await page.evaluate(() => journalDB.r1))[0].type, 'highlight');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('reading two books: choose which before the highlight saves', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelf(page, [{ id: 'r1', title: 'Piranesi', status: 'reading' }, { id: 'r2', title: 'Dune', status: 'reading' },
                         { id: 'd1', title: 'Middlemarch', status: 'read' }, { id: 'w1', title: 'Wanted', status: 'wishlist' }]);
  await fakeCamera(page);
  await page.click('#fab');
  await cameraLive(page);
  await page.click('#lensShutter');
  await page.waitForFunction(() => document.getElementById('hlMark').style.display === 'block');
  await page.click('#hlRead');
  assert.deepEqual(await page.$$eval('#hlBooks .hl-bookchip', els => els.map(e => e.textContent)), ['Piranesi', 'Dune']);
  assert.deepEqual(await page.$$eval('#hlBooks select option', els => els.map(e => e.textContent)),
                   ['Another book…', 'Middlemarch'], 'the rest in a menu — never the wishlist');
  await page.fill('#hlText', 'Fear is the mind-killer.');
  await page.click('#hlSave');
  assert.equal(await page.isVisible('#hlModal'), true, 'not saved without a book');
  assert.deepEqual(await page.evaluate(() => Object.keys(journalDB)), []);
  await page.click('#hlBooks .hl-bookchip:text-is("Dune")');
  await page.click('#hlSave');
  assert.equal((await page.evaluate(() => journalDB.r2))[0].text, 'Fear is the mind-killer.');
  await ctx.close();
});

test('without camera access the manual options still work', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelf(page, [{ id: 'r1', title: 'Piranesi', status: 'reading' }]);
  await fakeCamera(page, { deny: true });
  await page.click('#fab');
  await page.waitForFunction(() => /Camera access is off/.test(document.getElementById('lensStatus').textContent));
  assert.equal(await page.isDisabled('#lensShutter'), true);

  await page.click('#lensWord');
  assert.equal(await page.isVisible('#lens'), false);
  assert.equal(await page.isVisible('#vocabModal'), true);
  assert.equal(await page.inputValue('#vocabBook'), 'r1');
  await page.click('#vocabCancelBtn');

  await page.click('#fab');
  await page.click('#lensType');
  assert.equal(await page.isVisible('#hlConfirm'), true, 'straight to typing the passage');
  assert.equal(await page.textContent('#hlBooks .hl-bookchip.on'), 'Piranesi');
  await page.click('#hlClose');

  await page.click('#fab');
  await page.click('#lensFind');
  assert.equal(await page.isVisible('#bookModal'), true, 'add a book by title or by hand');
  await ctx.close();
});

test('book titles in the chooser are shown as text', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedShelf(page, [{ id: 'x', title: '<img src=x onerror="window.__pwned=1">', status: 'reading' },
                         { id: 'y', title: 'Dune', status: 'reading' }]);
  await fakeCamera(page, { deny: true });
  await page.click('#fab');
  await page.click('#lensType');
  assert.equal(await page.locator('#hlBooks img').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ── Export to the share sheet (→ Drive) ──────────────────────────────────
// Headless Chromium has no share sheet, so stand one in. `accept` is the MIME
// types canShare() allows; `fail` makes share() throw that DOMException.

async function fakeShareSheet(page, { accept = ['application/json', 'text/plain'], fail = null } = {}) {
  await page.evaluate(({ accept, fail }) => {
    window.__shared = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true,
      value: ({ files }) => accept.includes(files[0].type) });
    Object.defineProperty(navigator, 'share', { configurable: true,
      value: async ({ files }) => {
        window.__shared.push({ count: files.length, name: files[0].name, type: files[0].type, text: await files[0].text() });
        if (fail) throw new DOMException('fake', fail);
      } });
  }, { accept, fail });
}
function watchDownloads(page) { const d = []; page.on('download', x => d.push(x)); return d; }
const backupName = (page, ext) => page.evaluate(e => `reading-room-backup-${localDateStr()}${e}`, ext);

test('Export JSON hands a dated backup file to the share sheet', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await addBook(page, 'Piranesi', 'Susanna Clarke');
  await fakeShareSheet(page);
  const downloads = watchDownloads(page);

  await page.evaluate(() => exportJSON());
  const [s] = await page.evaluate(() => window.__shared);

  assert.equal(s.count, 1);
  assert.equal(s.name, await backupName(page, '.json'));
  assert.equal(s.type, 'application/json');
  const data = JSON.parse(s.text);
  assert.equal(data.books[0].title, 'Piranesi', 'it is the real, complete backup');
  assert.equal(downloads.length, 0, 'no download as well');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('if Chrome refuses .json it shares the same backup as .txt', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Dune', 'Frank Herbert');
  await fakeShareSheet(page, { accept: ['text/plain'] });
  await page.evaluate(() => exportJSON());
  const [s] = await page.evaluate(() => window.__shared);
  assert.equal(s.name, await backupName(page, '.txt'));
  assert.equal(s.type, 'text/plain');
  assert.equal(JSON.parse(s.text).books[0].title, 'Dune');
  await ctx.close();
});

test('without a share sheet it downloads, as before', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Dune', 'Frank Herbert');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => exportJSON())]);
  assert.equal(dl.suggestedFilename(), await backupName(page, '.json'));
  await ctx.close();
});

test('closing the share sheet does not download anything behind your back', async () => {
  const { ctx, page } = await openApp(browser, base);
  await fakeShareSheet(page, { fail: 'AbortError' });
  const downloads = watchDownloads(page);
  await page.evaluate(() => exportJSON());
  await page.waitForTimeout(300);
  assert.equal(downloads.length, 0);
  assert.equal(await page.locator('.toast.err').count(), 0, 'and it is not reported as an error');
  await ctx.close();
});

test('if sharing fails it falls back to a download', async () => {
  const { ctx, page } = await openApp(browser, base);
  await fakeShareSheet(page, { fail: 'NotAllowedError' });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => exportJSON())]);
  assert.equal(dl.suggestedFilename(), await backupName(page, '.json'));
  await ctx.close();
});

test('a .txt backup from the fallback can be imported again', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Piranesi', 'Susanna Clarke');
  await fakeShareSheet(page, { accept: ['text/plain'] });
  await page.evaluate(() => exportJSON());
  const [s] = await page.evaluate(() => window.__shared);

  // A fresh device: empty library, then import the shared .txt.
  const fresh = await openApp(browser, base);
  assert.match(await fresh.page.getAttribute('#importFile', 'accept'), /\.txt/, 'the picker offers .txt files');
  await fresh.page.setInputFiles('#importFile', { name: s.name, mimeType: 'text/plain', buffer: Buffer.from(s.text) });
  await fresh.page.waitForFunction(() => books.length === 1);
  assert.equal(await fresh.page.evaluate(() => books[0].title), 'Piranesi');
  await fresh.ctx.close();
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

// ── Vocabulary ───────────────────────────────────────────────────────────

const storedVocab = page => page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_vocab') || '[]'));

// Words straight into storage, as if added earlier. Due today unless told otherwise.
async function seedVocab(page, words) {
  await page.evaluate(ws => {
    const today = localDateStr();
    vocabDB = ws.map((w, i) => ({ id: 'w_seed' + i, box: 0, reviews: 0, lapses: 0, due: today, addedAt: 1000 + i,
                                  updatedAt: 1000 + i, bookId: '', sentence: '', ...w }));
    save(SK.vocab, vocabDB);
  }, words);
}

// The free dictionary, stubbed at the network layer (a plain GET, no preflight).
async function stubDictionary(page, entries = {}) {
  const hits = [];
  await page.route('https://api.dictionaryapi.dev/**', route => {
    const w = decodeURIComponent(route.request().url().split('/').pop());
    hits.push(w);
    if (!entries[w]) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"title":"No Definitions Found"}' });
    const e = entries[w];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ word: w,
      phonetic: e.phonetic, phonetics: e.audio ? [{ text: e.phonetic, audio: e.audio }] : [],
      meanings: e.pos ? [{ partOfSpeech: e.pos, definitions: [{ definition: e.definition }] }] : [] }]) });
  });
  return hits;
}

test('a word is defined by Claude in the sense the book uses it, and saved', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  await addBook(page, 'The Algorithm', 'Jon McNeill');
  await page.evaluate(() => { books[0].status = 'reading'; saveBooks(books[0]); });
  const calls = await stubClaude(page, '{"pos":"adjective","definition":"Gloomy and mournful.","note":"From Latin lugere, to mourn."}');

  await page.evaluate(() => showView('vocab'));
  await page.click('#vocabAddBtn');
  assert.equal(await page.inputValue('#vocabBook'), await page.evaluate(() => books[0].id),
               'the one book being read is picked for you');
  await page.fill('#vocabWord', 'lugubrious');
  await page.fill('#vocabSentence', 'The meeting had a lugubrious air.');
  await page.fill('#vocabPage', '42');
  await page.click('#vocabDefineBtn');
  await page.waitForFunction(() => document.getElementById('vocabDef').value !== '');

  const prompt = calls[0].messages[0].content;
  assert.match(prompt, /"lugubrious"/);
  assert.match(prompt, /The Algorithm/, 'the book is in the prompt');
  assert.match(prompt, /Jon McNeill/);
  assert.match(prompt, /The meeting had a lugubrious air\./, 'so is the sentence');
  assert.equal(await page.inputValue('#vocabPos'), 'adjective');
  assert.equal(await page.inputValue('#vocabNote'), 'From Latin lugere, to mourn.');

  await page.click('#vocabSaveBtn');
  assert.equal(await page.isVisible('#vocabModal'), false);
  const [w] = await storedVocab(page);
  assert.equal(w.word, 'lugubrious');
  assert.equal(w.definition, 'Gloomy and mournful.');
  assert.equal(w.page, '42');
  assert.equal(w.box, 0);
  assert.equal(w.due, await page.evaluate(() => localDateStr()), 'a new word is ready to review straight away');
  assert.match(await page.textContent('#vocabList'), /The Algorithm[\s\S]*lugubrious/, 'listed under its book');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('without a key, Save looks the word up in the dictionary first', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const hits = await stubDictionary(page, { ephemeral: { pos: 'adjective', definition: 'Lasting a very short time.' } });
  await page.evaluate(() => { showView('vocab'); openVocabWord(null, null); });
  await page.fill('#vocabWord', 'Ephemeral');
  await page.click('#vocabSaveBtn');
  await page.waitForFunction(() => vocabDB.length === 1);
  assert.deepEqual(hits, ['ephemeral']);
  const [w] = await storedVocab(page);
  assert.equal(w.definition, 'Lasting a very short time.');
  assert.equal(w.pos, 'adjective');
  assert.equal(w.bookId, '', 'a word does not need a book');
  assert.match(await page.textContent('#vocabList'), /Other words/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a word no one can define stays open to type a definition', async () => {
  const { ctx, page } = await openApp(browser, base);
  await stubDictionary(page, {});
  await page.evaluate(() => { showView('vocab'); openVocabWord(null, null); });
  await page.fill('#vocabWord', 'flibbertigibbetish');
  await page.click('#vocabSaveBtn');
  await page.waitForFunction(() => /Couldn't find/.test(document.getElementById('vocabStatus').textContent));
  assert.equal(await page.isVisible('#vocabModal'), true);
  assert.equal((await storedVocab(page)).length, 0, 'nothing saved without a definition');
  await page.fill('#vocabDef', 'Flighty, in a showy way.');
  await page.click('#vocabSaveBtn');
  assert.equal((await storedVocab(page))[0].definition, 'Flighty, in a showy way.');
  await ctx.close();
});

test('a Claude failure falls back to the dictionary and says why', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  await stubClaude(page, 529);
  await stubDictionary(page, { terse: { pos: 'adjective', definition: 'Brief and abrupt.' } });
  await page.evaluate(() => { showView('vocab'); openVocabWord(null, null); });
  await page.fill('#vocabWord', 'terse');
  await page.click('#vocabDefineBtn');
  await page.waitForFunction(() => document.getElementById('vocabDef').value !== '');
  assert.equal(await page.inputValue('#vocabDef'), 'Brief and abrupt.');
  assert.match(await page.textContent('#vocabStatus'), /dictionary.*Overloaded/);
  await ctx.close();
});

test('the same word twice is caught, with a way to the first one', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedVocab(page, [{ word: 'Lugubrious', definition: 'Mournful.' }]);
  await page.evaluate(() => { showView('vocab'); openVocabWord(null, null); });
  await page.fill('#vocabWord', 'lugubrious ');
  assert.equal(await page.isVisible('#vocabDup'), true);
  await page.fill('#vocabDef', 'Something else.');
  await page.click('#vocabSaveBtn');
  assert.equal((await storedVocab(page)).length, 1, 'not saved twice');
  await page.click('#vocabDup button');
  assert.equal(await page.inputValue('#vocabDef'), 'Mournful.', 'Open it shows the saved word');
  await ctx.close();
});

test('deleting a word takes two taps and survives a sync', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedVocab(page, [{ word: 'alpha', definition: 'First.' }, { word: 'beta', definition: 'Second.' }]);
  await page.evaluate(() => { showView('vocab'); openVocabWord('w_seed0'); });
  await page.click('#vocabDeleteBtn');
  assert.equal((await storedVocab(page)).length, 2, 'the first tap only asks');
  assert.match(await page.textContent('#vocabDeleteBtn'), /again/);
  await page.click('#vocabDeleteBtn');
  assert.deepEqual((await storedVocab(page)).map(w => w.word), ['beta']);
  // The other device still has it; the merge must not bring it back.
  const kept = await page.evaluate(() => {
    const remote = remoteState({ vocab: [{ id: 'w_seed0', word: 'alpha', definition: 'First.', updatedAt: 1000 }] });
    return mergeState(currentState(), remote).vocab.map(w => w.word);
  });
  assert.deepEqual(kept, ['beta']);
  await ctx.close();
});

test('a review session: flashcard, multiple choice and the sentence test', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const today = await page.evaluate(() => localDateStr());
  await seedVocab(page, [
    { word: 'lugubrious', definition: 'Gloomy and mournful.', box: 0 },
    { word: 'terse', definition: 'Brief and abrupt.', box: 1, reviews: 1 },
    { word: 'obfuscate', definition: 'Make unclear.', box: 3, reviews: 3, sentence: 'He kept obfuscating the issue.' },
    { word: 'later', definition: 'Not due yet.', due: '2999-01-01' },
    { word: 'ephemeral', definition: 'Short-lived.', due: '2999-01-01' },
  ]);
  await page.evaluate(() => startVocabQuiz());
  assert.equal(await page.isVisible('#vocabQuiz'), true);
  assert.match(await page.textContent('#vqCount'), /1 of 3/, 'only the three due words');

  // Oldest-added first among equally due words: the flashcard.
  assert.equal(await page.getAttribute('.vq-card', 'data-format'), 'flash');
  await page.click('#vqReveal');
  assert.match(await page.textContent('.vq-card'), /Gloomy and mournful/);
  await page.click('.vq-btn.good');

  assert.equal(await page.getAttribute('.vq-card', 'data-format'), 'choice');
  assert.equal(await page.locator('.vq-opt').count(), 4);
  await page.click('.vq-opt:not(:has-text("Brief and abrupt."))');
  assert.equal(await page.locator('.vq-opt.right').textContent(), 'Brief and abrupt.', 'the right answer is shown');
  await page.click('#vqNext');

  assert.equal(await page.getAttribute('.vq-card', 'data-format'), 'blank');
  assert.doesNotMatch(await page.textContent('.vq-sentence'), /obfuscating/, 'the word is blanked out');
  await page.fill('#vqAnswer', 'Obfuscate');
  await page.press('#vqAnswer', 'Enter');
  assert.match(await page.textContent('.vq-feedback'), /Right/);
  await page.click('#vqNext');

  assert.match(await page.textContent('.vq-score'), /2 \/ 3/);
  const words = Object.fromEntries((await storedVocab(page)).map(w => [w.word, w]));
  assert.equal(words.lugubrious.box, 1);
  assert.equal(words.terse.box, 0, 'missed: back to the start');
  assert.equal(words.terse.due > today, true, 'and due tomorrow, not again today');
  assert.equal(words.obfuscate.box, 4);
  assert.equal(await page.evaluate(() => Object.keys(streakDB).length), 0, 'reviews do not count toward the streak');
  await page.click('.vq-done .vq-btn');
  assert.equal(await page.isVisible('#vocabQuiz'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Today’s Reading links to a review when words are due, and stays quiet otherwise', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => showView('log'));
  assert.equal(await page.locator('#vocabNudge').count(), 0, 'nothing until there are words');

  await seedVocab(page, [{ word: 'terse', definition: 'Brief.' }, { word: 'later', definition: 'Later.', due: '2999-01-01' }]);
  await page.evaluate(() => renderLogSession());
  assert.match(await page.textContent('#vocabNudge'), /1 word to review/);
  await page.click('#vocabNudge');
  assert.equal(await page.isVisible('#vocabQuiz'), true, 'one tap into the review');
  await page.click('#vqReveal');
  await page.click('.vq-btn.good');
  await page.click('.vq-done .vq-btn');

  assert.match(await page.textContent('#vocabNudge'), /All caught up/, 'refreshed after the review');
  assert.match(await page.textContent('#vocabNudge'), /WORD OF THE DAY/);
  await page.click('#vocabNudge');
  assert.equal(await page.isVisible('#vocabView'), true, 'the word of the day opens its page');
  await ctx.close();
});

test('the Lists card opens the page and starts a review', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => showView('lists'));
  assert.match(await page.textContent('#vocabCard'), /Add your first word/);
  await seedVocab(page, [{ word: 'terse', definition: 'Brief.' }]);
  await page.evaluate(() => renderLists());
  assert.match(await page.textContent('#vocabCardReview'), /Review 1 word/);
  await page.click('#vocabCard .list-card-head');
  assert.equal(await page.evaluate(() => location.hash), '#vocab');
  assert.equal(await page.getAttribute('.nav-tab[data-view="lists"]', 'aria-current'), 'page', 'Lists stays lit');
  await ctx.close();
});

test('a passage can be typed instead of photographed, and saved as a highlight', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await openCapture(page);
  await page.click('#hlTypeBtn');
  assert.equal(await page.isVisible('#hlConfirm'), true);
  assert.equal(await page.isVisible('#hlCrop'), false, 'no photo to show');
  assert.equal(await page.textContent('#hlSave'), 'Save highlight', 'highlight is the default');
  await page.fill('#hlText', 'It was the best of times.');
  await page.fill('#hlPage', '3');
  await page.click('#hlSave');
  const j = await page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_journal')).b1);
  assert.deepEqual([j[0].type, j[0].text, j[0].page], ['highlight', 'It was the best of times.', '3']);
  assert.equal(await page.isVisible('#hlModal'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the choice decides: words only saves no highlight; neither is not allowed', async () => {
  const { ctx, page } = await openApp(browser, base);
  await openCapture(page);
  await page.click('#hlTypeBtn');
  await page.fill('#hlText', 'A terse reply.');
  await page.click('#hlChoiceWords');
  assert.equal(await page.textContent('#hlSave'), 'Save & pick words →');
  await page.click('#hlChoiceHl');
  assert.equal(await page.textContent('#hlSave'), 'Pick words →');
  assert.equal(await page.isVisible('#hlNoteWrap'), false, 'no note without a highlight');
  await page.click('#hlChoiceWords');
  assert.equal(await page.isDisabled('#hlSave'), true, 'one of the two must be chosen');
  await page.click('#hlChoiceWords');

  await page.click('#hlSave');
  assert.equal(await page.isVisible('#wordPick'), true);
  await page.click('#wordPickText .wp-word:text-is("terse")');
  assert.equal(await page.inputValue('#vocabWord'), 'terse');
  assert.equal(await page.inputValue('#vocabSentence'), 'A terse reply.');
  await page.fill('#vocabDef', 'Brief.');
  await page.click('#vocabSaveBtn');
  await page.click('#wordPickCancel'); // Done
  assert.equal(await page.isVisible('#hlModal'), false, 'Done finishes the page');
  assert.equal((await storedVocab(page)).length, 1);
  assert.deepEqual(await page.evaluate(() => journalDB.b1 || []), [], 'no highlight saved');
  await ctx.close();
});

test('a book’s editor lists its words and can add one', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Piranesi', 'Susanna Clarke');
  const id = await page.evaluate(() => books[0].id);
  await seedVocab(page, [{ word: 'vestibule', definition: 'An entrance hall.', bookId: id }, { word: 'elsewhere', definition: 'x' }]);
  await page.evaluate(i => { openEditModal(i); switchModalTab('reading'); }, id);
  const listed = await page.$$eval('#vocabBookList .voc-word', els => els.map(e => e.textContent));
  assert.deepEqual(listed, ['vestibule']);
  await page.click('#vocabBookAdd');
  assert.equal(await page.isVisible('#vocabModal'), true);
  assert.equal(await page.inputValue('#vocabBook'), id);
  await page.fill('#vocabWord', 'tide');
  await page.fill('#vocabDef', 'The rise and fall of the sea.');
  await page.click('#vocabSaveBtn');
  assert.deepEqual(await page.$$eval('#vocabBookList .voc-word', els => els.map(e => e.textContent)), ['tide', 'vestibule']);
  assert.equal(await page.isVisible('#bookModal'), true, 'back in the book');
  await ctx.close();
});

test('words with markup in them are shown as text', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const evil = '<img src=x onerror="window.__pwned=1">';
  await seedVocab(page, [{ word: evil, definition: evil, sentence: `a ${evil} b`, note: evil },
                         { word: 'b', definition: 'b' }, { word: 'c', definition: 'c' }, { word: 'd', definition: 'd' }]);
  await page.evaluate(() => { showView('vocab'); renderLists(); renderLogSession(); startVocabQuiz(); });
  await page.click('#vqReveal');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#view-vocab img, #vocabQuiz img, #vocabCard img').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('words are in the export and come back through import', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedVocab(page, [{ word: 'terse', definition: 'Brief.' }]);
  await fakeShareSheet(page);
  await page.evaluate(() => exportJSON());
  const [s] = await page.evaluate(() => window.__shared);
  assert.equal(JSON.parse(s.text).vocab[0].word, 'terse');

  const fresh = await openApp(browser, base);
  await fresh.page.setInputFiles('#importFile', { name: s.name, mimeType: 'application/json', buffer: Buffer.from(s.text) });
  await fresh.page.waitForFunction(() => vocabDB.length === 1);
  assert.equal((await storedVocab(fresh.page))[0].word, 'terse');
  await fresh.ctx.close();
  await ctx.close();
});

// ── Words from highlights and photos ─────────────────────────────────────

// Claude for both jobs at once: reading a photo (an image message) and
// defining a word (a text message). Calls are recorded by kind.
async function stubClaudeBoth(page, { read, define }) {
  await page.evaluate(({ read, define }) => {
    window.__claude = { read: [], define: [] };
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://api.anthropic.com/v1/messages')) return real(url, opts);
      const body = JSON.parse(opts.body);
      const isImage = Array.isArray(body.messages[0].content);
      window.__claude[isImage ? 'read' : 'define'].push(body);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: isImage ? read : define }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, { read, define });
}

const PASSAGE = 'The meeting dragged on. Every layer of approval seemed designed to\nobfuscate who had decided. Nobody spoke.';

async function seedHighlight(page, extra = {}) {
  await page.evaluate(([text, extra]) => {
    books = [{ id: 'b1', title: 'The Algorithm', author: 'Jon McNeill', status: 'reading', addedAt: 1, updatedAt: 1 }];
    journalDB = { b1: [{ date: '2026-10-01', time: '9:00 AM', type: 'highlight', text, page: '88', at: 5 },
                       { date: '2026-10-02', time: '9:00 AM', text: 'a plain note', at: 6 }] };
    save('trr_v1_books', books); save('trr_v1_journal', journalDB);
    Object.assign(window, extra);
  }, [PASSAGE, extra]);
}

test('a word picked from a saved highlight arrives with its sentence, page and book', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedHighlight(page);
  await page.evaluate(() => { openEditModal('b1'); switchModalTab('reading'); });
  assert.equal(await page.locator('#journalEntries .hl-words').count(), 1, 'on highlights only, not notes');
  await page.click('#journalEntries .hl-words');
  assert.equal(await page.isVisible('#wordPick'), true);
  await page.click('#wordPickText .wp-word:text-is("Every")');

  assert.equal(await page.isVisible('#vocabModal'), true);
  assert.equal(await page.inputValue('#vocabWord'), 'every', 'lower case at the start of a sentence');
  assert.equal(await page.inputValue('#vocabSentence'),
               'Every layer of approval seemed designed to obfuscate who had decided.', 'the whole sentence, wrap joined');
  assert.equal(await page.inputValue('#vocabPage'), '88');
  assert.equal(await page.inputValue('#vocabBook'), 'b1');

  await page.fill('#vocabDef', 'Each one.');
  await page.click('#vocabSaveBtn');
  assert.equal(await page.isVisible('#wordPick'), true, 'the picker stays for more words');
  assert.equal(await page.locator('#wordPickText .wp-word.known').count(), 1, 'the saved word is marked');
  await page.click('#wordPickText .wp-word.known');
  assert.equal(await page.isVisible('#vocabView'), true, 'a known word opens its page');
  assert.match(await page.textContent('#vocabViewBody'), /every/);
  await page.click('#vocabViewBody .vv-foot .btn-primary');
  await page.click('#wordPickCancel');
  assert.equal(await page.isVisible('#wordPick'), false);
  assert.equal(await page.isVisible('#bookModal'), true, 'back in the book');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the Journal tab offers words from highlights too', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedHighlight(page);
  await page.evaluate(() => showView('journal'));
  await page.waitForFunction(() => location.hash === '#journal' && document.getElementById('jsection-b1'));
  await page.evaluate(() => toggleJournalSection('b1'));
  assert.equal(await page.locator('#journalViewContent .hl-words').count(), 1);
  await page.click('#journalViewContent .hl-words');
  await page.click('#wordPickText .wp-word:text-is("obfuscate")');
  assert.equal(await page.inputValue('#vocabWord'), 'obfuscate');
  assert.equal(await page.inputValue('#vocabBook'), 'b1');
  await ctx.close();
});

test('both: the highlight is saved and words are picked from the same photo', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  await stubClaudeBoth(page, { read: PASSAGE, define: '{"headword":"obfuscate","pos":"verb","definition":"Make unclear."}' });
  await openCapture(page);
  await choosePhoto(page);
  await page.click('#hlRead');
  await page.waitForFunction(() => document.getElementById('hlText').value.length > 0);
  await page.fill('#hlPage', '88');

  await page.click('#hlChoiceWords'); // both: highlight and words
  await page.click('#hlSave');
  await page.click('#wordPickText .wp-word:text-is("obfuscate")');
  assert.equal(await page.isVisible('#vocabModal'), true, 'the editor opens above the capture screen');
  assert.equal(await page.inputValue('#vocabPage'), '88');
  await page.click('#vocabSaveBtn'); // defines, then saves
  await page.waitForFunction(() => vocabDB.length === 1);
  await page.click('#wordPickCancel');
  assert.equal(await page.isVisible('#hlModal'), false, 'the page is done');
  const j = await page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_journal')).b1);
  assert.equal(j[0].text, PASSAGE);
  assert.equal((await storedVocab(page))[0].sentence, 'Every layer of approval seemed designed to obfuscate who had decided.');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a word from a photo: read the page, tap the word, keep the dictionary form', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const passage = 'He kept obfuscating the issue until we gave up.';
  await stubClaudeBoth(page, { read: passage, define: '{"headword":"obfuscate","pos":"verb","definition":"Make unclear.","note":""}' });
  await seedHighlight(page);

  await page.evaluate(() => openVocabWord(null, 'b1'));
  await page.click('#vocabPhotoBtn');
  assert.equal(await page.isVisible('#vocabModal'), false);
  assert.equal(await page.isVisible('#hlModal'), true);
  assert.match(await page.textContent('#hlTitle'), /word/);
  await choosePhoto(page);
  await page.click('#hlRead');
  await page.waitForFunction(() => document.getElementById('hlText').value.length > 0);
  assert.equal(await page.isVisible('#hlSave'), false, 'no Save highlight here');
  await page.check('#hlAlso');

  await page.click('#hlWordsBtn');
  assert.match(await page.textContent('#wordPickTitle'), /Tap the word/);
  await page.click('#wordPickText .wp-word:text-is("obfuscating")');
  assert.equal(await page.isVisible('#hlModal'), false, 'the photo is done');
  assert.equal(await page.isVisible('#wordPick'), false);
  assert.equal(await page.inputValue('#vocabWord'), 'obfuscating');
  assert.equal(await page.inputValue('#vocabSentence'), passage);

  await page.click('#vocabDefineBtn');
  await page.waitForFunction(() => document.getElementById('vocabDef').value !== '');
  assert.equal(await page.inputValue('#vocabWord'), 'obfuscate', 'saved under its dictionary form');
  assert.match(await page.textContent('#vocabStatus'), /dictionary form of “obfuscating”/);
  const prompt = await page.evaluate(() => window.__claude.define[0].messages[0].content);
  assert.match(prompt, /"obfuscating"/);
  assert.match(prompt, /headword/);
  await page.click('#vocabSaveBtn');

  const [w] = await storedVocab(page);
  assert.equal(w.word, 'obfuscate');
  assert.equal(w.bookId, 'b1');
  const j = await page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_journal')).b1);
  assert.equal(j.filter(e => e.type === 'highlight' && e.text === passage).length, 1, 'also kept as a highlight');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('backing out of the photo returns to the word as you left it', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedHighlight(page);
  await page.evaluate(() => openVocabWord(null, 'b1'));
  await page.fill('#vocabWord', 'half-typed');
  await page.click('#vocabPhotoBtn');
  await page.click('#hlClose');
  assert.equal(await page.isVisible('#vocabModal'), true);
  assert.equal(await page.inputValue('#vocabWord'), 'half-typed');
  assert.equal(await page.inputValue('#vocabBook'), 'b1');
  await ctx.close();
});

test('without a key, a word can still come from a photo: type the sentence, then tap', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedHighlight(page);
  await page.evaluate(() => openVocabWord(null, 'b1'));
  await page.click('#vocabPhotoBtn');
  await choosePhoto(page);
  await page.click('#hlRead');
  assert.match(await page.textContent('#hlStatus'), /Type the passage/);
  await page.fill('#hlText', 'A terse reply.');
  await page.click('#hlWordsBtn');
  await page.click('#wordPickText .wp-word:text-is("terse")');
  assert.equal(await page.inputValue('#vocabWord'), 'terse');
  assert.equal(await page.inputValue('#vocabSentence'), 'A terse reply.');
  await ctx.close();
});

test('passages with markup are picked from as text', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedHighlight(page);
  await page.evaluate(() => {
    journalDB.b1[0].text = 'A <img src=x onerror="window.__pwned=1"> tag.';
    save('trr_v1_journal', journalDB);
    openEditModal('b1'); switchModalTab('reading');
  });
  await page.click('#journalEntries .hl-words');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#wordPickText img').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ── Pronunciation ────────────────────────────────────────────────────────

// Record what would be said or played, instead of making a sound.
async function captureSpeech(page, { audioFails = false } = {}) {
  await page.evaluate(audioFails => {
    window.__said = []; window.__played = [];
    speechSynthesis.speak = u => window.__said.push({ text: u.text, lang: u.lang });
    speechSynthesis.cancel = () => {};
    window.Audio = class { constructor(src) { this.src = src; }
      play() { window.__played.push(this.src); return audioFails ? Promise.reject(new Error('offline')) : Promise.resolve(); } };
  }, audioFails);
}

test('Define fills in the pronunciation, and the recording is kept with the word', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const calls = await stubClaude(page, '{"headword":"lugubrious","syll":"lu·gu·bri·ous","pron":"lu̇-ˈgü-brē-əs","pos":"adjective","definition":"Gloomy."}');
  await stubDictionary(page, { lugubrious: { phonetic: '/ləˈɡuːbriəs/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/lugubrious-us.mp3' } });
  await captureSpeech(page);
  await page.evaluate(() => { showView('vocab'); openVocabWord(null, null); });
  await page.fill('#vocabWord', 'lugubrious');
  await page.click('#vocabDefineBtn');
  await page.waitForFunction(() => document.getElementById('vocabDef').value !== '');
  assert.match(calls[0].messages[0].content, /Merriam-Webster/, 'Claude is asked for the dictionary style');
  assert.match(calls[0].messages[0].content, /"syll"/);
  assert.equal(await page.inputValue('#vocabPron'), 'lu̇-ˈgü-brē-əs', 'Claude’s wins over the dictionary’s IPA');
  assert.equal(await page.inputValue('#vocabSyll'), 'lu·gu·bri·ous');

  await page.click('#vocabSpeak');
  assert.deepEqual(await page.evaluate(() => window.__played), ['https://api.dictionaryapi.dev/media/pronunciations/en/lugubrious-us.mp3']);
  await page.click('#vocabSaveBtn');
  const [w] = await storedVocab(page);
  assert.equal(w.pron, 'lu̇-ˈgü-brē-əs');
  assert.equal(w.syll, 'lu·gu·bri·ous');
  assert.match(w.audio, /lugubrious-us\.mp3$/);
  assert.ok((await page.textContent('#vocabList')).includes('\\lu̇-ˈgü-brē-əs\\'), 'shown in the list, between backslashes');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('without a recording the phone’s voice says it; a changed word drops the old recording', async () => {
  const { ctx, page } = await openApp(browser, base);
  await captureSpeech(page);
  await seedVocab(page, [{ word: 'terse', definition: 'Brief.', pron: 'turss' },
                         { word: 'ossify', definition: 'Harden.', audio: 'https://api.dictionaryapi.dev/media/x/ossify-us.mp3' }]);
  await page.evaluate(() => showView('vocab'));
  await page.click('#vocabList .voc-item:has-text("terse") .voc-speak');
  assert.deepEqual(await page.evaluate(() => window.__said), [{ text: 'terse', lang: 'en-US' }]);
  assert.equal(await page.isVisible('#vocabModal'), false, 'the 🔊 does not open the word');

  await page.evaluate(() => openVocabWord('w_seed1'));
  await page.fill('#vocabWord', 'ossified');
  await page.click('#vocabSpeak');
  assert.deepEqual(await page.evaluate(() => window.__played), [], 'not the recording of another word');
  assert.equal(await page.evaluate(() => window.__said.at(-1).text), 'ossified');
  await ctx.close();
});

test('a recording that cannot play (offline) falls back to the voice', async () => {
  const { ctx, page } = await openApp(browser, base);
  await captureSpeech(page, { audioFails: true });
  await seedVocab(page, [{ word: 'ossify', definition: 'Harden.', audio: 'https://api.dictionaryapi.dev/media/x/ossify-us.mp3' }]);
  await page.evaluate(() => showView('vocab'));
  await page.click('#vocabList .voc-speak');
  await page.waitForFunction(() => window.__said.length === 1);
  assert.equal(await page.evaluate(() => window.__said[0].text), 'ossify');
  await ctx.close();
});

test('reviews show the pronunciation — after the answer in the sentence test', async () => {
  const { ctx, page } = await openApp(browser, base);
  await captureSpeech(page);
  await seedVocab(page, [
    { word: 'lugubrious', definition: 'Gloomy.', syll: 'lu·gu·bri·ous', pron: 'lu̇-ˈgü-brē-əs', box: 0 },
    { word: 'obfuscate', definition: 'Make unclear.', syll: 'ob·fus·cate', pron: 'ˈäb-fə-ˌskāt', box: 3, reviews: 3, sentence: 'He kept obfuscating it.' },
  ]);
  await page.evaluate(() => startVocabQuiz());
  assert.match(await page.textContent('.vq-card'), /lu·gu·bri·ous/);
  assert.ok((await page.textContent('.vq-card')).includes('\\lu̇-ˈgü-brē-əs\\'));
  await page.click('.vq-card .voc-speak');
  assert.equal(await page.evaluate(() => window.__said[0].text), 'lugubrious');
  await page.click('#vqReveal');
  await page.click('.vq-btn.good');

  assert.equal(await page.getAttribute('.vq-card', 'data-format'), 'blank');
  assert.doesNotMatch(await page.textContent('.vq-card'), /ob·fus·cate|ˈäb-fə-ˌskāt/, 'no hint before answering');
  assert.equal(await page.locator('.vq-card .voc-speak').count(), 0);
  await page.fill('#vqAnswer', 'obfuscate');
  await page.press('#vqAnswer', 'Enter');
  assert.match(await page.textContent('.vq-card'), /ob·fus·cate/);
  assert.equal(await page.locator('.vq-card .voc-speak').count(), 1);
  await ctx.close();
});

test('opening Vocabulary brings earlier words up to dictionary style, in one Claude request', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_api', 'sk-ant-test'));
  const calls = await stubClaude(page, '```json\n{"Lugubrious":{"syll":"lu·gu·bri·ous","pron":"lu̇-ˈgü-brē-əs"},"terse":{"syll":"terse","pron":"ˈtərs"}}\n```');
  await seedVocab(page, [{ word: 'lugubrious', definition: 'Gloomy.' }, { word: 'terse', definition: 'Brief.', pron: 'TURSS' },
                         { word: 'jocund', definition: 'Cheerful.', syll: 'joc·und', pron: 'ˈjä-kənd' }, { word: 'nodef', definition: '' }]);
  await page.evaluate(() => vocabDB.filter(needsPron).length).then(n => assert.equal(n, 2, 'missing or in the old plain style; defined only'));
  await page.evaluate(() => showView('vocab')); // with a key it runs by itself
  await page.waitForFunction(() => !document.getElementById('vocabFillPron'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /lugubrious\nterse/);
  const by = Object.fromEntries((await storedVocab(page)).map(w => [w.word, [w.syll, w.pron]]));
  assert.deepEqual(by, { lugubrious: ['lu·gu·bri·ous', 'lu̇-ˈgü-brē-əs'], terse: ['terse', 'ˈtərs'],
                         jocund: ['joc·und', 'ˈjä-kənd'], nodef: [undefined, undefined] });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('without a key, the dictionary fills in what it knows', async () => {
  const { ctx, page } = await openApp(browser, base);
  await stubDictionary(page, { terse: { phonetic: '/tɜːs/', audio: 'https://api.dictionaryapi.dev/media/x/terse-us.mp3' } });
  await seedVocab(page, [{ word: 'terse', definition: 'Brief.' }, { word: 'flibbertigibbetish', definition: 'Flighty.' }]);
  await page.evaluate(() => showView('vocab'));
  await page.click('#vocabFillPron');
  await page.waitForFunction(() => /1 word/.test(document.getElementById('vocabFillPron')?.textContent || ''));
  const by = Object.fromEntries((await storedVocab(page)).map(w => [w.word, w]));
  assert.equal(by.terse.pron, '/tɜːs/');
  assert.match(by.terse.audio, /terse-us\.mp3$/);
  assert.equal(by.flibbertigibbetish.pron, undefined);
  await ctx.close();
});

// ── A word's page ────────────────────────────────────────────────────────

test('tapping a word shows its page; Edit is a step further and comes back', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await addBook(page, 'Switzy', 'Some Author');
  const id = await page.evaluate(() => books[0].id);
  await seedVocab(page, [{ word: 'addled', definition: 'Confused.', pos: 'adjective', syll: 'ad·dled', pron: 'ˈa-dᵊld',
                           sentence: 'His addled brain gave up.', page: '12', bookId: id, box: 2, reviews: 2, due: '2999-01-01' }]);
  await page.evaluate(() => showView('vocab'));
  await page.click('#vocabList .voc-row');
  assert.equal(await page.isVisible('#vocabView'), true);
  assert.equal(await page.isVisible('#vocabModal'), false, 'not straight to the editor');
  const text = await page.textContent('#vocabViewBody');
  for (const bit of ['addled', 'ad·dled', '\\ˈa-dᵊld\\', 'adjective', 'Confused.', 'from Switzy, page 12', 'Reviewed 2 times'])
    assert.ok(text.includes(bit), `shows ${bit}`);
  assert.equal(await page.locator('#vocabViewBody .vv-step.on').count(), 2, 'two of five steps to mastered');
  assert.equal(await page.locator('#vocabViewBody .vv-quote mark').textContent(), 'addled');

  await page.click('#vocabViewEdit');
  assert.equal(await page.isVisible('#vocabModal'), true);
  assert.equal(await page.isVisible('#vocabView'), false);
  await page.click('#vocabCancelBtn');
  assert.equal(await page.isVisible('#vocabView'), true, 'Cancel goes back to the page');

  await page.click('#vocabViewEdit');
  await page.fill('#vocabDef', 'Muddled, confused.');
  await page.click('#vocabSaveBtn');
  assert.equal(await page.isVisible('#vocabView'), true, 'Save goes back to the page too');
  assert.match(await page.textContent('#vocabViewBody'), /Muddled, confused\./, 'showing the edit');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#vocabView'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('words in a book and on the Lists card open their page too', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Switzy');
  const id = await page.evaluate(() => books[0].id);
  await seedVocab(page, [{ word: 'slough', definition: 'Shed.', bookId: id }]);
  await page.evaluate(i => { openEditModal(i); switchModalTab('reading'); }, id);
  await page.click('#vocabBookList .voc-book-row');
  assert.equal(await page.isVisible('#vocabView'), true);
  await page.click('#vocabViewBody .vv-foot .btn-primary');
  await page.evaluate(() => { closeM('bookModal'); showView('lists'); });
  await page.click('#vocabCard .voc-row');
  assert.equal(await page.isVisible('#vocabView'), true);
  await ctx.close();
});

test('the Today card shows the words waiting, and a word of the day once caught up', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedVocab(page, [{ word: 'addled', definition: 'Confused.' }, { word: 'slough', definition: 'Shed.' },
                         { word: 'interstitial', definition: 'Between.' }, { word: 'tenebrous', definition: 'Dark.' }]);
  await page.evaluate(() => showView('log'));
  await page.waitForSelector('#vocabNudge');
  assert.equal(await page.textContent('#vocabNudge .vn-badge b'), '4');
  assert.deepEqual(await page.$$eval('#vocabNudge .vn-chip', els => els.map(e => e.textContent)),
                   ['addled', 'slough', 'interstitial', '+1']);

  await page.evaluate(() => { vocabDB.forEach(w => w.due = '2999-01-01'); save(SK.vocab, vocabDB); renderLogSession(); });
  const first = await page.textContent('#vocabNudge .vn-word');
  await page.evaluate(() => renderLogSession());
  assert.equal(await page.textContent('#vocabNudge .vn-word'), first, 'the same word all day');
  const week = await page.evaluate(() => new Set(Array.from({ length: 14 }, (_, i) => wordOfTheDay(vocabDB, addDaysStr('2026-10-01', i)).word)).size);
  assert.ok(week > 1, 'but not the same word every day');
  await ctx.close();
});

// ── Library filters (dropdowns) ──────────────────────────────────────────

async function seedLibrary(page) {
  await page.evaluate(() => {
    const B = (id, title, status, extra = {}) => ({ id, title, author: 'A', status, formats: ['physical'], addedAt: 1, updatedAt: 1, ...extra });
    books = [B('a', 'Hill House', 'unread', { genre: 'Horror' }), B('b', 'Dune', 'reading', { genre: 'Science Fiction', formats: ['audio'] }),
             B('c', 'Piranesi', 'read', { genre: 'Fantasy', lists: ['tbr'] }), B('d', 'House in the Cerulean Sea', 'read', { genre: 'Fantasy' }),
             B('w', 'Wanted', 'wishlist', { genre: 'Romance' })];
    save(SK.books, books); showView('library'); renderLibrary();
  });
  await page.waitForFunction(() => location.hash === '#library');
}
const shownTitles = page => page.$$eval('#booksGrid .book-title', els => els.map(e => e.textContent.trim()));

test('library filters are dropdowns with counts, and only options some book has', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedLibrary(page);
  assert.equal(await page.locator('#view-library .chip').count(), 0, 'no more rows of pills');
  assert.deepEqual(await page.$$eval('#fGenre option', o => o.map(x => x.textContent)),
                   ['Genre', 'Fantasy (2)', 'Horror (1)', 'Science Fiction (1)'], 'the wishlist is not counted');
  assert.deepEqual(await page.$$eval('#fFormat option', o => o.map(x => x.textContent)),
                   ['Format', 'Physical (3)', 'Audio (1)'], 'formats nobody uses are left out');
  assert.equal(await page.isVisible('#fRoom'), false, 'no rooms set, so no Room filter');
  assert.equal(await page.isVisible('#fClear'), false);

  await page.selectOption('#fGenre', 'Horror');
  assert.deepEqual(await shownTitles(page), ['Hill House']);
  assert.equal(await page.$eval('#fGenre', s => s.selectedOptions[0].textContent), 'Horror', 'reads as the choice');
  assert.equal(await page.$eval('#fGenre', s => s.classList.contains('on')), true);
  assert.equal(await page.textContent('#libCount'), '1 of 4 books');

  await page.selectOption('#fGenre', 'Fantasy');
  await page.selectOption('#fStatus', 'read');
  assert.deepEqual((await shownTitles(page)).sort(), ['House in the Cerulean Sea', 'Piranesi']);
  await page.selectOption('#fList', 'tbr');
  assert.deepEqual(await shownTitles(page), ['Piranesi'], 'filters combine');

  await page.click('#fClear');
  assert.equal((await shownTitles(page)).length, 4);
  assert.equal(await page.isVisible('#fClear'), false);
  assert.equal(await page.$eval('#fGenre', s => s.value), '');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('rooms appear as a filter once a book has one; nothing matching says so', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedLibrary(page);
  await page.evaluate(() => { books[0].location = { room: 'Office' }; save(SK.books, books); renderLibrary(); });
  assert.equal(await page.isVisible('#fRoom'), true);
  await page.selectOption('#fRoom', 'Office');
  assert.deepEqual(await shownTitles(page), ['Hill House']);
  await page.fill('#searchInput', 'zzz');
  await page.waitForFunction(() => /Nothing matches/.test(document.getElementById('booksGrid').textContent));
  assert.equal(await page.isVisible('#emptyLib'), false, 'not "your shelf is empty"');
  await ctx.close();
});

test('a genre tapped in Stats opens the Library filtered to it', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedLibrary(page);
  await page.evaluate(() => browseGenre('Horror'));
  await page.waitForFunction(() => location.hash === '#library');
  assert.equal(await page.$eval('#fGenre', s => s.value), 'Horror');
  assert.deepEqual(await shownTitles(page), ['Hill House']);
  assert.equal(await page.inputValue('#searchInput'), '', 'a filter, not a search');
  await ctx.close();
});

test('genre and room names in the dropdowns are shown as text', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => {
    books = [{ id: 'x', title: 'T', author: 'A', status: 'read', genre: '<img src=x onerror="window.__pwned=1">',
               location: { room: '<b>Den</b>' }, addedAt: 1, updatedAt: 1 }];
    save(SK.books, books); showView('library'); renderLibrary();
  });
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#libFilters img, #libFilters b').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('filter counts reflect the other filters, so an option never leads to zero books', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => {
    const B = (id, status, extra = {}) => ({ id, title: 'Book ' + id, author: 'A', status, formats: ['physical'], addedAt: 1, updatedAt: 1, ...extra });
    books = [B('f1', 'read', { rating: 5, genre: 'Fantasy' }), B('f2', 'read', { rating: 5, genre: 'Horror' }),
             B('u1', 'unread', { lists: ['tbr'], genre: 'Fantasy' }), B('u2', 'unread', { genre: 'Horror', formats: ['audio'] }),
             B('r1', 'reading', { lists: ['tbr'], genre: 'Fantasy', loans: [{ to: 'Sam', date: '2026-10-01' }] })];
    save(SK.books, books); showView('library'); renderLibrary();
  });
  await page.waitForFunction(() => location.hash === '#library');
  const opts = sel => page.$$eval(`${sel} option`, o => o.map(x => x.textContent));

  // The reported case: Unread chosen, Favorites (all read) must not be offered.
  await page.selectOption('#fStatus', 'unread');
  assert.deepEqual(await opts('#fList'), ['Lists', 'To be read (1)']);
  assert.deepEqual(await opts('#fGenre'), ['Genre', 'Fantasy (1)', 'Horror (1)']);
  assert.deepEqual(await opts('#fFormat'), ['Format', 'Physical (1)', 'Audio (1)']);

  // The search narrows the counts too.
  await page.selectOption('#fStatus', '');
  await page.fill('#searchInput', 'Book u');
  await page.waitForFunction(() => document.querySelectorAll('#booksGrid .book-title').length === 2);
  assert.deepEqual(await opts('#fStatus'), ['Status', 'Unread (2)']);
  await page.fill('#searchInput', '');
  await page.waitForFunction(() => document.querySelectorAll('#booksGrid .book-title').length === 5);

  // Every option, under another filter, gives exactly the count it shows.
  await page.selectOption('#fGenre', 'Fantasy');
  for (const sel of ['#fStatus', '#fList', '#fFormat']) {
    const choices = await page.$$eval(`${sel} option`, o => o.slice(1).map(x => [x.value, +x.textContent.match(/\((\d+)\)/)[1]]));
    for (const [v, n] of choices) {
      await page.selectOption(sel, v);
      assert.equal(await page.locator('#booksGrid .book-title').count(), n, `${sel}=${v} promised ${n}`);
      await page.selectOption(sel, '');
    }
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ── Mind maps ────────────────────────────────────────────────────────────

const MAP_REPLY = await readFile(join(ROOT, 'tests/fixtures/cerulean-map.json'), 'utf8');
const storedMaps = page => page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_maps') || '{}'));

async function seedFinished(page, { key = true, status = 'read' } = {}) {
  await page.evaluate(([key, status]) => {
    if (key) localStorage.setItem(SK.api, 'sk-ant-test');
    books = [{ id: 'b1', title: 'The House in the Cerulean Sea', author: 'T. J. Klune', status, rating: 4,
               notes: 'Lovely and kind.', addedAt: 1, updatedAt: 1 }];
    journalDB = { b1: [{ date: '2026-06-10', time: '9 PM', type: 'highlight', text: 'Lucy danced to another record.', page: '112', at: 5 }] };
    save(SK.books, books); save(SK.journal, journalDB); renderLibrary();
  }, [key, status]);
}

async function makeMap(page) {
  await page.evaluate(() => openMindmap('b1'));
  await page.click('#mmCreate');
  await page.waitForFunction(() => document.getElementById('mmBody').style.display === 'block');
}

test('a finished book gets a mind map from Claude, drawn and saved', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedFinished(page);
  const calls = await stubClaude(page, MAP_REPLY);
  await makeMap(page);
  assert.equal(calls.length, 1);
  const prompt = calls[0].messages[0].content;
  assert.match(prompt, /Cerulean Sea/);
  assert.doesNotMatch(prompt, /Lucy danced|Lovely and kind/, 'the map describes the book, not the reader’s notes');
  assert.equal(calls[0].tools?.[0]?.type, 'web_search_20260209', 'web search is on offer');
  assert.match(prompt, /use web search/);
  assert.equal(await page.locator('#mmMap .mm-node').count(), 18);
  assert.equal(await page.locator('#mmMap .mm-branch').count(), 5);
  assert.match(await page.textContent('#mmThesis'), /family is something you choose/);
  assert.equal(await page.textContent('#mmProgress'), 'Explored 0 of 18');
  const stored = await storedMaps(page);
  assert.equal(stored.b1.map.motif, 'sea');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('tapping a bubble teaches more, links jump, prev/next walk the map, and explored sticks', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaude(page, MAP_REPLY);
  await makeMap(page);

  await page.click('#mmMap [data-node="lucy"]');
  const sheet = page.locator('#mmSheet');
  await sheet.locator('.mm-s-title', { hasText: 'Lucy' }).waitFor();
  const labels = await sheet.locator('.mm-s-lbl').allTextContents();
  for (const l of ['REMINDER', 'GOING DEEPER', 'FROM YOUR NOTES', 'CONNECTED TO'])
    assert.ok(labels.includes(l), `has ${l} (got ${labels.join(', ')})`);
  assert.match(await sheet.textContent(), /Lucy danced to another record/);
  assert.equal(await page.textContent('#mmProgress'), 'Explored 1 of 18');

  await sheet.locator('.mm-chip').first().click();
  await sheet.locator('.mm-s-title', { hasText: 'Linus' }).waitFor();

  await page.keyboard.press('Escape');
  await page.click('#mmMap [data-node="talia"]');
  await sheet.locator('.mm-s-title', { hasText: 'Talia' }).waitFor();
  assert.ok(await page.locator('#mmPrev').isDisabled(), 'first bubble has no previous');
  await page.click('#mmNext');
  await sheet.locator('.mm-s-title', { hasText: 'Theodore' }).waitFor();
  assert.match(await sheet.textContent(), /2 \/ 18/);
  await page.click('#mmPrev');
  await sheet.locator('.mm-s-title', { hasText: 'Talia' }).waitFor();

  await page.reload();
  await page.waitForFunction(() => typeof window.saveBook === 'function');
  await page.evaluate(() => openMindmap('b1'));
  assert.equal(await page.textContent('#mmProgress'), 'Explored 4 of 18', 'opens instantly, progress kept');
  assert.equal(await page.locator('#mmMap .mm-node.seen').count(), 4);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the chronology lists the story in order and links into the map', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaude(page, MAP_REPLY);
  await makeMap(page);
  await page.click('#mmTimelineBtn');
  const beats = page.locator('#mmSheet .mm-tl > li');
  assert.equal(await beats.count(), 7);
  assert.match(await beats.first().textContent(), /The assignment/);
  await beats.first().locator('.mm-chip', { hasText: 'Linus' }).click();
  await page.locator('#mmSheet .mm-s-title', { hasText: 'Linus' }).waitFor();
  await page.keyboard.press('Escape');
  assert.ok(!(await page.locator('#mmSheet').isVisible()), 'Escape closes the card first');
  await page.keyboard.press('Escape');
  assert.ok(!(await page.locator('#mindmapView').isVisible()), 'then the map');
  await ctx.close();
});

test('remaking takes two taps and replaces the map', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  const calls = await stubClaude(page, MAP_REPLY);
  await makeMap(page);
  await page.click('#mmRegen');
  assert.equal(await page.textContent('#mmRegen'), 'Tap again to remake');
  assert.equal(calls.length, 1, 'one tap does nothing yet');
  await page.click('#mmRegen');
  await page.waitForFunction(() => document.getElementById('mmBody').style.display === 'block');
  assert.equal(calls.length, 2);
  await ctx.close();
});

test('without a key the map explains what to do instead of calling Claude', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page, { key: false });
  await page.evaluate(() => openMindmap('b1'));
  assert.match(await page.textContent('#mmEmptyText'), /API key in Settings/);
  assert.ok(await page.locator('#mmCreate').isDisabled());
  await ctx.close();
});

for (const [why, reply, msg] of [['an API error', 500, /Overloaded/], ['a reply that is not a map', 'Sorry, I can’t.', /usable map/]]) {
  test(`${why} explains itself and leaves Make the map to try again`, async () => {
    const { ctx, page } = await openApp(browser, base);
    await seedFinished(page);
    await stubClaude(page, reply);
    await page.evaluate(() => openMindmap('b1'));
    await page.click('#mmCreate');
    await page.waitForFunction(() => /Couldn’t make the map/.test(document.getElementById('mmStatus').textContent));
    assert.match(await page.textContent('#mmStatus'), msg);
    assert.ok(!(await page.locator('#mmCreate').isDisabled()));
    assert.deepEqual(await storedMaps(page), {});
    await ctx.close();
  });
}

test('markup from the model is shown as text, not run', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedFinished(page);
  const evil = '<img src=x onerror="window.__pwned=1">';
  await stubClaude(page, JSON.stringify({ thesis: evil, motif: 'night', branches: [{ label: evil, nodes: [{ title: evil, remind: evil, deeper: evil }] }],
    timeline: [{ title: evil, summary: evil }] }));
  await makeMap(page);
  await page.evaluate(() => showMindmapNode(_mm.order[0]));
  await page.evaluate(() => showMindmapTimeline());
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#mindmapView img').count(), 0);
  assert.equal(await page.textContent('#mmThesis'), evil);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the map button is only for finished books, on the card and in the editor', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page, { status: 'reading' });
  await page.evaluate(() => showView('library'));
  assert.equal(await page.locator('#booksGrid .mm-cardbtn').count(), 0);
  await page.evaluate(() => openEditModal('b1'));
  assert.ok(!(await page.locator('#mmOpenBtn').isVisible()));
  await page.evaluate(() => { closeM('bookModal'); books[0].status = 'read'; save(SK.books, books); renderLibrary(); });
  assert.equal(await page.locator('#booksGrid .mm-cardbtn').count(), 1);
  await page.evaluate(() => openEditModal('b1'));
  assert.equal(await page.textContent('#mmOpenBtn'), '🧠 Make a mind map');
  await ctx.close();
});

test('maps sync (newer wins), go into backups, and go away with their book', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaude(page, MAP_REPLY);
  await makeMap(page);
  const r = await page.evaluate(() => {
    const mine = mindmapDB.b1;
    const older = { ...mine, updatedAt: mine.updatedAt - 1000, seen: ['old'] };
    const newer = { ...mine, updatedAt: mine.updatedAt + 1000, seen: ['lucy'] };
    const keep = mergeState(currentState(), remoteState({ v: 2, books, maps: { b1: older } })).maps.b1.seen;
    const take = mergeState(currentState(), remoteState({ v: 2, books, maps: { b1: newer } })).maps.b1.seen;
    return { keep, take, inGist: !!JSON.parse(gistPayload(currentState())).maps?.b1 };
  });
  assert.deepEqual(r.keep, ['old'], 'explored bubbles from either copy are kept');
  assert.deepEqual(r.take, ['lucy']);
  assert.ok(r.inGist, 'the gist payload carries maps');
  await page.evaluate(() => closeMindmap());
  await page.evaluate(() => { window.confirm = () => true; deleteBook('b1'); });
  await page.waitForFunction(() => !mindmapDB.b1);
  assert.deepEqual(await storedMaps(page), {});
  await ctx.close();
});

// ── Mind maps, made automatically ────────────────────────────────────────

async function seedShelfForMaps(page, list) {
  await page.evaluate(list => {
    localStorage.setItem(SK.api, 'sk-ant-test');
    books = list.map(([id, title, status, date]) => ({ id, title, author: 'A', status, date, addedAt: 1, updatedAt: 1 }));
    save(SK.books, books); renderLibrary();
  }, list);
}

test('every finished book gets a map in the background, newest first, and nothing else does', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedShelfForMaps(page, [['r1', 'Older Read', 'read', '2025-01-02'], ['r2', 'Newer Read', 'read', '2026-09-01'],
                                ['n1', 'Still Reading', 'reading'], ['a1', 'An Article', 'read']]);
  await page.evaluate(() => { books.find(b => b.id === 'a1').itemType = 'article'; });
  const calls = await stubClaude(page, MAP_REPLY);
  await page.evaluate(() => setMindmapAuto(true));
  await page.waitForFunction(() => mindmapDB.r1 && mindmapDB.r2, null, { timeout: 15000 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].messages[0].content, /Newer Read/, 'most recently finished first');
  const stored = await storedMaps(page);
  assert.deepEqual(Object.keys(stored).sort(), ['r1', 'r2']);
  await page.evaluate(() => showView('settings'));
  assert.ok(await page.locator('#mmAutoToggle').isChecked());
  assert.match(await page.textContent('#mmAutoStatus'), /2 of 2 finished books have a map/);
  await page.evaluate(() => openMindmap('r2'));
  assert.equal(await page.locator('#mmMap .mm-node').count(), 18, 'opens straight to the map');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('marking a book read makes its map, with a note when it is ready', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_mm_auto', 'on'));
  await seedShelfForMaps(page, [['b1', 'Dune', 'reading']]);
  const calls = await stubClaude(page, MAP_REPLY);
  await page.waitForTimeout(500);
  assert.equal(calls.length, 0);
  await page.evaluate(() => { books[0].status = 'read'; save(SK.books, books); });
  await page.waitForFunction(() => mindmapDB.b1, null, { timeout: 15000 });
  await page.locator('.toast', { hasText: 'Mind map ready for Dune' }).first().waitFor();
  assert.equal(calls.length, 1);
  await ctx.close();
});

test('a key problem pauses the queue instead of retrying every book', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelfForMaps(page, [['b1', 'One', 'read'], ['b2', 'Two', 'read'], ['b3', 'Three', 'read']]);
  const calls = await stubClaude(page, 401);
  await page.evaluate(() => setMindmapAuto(true));
  await page.evaluate(() => showView('settings'));
  await page.waitForFunction(() => /Paused/.test(document.getElementById('mmAutoStatus').textContent), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  assert.equal(calls.length, 1);
  assert.deepEqual(await storedMaps(page), {});
  await ctx.close();
});

test('turned off in Settings, nothing is made', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => localStorage.setItem('trr_v1_mm_auto', 'on'));
  await seedShelfForMaps(page, []);
  const calls = await stubClaude(page, MAP_REPLY);
  await page.evaluate(() => showView('settings'));
  assert.ok(await page.locator('#mmAutoToggle').isChecked());
  await page.click('#mmAutoToggle');
  assert.equal(await page.evaluate(() => localStorage.getItem('trr_v1_mm_auto')), 'off');
  await page.evaluate(() => { books = [{ id: 'b1', title: 'Dune', status: 'read', addedAt: 1, updatedAt: 1 }]; save(SK.books, books); scheduleMindmaps(0); });
  await page.waitForTimeout(800);
  assert.equal(calls.length, 0);
  await ctx.close();
});

test('opening a book while its map is being made says so instead of starting another', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelfForMaps(page, [['b1', 'Dune', 'read']]);
  const calls = await stubClaude(page, MAP_REPLY);
  // Hold the reply until the map screen is open.
  await page.evaluate(() => { const f = window.fetch; window.fetch = async (u, o) => { await new Promise(r => { window.__release = r; }); return f(u, o); }; });
  await page.evaluate(() => setMindmapAuto(true));
  await page.waitForFunction(() => typeof window.__release === 'function');
  await page.evaluate(() => openMindmap('b1'));
  assert.match(await page.textContent('#mmStatus'), /Being made now/);
  assert.ok(await page.locator('#mmCreate').isDisabled());
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => document.getElementById('mmBody').style.display === 'block');
  assert.equal(calls.length, 1);
  await ctx.close();
});

test('a file of mind maps imports into the matching books and says how many', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedFinished(page);
  const dialogs = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  const map = JSON.parse(MAP_REPLY);
  const file = JSON.stringify({ version: 2, books: [], maps: { b1: { map, createdAt: 5, updatedAt: 5, seen: [] } } });
  await page.evaluate(() => showView('settings'));
  await page.setInputFiles('#importFile', { name: 'maps.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await page.locator('.toast', { hasText: '1 new mind map(s)' }).first().waitFor();
  assert.match(dialogs[0], /0 new book\(s\), 1 new mind map\(s\)/);
  await page.evaluate(() => openMindmap('b1'));
  assert.equal(await page.locator('#mmMap .mm-node').count(), 18);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('books imported from a file look up their own covers', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await stubCatalogues(page, { olSearch: { docs: [{ cover_i: 4242 }] } });
  const file = JSON.stringify({ version: 2, books: [
    { id: 'k1', title: 'Kindred', author: 'Octavia Butler', status: 'read', rating: 5, date: '2026-02-21', addedAt: 1, updatedAt: 1 },
    { id: 'k2', title: 'Piranesi', author: 'Susanna Clarke', status: 'read', rating: 3, date: '2026-03-30', addedAt: 2, updatedAt: 2 }] });
  await page.evaluate(() => showView('settings'));
  await page.setInputFiles('#importFile', { name: 'reads.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await page.waitForFunction(() => coversDB.k1 && coversDB.k2, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => coversDB.k1), 'https://covers.openlibrary.org/b/id/4242-M.jpg');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('books already in the library without a cover get one, and a miss is not retried every launch', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const calls = await stubCatalogues(page, { olSearch: { docs: [{ cover_i: 77 }] } });
  await page.evaluate(() => {
    books = [{ id: 'c1', title: 'Kindred', author: 'Octavia Butler', status: 'read', addedAt: 1, updatedAt: 1 },
             { id: 'c2', title: 'Has One', author: 'A', status: 'read', addedAt: 2, updatedAt: 2 },
             { id: 'c3', title: 'An Article', author: 'B', itemType: 'article', status: 'read', addedAt: 3, updatedAt: 3 }];
    coversDB = { c2: 'https://example.com/c2.jpg' };
    save(SK.books, books); save(SK.covers, coversDB); renderLibrary();
    scheduleCoverFill(0);
  });
  await page.waitForFunction(() => coversDB.c1, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => coversDB.c1), 'https://covers.openlibrary.org/b/id/77-M.jpg');
  assert.equal(await page.evaluate(() => coversDB.c3), undefined, 'articles are left alone');
  assert.equal(calls.filter(c => c === 'ol-search').length, 1, 'only the book without a cover is looked up');

  // Nothing found anywhere: remembered, so the next launch doesn't search again.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const calls2 = await stubCatalogues(page);
  await page.evaluate(() => { books.push({ id: 'c4', title: 'Obscure', author: 'Nobody', status: 'read', addedAt: 4, updatedAt: 4 }); save(SK.books, books); scheduleCoverFill(0); });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('trr_v1_cover_tried') || '{}').c4, null, { timeout: 15000 });
  const before = calls2.length;
  await page.evaluate(() => scheduleCoverFill(0));
  await page.waitForTimeout(500);
  assert.equal(calls2.length, before);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ── Daily Deep Dive ──────────────────────────────────────────────────────

// A finished book with a map, and today's question fixed to a given type.
async function seedDive(page, type, map = JSON.parse(MAP_REPLY)) {
  return page.evaluate(([type, raw]) => {
    books = [{ id: 'b1', title: 'The House in the Cerulean Sea: A Novel', author: 'T. J. Klune', status: 'read', addedAt: 1, updatedAt: 1 }];
    mindmapDB = { b1: { map: normalizeMindmap(raw), createdAt: 1, updatedAt: 1, seen: [] } };
    save(SK.books, books); save(SK.maps, mindmapDB);
    const today = localDateStr(); let d = today, q = null;
    for (let i = 0; i < 40 && !(q && q.type === type); i++) { q = deepDivePick(d, books, mindmapDB, {}); d = ddAddDays(d, 1); }
    q.date = today; deepDiveDB = { days: { [today]: q }, seenOn: {} }; ddSave();
    showView('log'); renderLogSession();
    return q;
  }, [type, map]);
}

test('Today shows the deep dive card only when a finished book has a map', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => { showView('log'); renderLogSession(); });
  assert.equal(await page.locator('#deepDiveCard').count(), 0);
  await seedDive(page, 'who');
  const card = page.locator('#deepDiveCard');
  assert.match(await card.textContent(), /DAILY DEEP DIVE/);
  assert.match(await card.textContent(), /The House in the Cerulean Sea/);
  assert.doesNotMatch(await card.textContent(), /A Novel/, 'subtitle trimmed');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a "who or what" question: pick, see the answer and more, and the bubble counts as explored', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const q = await seedDive(page, 'who');
  await page.click('#deepDiveCard');
  const sheet = page.locator('#ddSheet');
  const answer = await page.evaluate(id => mmNodeIn(mindmapDB.b1.map, id), q.nodeId);
  assert.doesNotMatch(await sheet.locator('.dd-q').textContent(), new RegExp(`\\b${answer.title}\\b`), 'the clue doesn\'t give it away');
  assert.equal(await sheet.locator('.dd-opt').count(), 3);
  const wrong = q.options.find(id => id !== q.nodeId);
  const wrongTitle = await page.evaluate(id => mmNodeIn(mindmapDB.b1.map, id).title, wrong);
  await sheet.locator('.dd-opt', { hasText: wrongTitle }).click();
  await sheet.locator('.dd-verdict', { hasText: `It was ${answer.title}` }).waitFor();
  assert.equal(await sheet.locator('.dd-opt.right').count(), 1);
  assert.equal(await sheet.locator('.dd-opt.wrong').count(), 1);
  assert.match(await sheet.textContent(), /GOING DEEPER/);
  assert.ok(await page.evaluate(id => mindmapDB.b1.seen.includes(id), q.nodeId));
  assert.ok(await page.evaluate(id => JSON.parse(localStorage.getItem('trr_v1_maps')).b1.seen.includes(id), q.nodeId));

  await sheet.locator('text=Open in the map').click();
  await page.locator('#mmSheet .mm-s-title', { hasText: answer.title }).waitFor();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

  // Same question all day, remembered as answered.
  await page.reload(); await page.waitForFunction(() => typeof window.saveBook === 'function');
  await page.evaluate(() => { showView('log'); renderLogSession(); });
  assert.match(await page.textContent('#deepDiveCard'), /Done — back tomorrow/);
  assert.match(await page.textContent('#deepDiveCard'), /1 day/);
  await page.click('#deepDiveCard');
  assert.equal(await page.locator('#ddSheet .dd-opt.wrong').count(), 1, 'reopening shows how you answered');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a chronology question: tap in order, tap again to undo, then see the chronology', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const q = await seedDive(page, 'order');
  await page.click('#deepDiveCard');
  const beats = page.locator('#ddSheet .dd-beat');
  assert.equal(await beats.count(), 3);
  // Tap the beats in true order (with an undo along the way).
  const pos = i => q.shown.indexOf(q.beats[i]);
  await beats.nth(pos(0)).click();
  await beats.nth(pos(1)).click(); await beats.nth(pos(1)).click(); // undo
  assert.equal(await page.locator('#ddSheet .dd-beat.sel').count(), 1);
  await beats.nth(pos(1)).click();
  await beats.nth(pos(2)).click();
  await page.locator('#ddSheet .dd-verdict', { hasText: 'Right' }).waitFor();
  assert.equal(await page.locator('#ddSheet .dd-beat.right').count(), 3);
  await page.locator('#ddSheet', { hasText: 'See the chronology' }).locator('text=See the chronology').click();
  await page.locator('#mmSheet .mm-tl').waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('"think about it" saves a thought to that book\'s journal', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const q = await seedDive(page, 'think');
  await page.click('#deepDiveCard');
  await page.click('#ddSheet >> text=Save to journal');
  assert.equal(await page.evaluate(() => (journalDB.b1 || []).length), 0, 'nothing written, nothing saved');
  await page.fill('#ddNote', 'Family is chosen.');
  await page.click('#ddSheet >> text=Save to journal');
  await page.locator('#ddSheet .dd-reveal', { hasText: 'Family is chosen.' }).waitFor();
  const entry = await page.evaluate(() => journalDB.b1[0]);
  assert.match(entry.text, /Family is chosen\./);
  assert.equal(entry.date, await page.evaluate(() => localDateStr()));
  assert.ok(await page.evaluate(id => mindmapDB.b1.seen.includes(id), q.nodeId));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('"Not today" hides the card until tomorrow, and Escape closes the sheet', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedDive(page, 'who');
  await page.click('#deepDiveCard');
  await page.keyboard.press('Escape');
  assert.ok(!(await page.locator('#ddSheet').isVisible()));
  await page.click('#deepDiveCard');
  await page.click('#ddSheet >> text=Not today');
  assert.equal(await page.locator('#deepDiveCard').count(), 0);
  await page.reload(); await page.waitForFunction(() => typeof window.saveBook === 'function');
  await page.evaluate(() => { showView('log'); renderLogSession(); });
  assert.equal(await page.locator('#deepDiveCard').count(), 0);
  await ctx.close();
});

test('markup in a map is shown as text in the deep dive', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  const evil = '<img src=x onerror="window.__pwned=1">';
  await seedDive(page, 'who', { emblem: '📖', branches: [{ label: 'X', nodes: [
    { title: evil, remind: evil + ' is here' }, { title: 'B', remind: 'b' }, { title: 'C', remind: 'c' }] }] });
  await page.click('#deepDiveCard');
  await page.locator('#ddSheet .dd-opt').first().click();
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#ddView img').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ── Map summaries ────────────────────────────────────────────────────────

// Claude answers from a queue, for tests that need a map and then a summary.
async function stubClaudeQueue(page, replies) {
  const calls = [];
  await page.exposeFunction('__claudeQueued', body => { calls.push(JSON.parse(body)); });
  await page.evaluate(replies => {
    window.__replies = replies;
    window.fetch = async (url, opts) => {
      await window.__claudeQueued(opts.body);
      const r = window.__replies.shift();
      return new Response(JSON.stringify({ content: [{ type: 'text', text: r }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, replies);
  return calls;
}

const SUMMARY = { line: 'Family is something you choose.', story: ['Linus goes to the island.', 'He falls for the house.'],
  ideas: [{ title: 'Chosen family', text: 'Care over blood.' }], ending: 'He goes back to stay.', worth: 'A sequel exists.' };

test('the Summary button opens the one line, story, ideas, ending and context', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaude(page, JSON.stringify({ ...JSON.parse(MAP_REPLY), summary: SUMMARY }));
  await makeMap(page);
  await page.click('#mmSummaryBtn');
  const sheet = page.locator('#mmSheet');
  await sheet.locator('.sm-line', { hasText: 'Family is something you choose.' }).waitFor();
  const labels = await sheet.locator('.mm-s-lbl').allTextContents();
  assert.deepEqual(labels, ['IN ONE LINE', 'THE STORY', 'WHAT IT’S REALLY GETTING AT', 'THE ENDING, EXPLAINED', 'WORTH KNOWING']);
  assert.equal(await sheet.locator('.sm-para').count(), 2);
  assert.match(await sheet.locator('.mm-s-title').textContent(), /The House in the Cerulean Sea, in short/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('new maps ask Claude for a summary too', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  const calls = await stubClaude(page, MAP_REPLY);
  await makeMap(page);
  assert.match(calls[0].messages[0].content, /"summary":\{"line"/);
  await ctx.close();
});

test('an older map without a summary can have one written, keeping what was explored', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedFinished(page);
  const calls = await stubClaudeQueue(page, [MAP_REPLY, JSON.stringify(SUMMARY)]);
  await makeMap(page);
  await page.evaluate(() => { mindmapDB.b1.seen = ['lucy']; save(SK.maps, mindmapDB); });
  await page.click('#mmSummaryBtn');
  await page.click('#mmSumCreate');
  await page.locator('#mmSheet .sm-line', { hasText: 'Family is something you choose.' }).waitFor();
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /Spoilers are fine/);
  const stored = await storedMaps(page);
  assert.equal(stored.b1.map.summary.line, 'Family is something you choose.');
  assert.deepEqual(stored.b1.seen, ['lucy']);
  assert.equal(stored.b1.map.branches.length, 5, 'the map itself is untouched');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a failed summary explains itself and can be retried; no key explains what to do', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaudeQueue(page, [MAP_REPLY, 'not json']);
  await makeMap(page);
  await page.click('#mmSummaryBtn');
  await page.click('#mmSumCreate');
  await page.locator('#mmSumStatus', { hasText: 'Couldn’t write it' }).waitFor();
  assert.ok(!(await page.locator('#mmSumCreate').isDisabled()));
  await page.evaluate(() => { localStorage.removeItem(SK.api); closeMindmapSheet(); showMindmapSummary(); });
  assert.match(await page.textContent('#mmSheet'), /Add your Anthropic API key/);
  assert.equal(await page.locator('#mmSumCreate').count(), 0);
  await ctx.close();
});

test('a map file with summaries imports without resetting explored bubbles', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaude(page, MAP_REPLY);
  await makeMap(page);
  await page.evaluate(() => { mindmapDB.b1.seen = ['lucy', 'talia']; save(SK.maps, mindmapDB); });
  const map = { ...JSON.parse(MAP_REPLY), summary: SUMMARY };
  const file = JSON.stringify({ version: 2, books: [], maps: { b1: { map, createdAt: 1, updatedAt: Date.now() + 1000, seen: [] } } });
  await page.evaluate(() => { closeMindmap(); showView('settings'); });
  await page.setInputFiles('#importFile', { name: 'summaries.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await page.waitForFunction(() => mindmapDB.b1.map.summary);
  await page.locator('.toast', { hasText: '1 mind map(s) updated' }).first().waitFor();
  assert.deepEqual((await storedMaps(page)).b1.seen.sort(), ['lucy', 'talia']);
  await ctx.close();
});

// ── Finishing a book on Today ────────────────────────────────────────────

test('finishing a book on Today goes straight to its final review', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => {
    books = [{ id: 'f1', title: 'Dune', author: 'Frank Herbert', status: 'reading', addedAt: 1, updatedAt: 1 }];
    save(SK.books, books); showView('log'); renderLogSession();
  });
  await page.evaluate(() => toggleLogCard('f1'));
  await page.locator('#logcard-f1 >> text=Finished this book').click();
  await page.waitForFunction(() => document.getElementById('bookModal').classList.contains('open') || getComputedStyle(document.getElementById('bookModal')).display !== 'none');
  await page.locator('.final-review-tip').waitFor();
  assert.equal(await page.evaluate(() => books[0].status), 'read');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bNotes');
  assert.ok(await page.locator('.modal-tab-panel[data-panel="reading"]').isVisible(), 'the My Reading tab is showing');
  await page.fill('#bNotes', 'A classic for a reason.');
  await page.evaluate(() => saveBook());
  await page.waitForFunction(() => books[0].notes === 'A classic for a reason.');
  // The highlight doesn't linger on the next open.
  await page.evaluate(() => openEditModal('f1'));
  assert.equal(await page.locator('.final-review-tip').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ── Storage check ────────────────────────────────────────────────────────

test('Settings shows storage by owner, and clears old Reading Room copies in two taps', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await addBook(page, 'Dune', 'Frank Herbert');
  await page.evaluate(() => {
    localStorage.setItem('trr4_books', JSON.stringify([{ title: 'old' }]) + 'x'.repeat(200000));
    localStorage.setItem('trr_covers', 'y'.repeat(50000));
    localStorage.setItem('howlers_v3_data', 'z'.repeat(80000));
    showView('settings');
  });
  const card = page.locator('#storageCard');
  assert.match(await card.textContent(), /of about 5 MB used/);
  assert.match(await card.textContent(), /Reading Room — old versions/);
  assert.match(await card.textContent(), /Another app \(howlers…\)/);
  assert.match(await card.textContent(), /trr4_books/, 'biggest items are named');
  const btn = page.locator('#storageClearOld');
  await btn.click();
  assert.match(await page.textContent('#storageClearOld'), /Tap again/);
  assert.ok(await page.evaluate(() => localStorage.getItem('trr4_books') !== null), 'one tap clears nothing');
  await page.click('#storageClearOld');
  await page.locator('.toast', { hasText: 'Freed' }).first().waitFor();
  const left = await page.evaluate(() => ({ old4: localStorage.getItem('trr4_books'), old: localStorage.getItem('trr_covers'),
    other: localStorage.getItem('howlers_v3_data')?.length, books: JSON.parse(localStorage.getItem('trr_v1_books')).length }));
  assert.equal(left.old4, null);
  assert.equal(left.old, null);
  assert.equal(left.other, 80000, 'another app\'s data is never touched');
  assert.equal(left.books, 1, 'the current library is untouched');
  assert.equal(await page.locator('#storageClearOld').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with nothing old to clear, no button — and a full phone points at the other apps', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Dune', 'Frank Herbert');
  await page.evaluate(() => { localStorage.setItem('family_photos', 'p'.repeat(4300000)); showView('settings'); });
  assert.equal(await page.locator('#storageClearOld').count(), 0);
  assert.match(await page.textContent('#storageCard'), /Most of this space is used by your other apps/);
  await ctx.close();
});

test('clearing old copies saves what was stuck in memory while storage was full', async () => {
  const { ctx, page } = await openApp(browser, base);
  await addBook(page, 'Dune', 'Frank Herbert');
  await page.evaluate(() => {
    localStorage.setItem('trr3_books', '[]');
    // A sync merged a book in while storage was full: it's in memory only.
    books.push({ id: 'mem', title: 'Only In Memory', author: 'A', status: 'unread', addedAt: 2, updatedAt: 2 });
    showView('settings');
  });
  await page.click('#storageClearOld'); await page.click('#storageClearOld');
  await page.locator('.toast', { hasText: 'saved on this phone again' }).first().waitFor();
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('trr_v1_books')).some(b => b.id === 'mem')));
  await ctx.close();
});

// ── Help in the sentence test ────────────────────────────────────────────

const coquettish = { word: 'coquettish', definition: 'Flirtatious and playfully teasing.', pos: 'adjective', box: 3, reviews: 3,
  syll: 'co·quet·tish', pron: 'kō-ˈke-tish', sentence: 'David fluttered his lashes in a boozy, coquettish way.' };

test('hints build up — shape, sound, then half the letters — without giving away the syllables', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.evaluate(() => { window.__said = []; speakWord = (w) => window.__said.push(w); });
  await seedVocab(page, [coquettish]);
  await page.evaluate(() => startVocabQuiz());
  assert.equal(await page.locator('#vqHints .vq-tile').count(), 0, 'no hints until asked');
  await page.click('#vqHint');
  assert.equal(await page.locator('#vqHints .vq-tile').count(), 10);
  assert.equal(await page.locator('#vqHints .vq-tile.shown').count(), 1);
  assert.equal(await page.locator('#vqHints .vq-tile.shown').textContent(), 'c');
  assert.match(await page.textContent('#vqHints'), /10 letters · 3 syllables/);
  assert.doesNotMatch(await page.textContent('#vqHints'), /co·quet·tish/, 'the syllables would spell it out');
  await page.click('#vqHint');
  assert.match(await page.textContent('#vqHints'), /kō-ˈke-tish/);
  assert.deepEqual(await page.evaluate(() => window.__said), ['coquettish'], 'the second hint says it aloud');
  await page.click('#vqHint');
  assert.equal(await page.locator('#vqHints .vq-tile.shown').count(), 5);
  assert.ok(await page.locator('#vqHint').isDisabled());
  await page.fill('#vqAnswer', 'coquettish');
  await page.press('#vqAnswer', 'Enter');
  assert.match(await page.textContent('.vq-feedback'), /Right — with a little help/);
  const w = (await storedVocab(page))[0];
  assert.equal(w.box, 3, 'helped: held in place, not moved up');
  assert.equal(w.lapses || 0, 0, 'and not counted as a miss');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a near-miss spelling gets one more try, and the breakdown shows the slip', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedVocab(page, [coquettish]);
  await page.evaluate(() => startVocabQuiz());
  await page.fill('#vqAnswer', 'coquetish');
  await page.press('#vqAnswer', 'Enter');
  assert.match(await page.textContent('#vqNearMiss'), /So close — check the spelling/);
  assert.ok(!(await page.locator('#vqAnswer').isDisabled()), 'still answerable');
  await page.fill('#vqAnswer', 'coquettish');
  await page.press('#vqAnswer', 'Enter');
  assert.match(await page.textContent('.vq-feedback'), /Right on the second try/);
  assert.equal((await storedVocab(page))[0].box, 3);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a wrong word gets no second try, and the spelling shows the letters it missed', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedVocab(page, [coquettish]);
  await page.evaluate(() => startVocabQuiz());
  await page.fill('#vqAnswer', 'croquette');
  await page.press('#vqAnswer', 'Enter');
  assert.match(await page.textContent('.vq-feedback'), /The word was “coquettish”/);
  assert.equal(await page.locator('#vqSpell b.miss').allTextContents().then(a => a.join('')), 'ish');
  assert.match(await page.textContent('#vqSpell'), /you typed “croquette”/);
  assert.equal((await storedVocab(page))[0].box, 0, 'wrong is still wrong');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ── Reception, sources and web search ────────────────────────────────────

// Claude answers through a scripted list of {status, body} responses; each
// request body is recorded so tests can see what was asked.
async function stubClaudeScript(page, script) {
  await page.evaluate(script => {
    window.__reqs = []; window.__script = script;
    window.fetch = async (url, opts) => {
      window.__reqs.push(JSON.parse(opts.body));
      const r = window.__script.shift();
      return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, script);
}
const textReply = (text, extra = {}) => ({ body: { content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra } });

test('the Summary shows reception & critique and the sources Claude cited', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await seedFinished(page);
  const map = { ...JSON.parse(MAP_REPLY), summary: { ...SUMMARY,
    reception: { praised: ['Warm, funny, kind.'], criticized: ['Its premise echoes real history it never reckons with.'], debates: ['Is it too gentle?'], recognition: 'A long-running bestseller.' } } };
  const json = JSON.stringify(map), cut = json.indexOf('"line"');
  await stubClaudeScript(page, [{ body: { stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'review' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://example.org/r', title: 'Searched only' }] },
    { type: 'text', text: json.slice(0, cut) },
    { type: 'text', text: json.slice(cut, cut + 40), citations: [{ type: 'web_search_result_location', url: 'https://news.example.com/review', title: 'A Review' }] },
    { type: 'text', text: json.slice(cut + 40) }] } }]);
  await makeMap(page);
  await page.click('#mmSummaryBtn');
  const sheet = page.locator('#mmSheet');
  await sheet.locator('.sm-rec').waitFor();
  assert.match(await sheet.textContent(), /Praised for.*Warm, funny, kind\..*Criticized for.*never reckons with\..*Debated.*too gentle/s);
  assert.match(await sheet.textContent(), /A long-running bestseller/);
  const link = sheet.locator('.sm-src a');
  assert.equal(await link.count(), 1, 'cited pages win over pages merely searched');
  assert.equal(await link.getAttribute('href'), 'https://news.example.com/review');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.match(await sheet.locator('.sm-src').textContent(), /A Review · news\.example\.com/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('if web search isn\'t available on the account, the map is made without it', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaudeScript(page, [{ status: 400, body: { error: { message: 'web_search is not enabled for this organization' } } }, textReply(MAP_REPLY)]);
  await makeMap(page);
  const reqs = await page.evaluate(() => window.__reqs);
  assert.equal(reqs.length, 2);
  assert.ok(reqs[0].tools, 'first try offers search');
  assert.equal(reqs[1].tools, undefined, 'second try goes without');
  await ctx.close();
});

test('a search that pauses is resumed, and the reply is read from every turn', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  const half = Math.floor(MAP_REPLY.length / 2);
  await stubClaudeScript(page, [
    { body: { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }, { type: 'text', text: MAP_REPLY.slice(0, half) }] } },
    textReply(MAP_REPLY.slice(half))]);
  await makeMap(page);
  const reqs = await page.evaluate(() => window.__reqs);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].messages.length, 2, 'the paused turn is sent back');
  assert.equal(reqs[1].messages[1].role, 'assistant');
  assert.equal(await page.locator('#mmMap .mm-node').count(), 18);
  await ctx.close();
});

test('a summary written for an older map asks for reception and can search', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedFinished(page);
  await stubClaudeScript(page, [textReply(MAP_REPLY), textReply(JSON.stringify({ line: 'x', reception: { praised: ['p'] } }))]);
  await makeMap(page);
  await page.click('#mmSummaryBtn');
  await page.click('#mmSumCreate');
  await page.locator('#mmSheet .sm-rec').waitFor();
  const req = (await page.evaluate(() => window.__reqs))[1];
  assert.match(req.messages[0].content, /"reception":/);
  assert.equal(req.tools?.[0]?.name, 'web_search');
  await ctx.close();
});
