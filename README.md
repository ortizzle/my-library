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

### Highlights
- **📷 Add Highlight** in a book's Reading Journal — photograph a page (or choose a photo), drag across the passage, and the app reads it for you
- **Shortcut:** the floating **＋** offers *Add a book* or *Add a highlight*. Highlight lists the books you're reading (the rest are a tap away) and goes straight to the camera
- The marked region is sent to Claude to transcribe; you check and correct it, add a page number and a note, and save
- Saved as **text** in the journal, so highlights sync, export, print and delete like any journal entry. Photos aren't kept — a phone photo is several MB and wouldn't fit in browser storage or the sync file
- Shown in the book, the library card, the Journal tab, and a **✦ Highlights** section of the Keepsake
- Works without an Anthropic key too — the photo stays on screen while you type the passage

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

### Backing up to Google Drive

**Settings → Export JSON** opens Android's share sheet with a dated backup (`reading-room-backup-YYYY-MM-DD.json`). Choose **Drive** and it asks which account and folder to save to. Where sharing files isn't supported — most desktops — it downloads instead.

---

## Tech

- Single HTML file — no build step, no dependencies to install
- Vanilla JavaScript and CSS
- Barcode scanning via [ZXing](https://github.com/zxing-js/library)
- Book data from [OpenLibrary API](https://openlibrary.org/developers), with [Google Books](https://developers.google.com/books) as a fallback. Works without a key, but Google's free quota is per-IP and shared — on mobile data it runs out constantly. Add a free Google Books API key in Settings for your own quota.
- Cover images from [OpenLibrary Covers](https://covers.openlibrary.org), Google Books thumbnails, and Amazon keyed on the ISBN-10 derived from a 978 ISBN-13 (no API or key)
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

### Deploying

Pushing to `main` deploys — but only after every test passes. The workflow's
`deploy` job depends on the `test` job, so a failing test stops the release and
the live site stays as it was. Only the app is published (`index.html`,
`sw.js`, `manifest.json` and the icons), taken from the service worker's
offline shell list; tests and notes are not.

This needs **Settings → Pages → Source: GitHub Actions**. To republish without
a new commit, run the workflow from the Actions tab.

Target device is a **Google Pixel (Android / Chrome)** — see `CLAUDE.md`.

---

*Built for personal use by the Ortiz family.*
