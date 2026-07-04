---
name: verify
description: Build/launch/drive recipe for verifying changes to The Reading Room (static single-file PWA).
---

# Verifying The Reading Room

Static app — no build step. Surface is the browser.

## Launch

```bash
python3 -m http.server 8123 --bind 127.0.0.1 &   # serve repo root
```

Drive with Playwright against `http://127.0.0.1:8123/index.html` using the
pre-installed browser: `chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })`.

## Flows worth driving

- **Add book:** Library tab → "＋ Add Book" → fill `#bTitle`/`#bAuthor` → Save.
  Card appears in `#booksGrid`; data lands in `localStorage.trr_v1_books`.
- **Progress logging:** edit modal → "My Reading" tab → status `reading` →
  `#progCurPage`/`#progTotalPage`; entries land in `localStorage.trr_v1_prog`.
  Inline panel: card → "📖 Progress" → `#lp-page-<bookId>` → 💾 Save.
- **Service worker:** load → wait ~2s → reload (now controlled) →
  `ctx.setOffline(true)` → reload should still render. Page is network-first,
  so editing index.html on disk and reloading online must show the new content.
- **Confirm dialogs:** the app uses native `confirm()`/`prompt()` — attach
  `page.on('dialog', d => d.accept())`.

## Environment gotchas

- Sandbox blocks external hosts (unpkg, Google Fonts, OpenLibrary, GitHub API):
  fonts fall back to serif, ZXing lazy-load fails (its error path shows in
  `#scannerStatus`), and Gist sync can't be exercised live. To test the scanner's
  post-load path, stub `window.ZXing` before clicking the FAB.
- SW install requires the local SHELL files only; external extras are
  best-effort by design — don't "fix" a failed external cache add.
