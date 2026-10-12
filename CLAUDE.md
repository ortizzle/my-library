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

## Installing on the phone (open issue, Oct 2026)

Installing as an app on Chris's Pixel fails with "Could not open app", even
after uninstalling, restarting, and a fresh manifest `id`; chrome://webapks
lists nothing. App-side checks all pass (Chrome reports no installability
errors, PNG icons 192/512 + maskable are published, `tests/manifest.test.mjs`).
He uses an **Add to Home screen → Create shortcut** for now. Next step if
revisited: see whether another ortizzle.github.io family app installs — if
none do, it's the phone's WebAPK/Play service, not this app. Don't change the
manifest `id` again without reason; it is the app's identity.

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
