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

test('the + offers a book or a highlight', async () => {
  const { ctx, page, errors } = await openApp(browser, base);
  await page.click('#fab');
  assert.equal(await page.isVisible('#addSheet'), true);
  assert.equal(await page.isVisible('#addSheetBook'), true);
  assert.equal(await page.isVisible('#addSheetHl'), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('"Add a book" still goes to the scanner', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.evaluate(() => { window.loadZXing = () => new Promise(() => {}); }); // no CDN here
  await page.click('#fab');
  await page.click('#addSheetBook');
  assert.equal(await page.isVisible('#addSheet'), false);
  assert.equal(await page.isVisible('#scannerModal'), true);
  await ctx.close();
});

test('"Add a highlight" lists the books being read, the rest one tap away', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelf(page, [
    { id: 'r1', title: 'Piranesi', status: 'reading' },
    { id: 'r2', title: 'Dune', status: 'reading' },
    { id: 'd1', title: 'Middlemarch', status: 'read', date: '2026-09-01' },
    { id: 'w1', title: 'Wanted', status: 'wishlist' },
  ]);
  await page.click('#fab');
  await page.click('#addSheetHl');

  const visibleTitles = () => page.$$eval('#addSheet .sheet-book', els =>
    els.filter(e => e.offsetParent !== null).map(e => e.querySelector('b').textContent));
  assert.deepEqual(await visibleTitles(), ['Piranesi', 'Dune'], 'currently reading only, at first');

  await page.click('#addSheetMoreBtn');
  assert.deepEqual(await visibleTitles(), ['Piranesi', 'Dune', 'Middlemarch'],
    'then the rest — never wishlist, which you don\'t own yet');
  await ctx.close();
});

test('choosing a book goes straight to the camera for that book', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelf(page, [{ id: 'r1', title: 'Piranesi', author: 'Susanna Clarke', status: 'reading' }]);
  await page.click('#fab');
  await page.click('#addSheetHl');

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#addSheetReading .sheet-book'),
  ]);
  assert.equal(await chooser.element().getAttribute('id'), 'hlCamera', 'the camera, not the gallery');
  assert.equal(await page.isVisible('#addSheet'), false);
  assert.equal(await page.isVisible('#hlModal'), true);
  assert.match(await page.textContent('#hlBook'), /Piranesi · Susanna Clarke/, 'for the book that was picked');

  // And the rest of the flow works from here.
  await chooser.setFiles({ name: 'page.png', mimeType: 'image/png', buffer: await page.screenshot() });
  await page.waitForFunction(() => document.getElementById('hlMark').style.display === 'block');
  await page.click('#hlRead');
  await page.fill('#hlText', 'There is no knowledge that is not valuable.');
  await page.click('#hlSave');
  const j = await page.evaluate(() => journalDB.r1);
  assert.equal(j[0].type, 'highlight');
  await ctx.close();
});

test('with nothing marked as reading, the library is offered instead of a dead end', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelf(page, [{ id: 'd1', title: 'Middlemarch', status: 'read' }]);
  await page.click('#fab');
  await page.click('#addSheetHl');
  assert.match(await page.textContent('#addSheetReading'), /Nothing is marked Currently Reading/);
  assert.equal(await page.isVisible('#addSheetOther .sheet-book'), true);
  assert.equal(await page.isVisible('#addSheetMoreBtn'), false);
  await ctx.close();
});

test('with no books at all it says why', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.click('#fab');
  await page.click('#addSheetHl');
  assert.match(await page.textContent('#addSheetReading'), /Add a book first/);
  await ctx.close();
});

test('a title that looks like HTML is listed as text', async () => {
  const { ctx, page } = await openApp(browser, base);
  await seedShelf(page, [{ id: 'x', title: '<img src=x onerror="window.__pwned=1">', status: 'reading' }]);
  await page.click('#fab');
  await page.click('#addSheetHl');
  assert.equal(await page.locator('#addSheetReading .sheet-book-text img').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  await ctx.close();
});

test('a cover that fails to load shows the gradient placeholder, not a hole', async () => {
  const { ctx, page } = await openApp(browser, base);
  await page.route('**://covers.openlibrary.org/**', r => r.fulfill({ status: 404, body: '' }));
  await seedShelf(page, [{ id: 'r1', title: 'Piranesi', status: 'reading' }]);
  await page.evaluate(() => { coversDB.r1 = 'https://covers.openlibrary.org/b/id/1-M.jpg'; });
  await page.click('#fab');
  await page.click('#addSheetHl');
  await page.waitForFunction(() => document.querySelector('#addSheetReading .sheet-book-cover').tagName === 'SPAN');
  const bg = await page.$eval('#addSheetReading .sheet-book-cover', el => el.style.background);
  assert.match(bg, /linear-gradient/);
  await ctx.close();
});

test('the sheet closes with Cancel, a tap outside, or Escape', async () => {
  const { ctx, page } = await openApp(browser, base);
  for (const close of [
    () => page.click('#addSheetCancel'),
    () => page.mouse.click(10, 10),
    () => page.keyboard.press('Escape'),
  ]) {
    await page.click('#fab');
    await close();
    assert.equal(await page.isVisible('#addSheet'), false);
  }
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
