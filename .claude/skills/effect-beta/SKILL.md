---
name: "effect-beta"
description: "Manage react-effect's Effect 4 beta dependency: bump the single pinned version in package.json, verify claims against the installed effect dist, fix breakage from a bump. Use for any effect version bump, or upstream beta breakage question."
---

# /effect-beta: Effect 4 beta management

react-effect builds against the Effect 4 beta line. This skill is the operating manual for that dependency.

## The facts (verify, don't assume)

- Effect 4 is published on npm as **`effect` under the `beta` dist-tag**. There is **no `effect-smol` package**: that's only the GitHub repo name (now archived; development moved back to the main Effect repo). `npm view effect dist-tags` shows `latest` (3.x) vs `beta` (4.0.0-beta.N).
- Effect 4 betas ship **breaking changes between betas** (module renames, signature changes). Never assume adjacent betas are compatible.
- The source of truth for any API question is the **installed package**: `node_modules/.pnpm/effect@<version>/node_modules/effect/dist/*.d.ts` (and `.js` for implementation details). **Never** trust prior knowledge of Effect 3 or a stale memory of an earlier beta: grep the dts for the export before writing any claim about it into code.

## The version model

react-effect is a single package, not a monorepo — there is exactly **one** place the version lives: `dependencies.effect` in the root `package.json`. No catalog, no peer-dependency ranges, no doc tokens naming the pinned version to keep in sync. Bumping is a one-line edit.

If this repo ever grows a second place naming the pinned version (a README callout, a docs page), that's the point at which a small rewrite script (see weft's `scripts/bump-effect-beta.mjs` for the pattern, if this project ever imports that convention) becomes worth building. Not needed today.

## Procedure

### Manual bump

```bash
npm view effect dist-tags   # confirm the current `beta` tag
```

1. Edit `dependencies.effect` in `package.json` to the new `4.0.0-beta.N`.
2. `vp install`
3. `vp check && vp test` (and `vp test --config vitest.browser.config.ts` if that config exists by then, and `vp exec tstyche` if `tstyche` is installed).
4. Branch + PR as usual (never push `main`).

### A bump broke something

The new beta changed an upstream API. On the bump branch:

1. Read the failing output; identify the changed API. Confirm the change **against the newly installed dist** (`node_modules/.pnpm/effect@<new>/...`). Find the renamed/moved export or changed signature there.
2. Apply the migration in `src/lib/tea.ts`, `src/examples/*.tsx`, or wherever the change lands. Loop `vp check --fix` → `vp check` → `vp test` (same loop as `/implement`) until green.
3. Sweep prose for the change: grep the old API name across `src/`, `README.md`, and any `*.specs.md` files, and update those too.
4. Commit onto the bump branch (`fix:` since it ships with the bump), open the PR.

If the breakage is too large to absorb now, note it (an issue, or a comment on the attempted bump) and defer.

## Invariants

- Docs and code claims about Effect APIs are verified against the installed dist of the pinned beta: the pin is what makes "verified" meaningful.
- Version-specific statements outside `package.json` must be either timeless ("tracks the Effect 4 beta line") or explicitly marked historical, never a live claim naming a specific beta that isn't the current pin.

## When Effect 4.0 stable lands

Bump `dependencies.effect` to `4.0.0` (or `^4.0.0`) directly; retire this skill's beta-specific guidance (the dist-tag check, the "betas break between betas" warning).
