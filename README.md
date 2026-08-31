# 📚 The Reading Room

A personal book tracking app — scan, catalog, and follow your reading life.

**Live app:** [ortizzle.github.io/my-library](https://ortizzle.github.io/my-library)

---

## What it does

The Reading Room is a single-page web app for managing your personal library. Track every book you own, are reading, or want to read — with cover art, progress logging, physical location in your home, and reading streaks.

Install it as an app on your phone or desktop (Chrome / Android) and it works fully offline.

---

## Features

### Library
- Book cards with cover art pulled from OpenLibrary, falling back to Google Books
- Status tracking: **Unread · Reading · Read · DNF · Wishlist**
- Filter by status, format, genre, room, or list
- Search your library by title or author

### Adding Books
- **Scan a barcode** — point your camera at any ISBN
- **Search by title** — pull from OpenLibrary and auto-fill details
- Lookups fall back to **Google Books** when OpenLibrary doesn't have the book — its coverage of recent releases (and 979-prefix ISBNs) is patchy
- **Enter manually** — for anything not in the database
- Auto-fills title, author, page count, cover image, and ISBN
- Ownership type defaults: Physical → Hardcover, eBook → Kindle, Audiobook → Audible

### Reading Tracker
- Log today's reading by page number, audiobook % finished, or a one-tap "listened today"
- **Reading streaks** tracked daily — shown in the header, with a last-7-days
  strip and a browsable month calendar on the Stats page
- Progress history per book with timestamps
- Inline warning if you enter a page number beyond the book's total
- Undo toast (5 seconds) if you accidentally log a session or mark a book finished

### Book Details (3-tab edit modal)
1. **Book Details** — title, author, genre, format, ISBN, cover, series, publisher
2. **My Reading** — status, rating (⭐ 1–5), dates, journal notes, loan tracking, DNF shelf, reading progress history
3. **Location** — room and shelf where the book lives in your home; loan status

### Lists & Favorites
- **Favorites** — automatically includes any 5-star book; also taggable manually
- **To Be Read, DNF Shelf, Articles, Loaned Out** — curated lists
- **Wishlist** — its own page (open it from the Lists tab) for books you want but don't own yet
- DNF tag and DNF status stay in sync — set one and the other updates automatically

### Physical Location Tracking
- Record which **room** and **shelf** a book lives on
- Room names autocomplete from your existing entries
- Location shown as a 📍 pin on each book card
- Filter the library by room to find books fast

### Stats & More
- Reading stats, charts, and the Reading Year month-by-month view with goal pace
- Keepsake / print view (from the Stats page)
- GitHub Gist sync — pull or push your data to stay in sync across devices
- Five top-level tabs (Today · My Library · Lists · Journal · Stats); Wishlist and
  Loaned Out open from their cards in Lists. The Back button moves between views.

---

## Data & Privacy

All data lives in your browser's **localStorage** — nothing is sent to any server. Gist sync is optional; if configured, your data is stored in a **private GitHub Gist** under your own account.

### How sync resolves conflicts

Sync **merges** rather than overwrites. Each device's changes are combined record by record:

- **Books** — the most recently edited version of each book wins.
- **Deletions** — recorded as tombstones so a deleted book can't come back from another device. Tombstones are forgotten after 60 days.
- **Reading history, journal entries and streak days** — always combined, never replaced. Nothing you've logged on one device is dropped because another device synced later.

A push fetches and merges the remote copy before writing, and retries with backoff if it fails, so edits made offline aren't lost when you come back online.

Importing a backup goes through the same merge — restoring an old export adds what's missing without overwriting anything newer.

---

## Tech

- Single HTML file — no build step, no dependencies to install
- Vanilla JavaScript and CSS
- Barcode scanning via [ZXing](https://github.com/zxing-js/library)
- Book data from [OpenLibrary API](https://openlibrary.org/developers), with [Google Books](https://developers.google.com/books) as a fallback (no API key needed)
- Cover images from [OpenLibrary Covers](https://covers.openlibrary.org) and Google Books thumbnails
- PWA: `manifest.json` + service worker for offline support and installability

---

## Install as an App

**Android (Chrome):** three-dot menu → *Add to Home Screen*

**Mac/Desktop (Chrome):** address bar install icon (⊕) → *Install*

Once installed it launches standalone, works offline, and feels like a native app.

---

## Local Development

No build step needed. Open `index.html` directly in a browser, or serve it with any static file server:

```bash
npx serve .
```

### Tests

The app ships as a single dependency-free HTML file. The `package.json` and
`node_modules` are for the test suite only — they aren't served to the browser
and aren't needed to deploy.

```bash
npm install     # once
npm test        # merge + stats unit tests, plus a Chromium smoke test
npm run test:unit    # fast — no browser needed
```

`tests/merge.test.mjs` covers the sync merge (each case is a bug that actually
shipped), `tests/stats.test.mjs` the daily page/minute rollup,
`tests/lookup.test.mjs` the OpenLibrary/Google Books record normalisation, and
`tests/smoke.test.mjs` drives the real app in Chromium with both catalogues
stubbed at the network layer. Tests run in CI on every
push via `.github/workflows/test.yml`.

Target device is a **Google Pixel (Android / Chrome)** — see `CLAUDE.md`.

---

*Built for personal use by the Ortiz family.*
