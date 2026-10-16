# The Reading Room — working notes

Single-file PWA. `index.html` holds all markup, CSS and JS; `sw.js` is the service
worker; there is no build step. Follow the `family-app-standards` skill.

## Target device

**Chris uses a Google Pixel 8 Pro — Android, Chrome.** Not an iPhone. Audit and
test against Android Chrome at 412px. iOS-specific concerns (Safari's sub-16px
input auto-zoom, `apple-touch-icon`, `-webkit-fill-available` viewport hacks) do
not apply here.

Tap targets in this app work well on his device — confirmed. Don't flag control
sizes as defects or propose a resize pass. 48px is a default for new controls,
not a reason to touch what ships.

## Installing on the phone (solved, Oct 2026)

Installing on Chris's Pixel failed with "Could not open app" until he cleared
Chrome's cache and cookies; then it installed. App-side was fine throughout
(no installability errors; PNG icons 192/512 + maskable; `tests/manifest.test.mjs`).
If it recurs, that's the fix to suggest first — but warn that clearing cookies
also clears site data (the library lives in localStorage): reconnect Gist sync
in Settings to pull it back, and re-enter the Anthropic / Google Books keys.
Don't change the manifest `id` without reason; it is the app's identity.

## Verifying changes

See `.claude/skills/verify/SKILL.md` for the launch + Playwright recipe.

## Storage layout

All keys are namespaced `trr_v1_*` (see the `SK` map in `index.html`). Note that the
three Gist keys — `trr_v1_gist_token`, `trr_v1_gist_id`, `trr_v1_gist_sync` — are
declared separately and are deliberately **not** in `SK`, because `SK` is what gets
exported and cleared. Anything that iterates `SK` to reset state must decide
explicitly whether the Gist keys should go too.

## Deploying

`main` deploys through `.github/workflows/test.yml`: the `deploy` job needs
`test`, so nothing ships unless every test passes. Pages source must be
"GitHub Actions". The published files come from the `SHELL` list in `sw.js` —
add any new local asset there, or it won't be deployed (the workflow checks
manifest icons and fails loudly if one is missing).

Before asking to merge, confirm the branch's CI run is green, not just local
tests.

**Standing approval (Chris, Oct 2026): "Merge and deploy always."** Once a
change is done and the branch's CI run is green, merge to `main` and deploy
without asking, then confirm the `main` run and the Pages deployment
succeeded. Still send screenshots of visual changes, and still ask before
anything destructive or outside the app (deleting data, changing the Gist,
repo settings).

**Other sessions push to `main` too** (e.g. the Google Drive copy,
`ortiz-drive.js`, came from another session). Merge with a fast-forward only;
if it refuses, `git merge origin/main` into the branch, run the tests, and
deploy that — never force-push or overwrite `main`.
