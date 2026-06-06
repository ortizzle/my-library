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
- Book cards with cover art pulled from OpenLibrary
- Status tracking: **Unread · Reading · Read · DNF · Wishlist**
- Filter by status, format, genre, room, or list
- Search your library by title or author

### Adding Books
- **Scan a barcode** — point your camera at any ISBN
- **Search by title** — pull from OpenLibrary and auto-fill details
- **Enter manually** — for anything not in the database
- Auto-fills title, author, page count, cover image, and ISBN
- Ownership type defaults: Physical → Hardcover, eBook → Kindle, Audiobook → Audible

### Reading Tracker
- Log today's reading by pages or minutes listened
- **Reading streaks** tracked daily — shown in the header
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
- **Wishlist** — separate tab and list section for books you want but don't own yet
- DNF tag and DNF status stay in sync — set one and the other updates automatically

### Physical Location Tracking
- Record which **room** and **shelf** a book lives on
- Room names autocomplete from your existing entries
- Location shown as a 📍 pin on each book card
- Filter the library by room to find books fast

### Stats & More
- Reading stats and charts
- Keepsake / print view
- GitHub Gist sync — pull or push your data to stay in sync across devices

---

## Data & Privacy

All data lives in your browser's **localStorage** — nothing is sent to any server. Gist sync is optional; if configured, your data is stored in a **private GitHub Gist** under your own account.

---

## Tech

- Single HTML file — no build step, no dependencies to install
- Vanilla JavaScript and CSS
- Barcode scanning via [ZXing](https://github.com/zxing-js/library)
- Book data from [OpenLibrary API](https://openlibrary.org/developers)
- Cover images from [OpenLibrary Covers](https://covers.openlibrary.org)
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

---

*Built for personal use by the Ortiz family.*
