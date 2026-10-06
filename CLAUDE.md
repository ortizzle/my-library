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
