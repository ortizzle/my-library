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
- **One camera button:** the floating **＋** opens the camera. Point it at a book's barcode and the book is added (only ISBNs count, so other barcodes are ignored); point it at a page and tap **Capture page**. The photo is read, then choose **✦ Highlight**, **Aa Words**, or both — with the book you're reading preselected, or a quick choice if you're reading several. Underneath: *Type a passage*, *Add a word*, *From gallery* and *Find a book*. Barcodes use Chrome's built-in reader on Android; elsewhere the ZXing library
- The marked region is sent to Claude to transcribe; you check and correct it, add a page number and a note, and save
- Saved as **text** in the journal, so highlights sync, export, print and delete like any journal entry. Photos aren't kept — a phone photo is several MB and wouldn't fit in browser storage or the sync file
- Shown in the book, the library card, the Journal tab, and a **✦ Highlights** section of the Keepsake
- Works without an Anthropic key too — the photo stays on screen while you type the passage

### Vocabulary
- **Save words you meet while reading** — from the floating **＋** (*Add a word*), a book's Reading tab, or the **Aa Vocabulary** card in Lists
- Add the sentence you found it in and **Claude defines the word in the sense that book uses it**. Without an Anthropic key it falls back to the free dictionary at [dictionaryapi.dev](https://dictionaryapi.dev); you can always type or edit the definition
- **Reviews space themselves out** (Leitner boxes): right answers push a word's next review to 1, 3, 7, 14, 30, then 60 days; a miss brings it back tomorrow. Five right in a row and it's *mastered*
- **Three kinds of question**, getting harder as you learn a word: a flashcard, multiple choice (using your other words' definitions), then typing the word into the sentence it came from
- **Pick words instead of typing them:** tap **Aa Words** on any saved highlight, or *Pick words to learn* while capturing one, and tap a word in the passage. The sentence around it, the page and the book come along. Words already in your list are underlined
- **From a photo:** *📷 Pick it from a photo of the page* in the word editor uses the highlight camera — drag across the sentence, Claude reads it, tap the word. Optionally keep the passage as a highlight too
- A word picked as the book spells it ("ossified") is saved under its dictionary form ("ossify"), which Claude supplies with the definition
- **Pronunciation:** each word is written the way Merriam-Webster prints it — syllables and pronunciation, *lu·gu·bri·ous* \\lu̇-ˈgü-brē-əs\\ — from Claude with its definition. Without a key, the free dictionary's IPA is used. **🔊** says it — a real recording from the dictionary when there is one, otherwise the phone's own voice (free, works offline). In reviews it's shown with the word, except in the sentence test, where it appears only after you answer. Words saved earlier are filled in automatically when you open the Vocabulary page (with a key), or with one tap
- **Help in the sentence test:** **💡 Hint** gives up to three steps — the first letter with tiles for the rest (length and syllable count), then the pronunciation read aloud, then half the letters. A spelling a slip or two off gets **“So close — check the spelling”** and one more try. After a miss (or a helped answer) the word is shown with the letters you missed highlighted. Right with help holds the word at its step instead of moving it up — no penalty, it just comes round again sooner
- **Tap a word for its page:** the word large, with syllables, pronunciation and 🔊, the definition, the sentence you found it in, the book and page, and progress (five steps to mastered). **✎ Edit** is one more tap
- On **Today's Reading**: when words are due, a card shows how many and which, with **Review ›**. Once you're caught up it shows a **word of the day** from your own list Reviews don't count toward the reading streak
- Words sync, export and import like books; deleting one leaves a tombstone so it can't come back from another device

### Mind Maps
- **Made for every book you finish** — automatically, in the background: a pass over books you've already read, then a new map whenever you mark one read (one at a time; about 5–10¢ each on your Anthropic key). Turn it off in Settings, under the Anthropic key, which also shows how many have maps. A key or billing problem pauses it rather than retrying
- **🧠 Map** on the library card, or in the book's editor. Saved with the book and synced, so it opens instantly
- **Styled after the book:** a backdrop that fits its setting (sea, forest, city, night, gothic, desert, mountains, space, garden), colours from the cover, and an emblem at the centre
- **A one-line thesis**, then branches of bubbles — characters, themes, places (or for nonfiction, the big ideas and stories)
- **Tap a bubble to learn more:** a reminder, a deeper look, where it shows up, your own highlights that mention it, what it connects to, and a question to think about. ‹ › walk through the whole map; **Explored N of M** remembers what you've opened
- **🕰 Chronology:** the story beat by beat, each linked into the map. **↻ Remake** (two taps) writes a fresh one
- **📜 Summary:** the book in one line, the story start to finish, what it's really getting at (three or four big ideas), the ending explained — or the takeaways, for nonfiction — and context worth knowing. Maps made before summaries offer **Write the summary** (one small Claude request) instead of a remake. Syncing and importing keep the bubbles you've explored

### Finishing a book
- **🏁 Finished this book** on Today marks it read, then opens its editor at **My Reading** with the review box ready, so the final review gets written while the book is fresh

### Daily Deep Dive
- **One question a day on Today**, from a finished book's mind map, in a small card under the vocabulary card. Tap **Play ›** to open it
- **Who or what?** — a bubble's reminder with the name hidden; pick from three. Then the deeper look, a question to think about, and **Open in the map**
- **What came first?** — three moments from a book's chronology to tap in order (tap again to undo), then **See the chronology**
- **Sundays: Think about it** — a reflection question; **Save to journal** adds your answer to that book's journal
- Books you haven't seen lately and bubbles you haven't explored come first; answering marks the bubble explored in its map. The same question all day; **Not today** hides it until tomorrow. A small 🧠 streak counts days in a row, separate from the reading streak
- Made from the saved maps alone — no Claude call, works offline. Today's question and the streak stay on this device

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

### Storage on this phone
Chrome gives each web address about 5 MB, and every app at ortizzle.github.io shares it. **Settings → Storage on this phone** shows how much is used, by owner (this app, copies left by its older versions, the Drive copy, and each other app), and the biggest items. **Clear old Reading Room copies** (two taps) removes data earlier versions left behind under `trr_`…`trr4_` — the library moved to `trr_v1_*` long ago — then saves anything that was waiting in memory. Other apps' data is shown, never deleted from here.

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
`tests/lookup.test.mjs` the OpenLibrary/Google Books record normalisation,
`tests/vocab.test.mjs` the vocabulary schedule and quiz logic,
`tests/mindmap.test.mjs` mind-map parsing, merging and layout, and
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
