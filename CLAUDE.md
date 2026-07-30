# The Reading Room — working notes

Single-file PWA. `index.html` holds all markup, CSS and JS; `sw.js` is the service
worker; there is no build step. Follow the `family-app-standards` skill.

## Target device

**Chris uses a Google Pixel — Android, Chrome.** Not an iPhone. Audit and test
against Android Chrome at 412px. Material minimum tap target is 48px. iOS-specific
concerns (Safari's sub-16px input auto-zoom, `apple-touch-icon`, `-webkit-fill-available`
viewport hacks) do not apply here.

## Verifying changes

See `.claude/skills/verify/SKILL.md` for the launch + Playwright recipe.

## Storage layout

All keys are namespaced `trr_v1_*` (see the `SK` map in `index.html`). Note that the
three Gist keys — `trr_v1_gist_token`, `trr_v1_gist_id`, `trr_v1_gist_sync` — are
declared separately and are deliberately **not** in `SK`, because `SK` is what gets
exported and cleared. Anything that iterates `SK` to reset state must decide
explicitly whether the Gist keys should go too.
