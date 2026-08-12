---
name: "e2e"
description: "Step 6 of the react-effect TDD workflow. Use after /implement is green: writes *.browser.test.tsx real-browser tests (Vitest browser mode via vp test --config vitest.browser.config.ts), installing the browser provider on first use. Mandatory for every touched src/examples/*.tsx demo; for src/lib features only when behavior is browser-observable, otherwise records an explicit skip in specs.md."
---

# /e2e: Real-browser tests (TDD step 6)

Assert the feature's behavior in a real Chromium browser, or record an explicit, reasoned skip.

## When to run

- **Previous step:** `/implement` (`vp check` and `vp test` green).
- **Next step:** `/review-step`.
- **Gate:** every touched `src/examples/*.tsx` file has a passing co-located `*.browser.test.tsx`; `src/lib` features either have browser coverage or an explicit `e2e: not applicable, <reason>` line in `specs.md`. Silent skips are forbidden.

## Scope rule

- **`src/examples/*.tsx` touched or created → mandatory.** Every touched demo file gets at least one co-located `*.browser.test.tsx` that mounts its exported feature in a real browser and asserts its headline behavior.
- **`src/lib` feature → conditional.** Required when behavior is browser-observable and jsdom cannot faithfully reproduce it: DOM rendering, hydration against a real parser, real event dispatch, layout. Pure type-level or reducer-level logic (most of `Blueprint.reduce`/`Blueprint.run`, which are pure and framework-free) skips with a recorded reason in `specs.md`:

  ```markdown
  e2e: not applicable, <one-line reason>
  ```

## Procedure

1. **Decide scope** per the rule above; record the skip in `specs.md` if not applicable, report it, and hand off.

2. **First-time setup, if `@vitest/browser-playwright` isn't installed yet:**
   - `vp install -D @vitest/browser-playwright playwright`
   - `vp exec playwright install chromium` (fetches the browser binary)
   - Add a `vitest.browser.config.ts` at the repo root: a Vitest config with `test.browser` enabled, `provider: "playwright"`, `instances: [{ browser: "chromium" }]`, and a glob for `*.browser.test.{ts,tsx}` — excluded from the default `vp test` run the same way it's included here.

   This repo has no `pack` step, so no custom `run.tasks` entry is needed: `vp test --config vitest.browser.config.ts` is the whole invocation.

3. **Write the test file:** `*.browser.test.tsx`, co-located next to the feature it tests.
   - Import test globals from `"vitest"` directly (this repo has no `vite-plus/test` re-export — use `vitest`'s own `test`/`expect`/`vi`).
   - For a demo, import the exported component (e.g. `Counter`, `Cart` from `src/examples/app.tsx`, or the raw `counter`/`cart` blueprint) and mount it into its own container, with no dev server dependency.
   - Browser files are excluded from the default `vp test` and picked up only by `vp test --config vitest.browser.config.ts`.

4. **Known pitfalls** (each has bitten before, see `src/lib/tea.ts`):
   - **Post-mount render tick:** the mounted tree is appended a tick _after_ `mount`'s Effect resolves. Assert initial state with `vi.waitFor`, never synchronously.
   - **Ref observers:** to run an effect when a `ref`'s element mounts, fork the `ref.changes` observer with `Effect.forkScoped`, not bare `Effect.forkChild`. A bare fork binds to the transient component-body fiber and is interrupted under an isolated mount.
   - **Missing example CSS:** the browser test page has none of `index.html`'s CSS. Do not assert layout-derived pixel values.

5. **Run:** `vp test --config vitest.browser.config.ts`. Must be green.

6. **Hand off.** Next step is `/review-step`.

## Rules

- Browser tests assert user-observable behavior, not implementation internals.
- A failing browser test that exposes a spec/mock problem triggers the pause rule: back up the cycle, don't patch around it.
