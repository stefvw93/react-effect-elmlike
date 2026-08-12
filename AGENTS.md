## TDD Workflow

Every feature follows this 8-step cycle. Each step is a project skill (detail lives in `.claude/skills/<name>/SKILL.md`):

`/spec → /mock → /type-tests → /unit-test → /implement → /e2e → /review-step → /document`

1. `/spec`: interactive Q&A (one question at a time), then co-located `specs.md` (Overview & Purpose + Acceptance Criteria required). User approves before moving on.
2. `/mock`: `declare`-based full API surface in the real source file (`src/lib/*.ts` or `src/examples/*.tsx`), JSDoc included. Refuses to run without `specs.md`.
3. `/type-tests`: TSTyche tests at `src/**/__type-tests__/*.tst.ts` (`expect().type` matchers) run via `vp exec tstyche`, or explicit `type-tests: not applicable, <reason>` recorded in `specs.md`.
4. `/unit-test`: co-located `*.test.ts` covering every acceptance criterion, happy + error paths (full Effect error union), edge cases. **Red phase:** new tests must fail against the mocks before implementation.
5. `/implement`: replace mocks in-place with signature parity, loop `vp check --fix` → `vp check` → `vp test` until green.
6. `/e2e`: `*.browser.test.tsx` via `vp test --config vitest.browser.config.ts`. Mandatory for every touched `src/examples/*.tsx` demo; conditional for `src/lib` features (explicit skip recorded otherwise, e.g. pure reducer logic that jsdom/type-level tests already cover).
7. `/review-step`: code-review pass (medium effort; high when `src/lib` is touched) plus spec-conformance check; every finding fixed or explicitly rejected with reason; loop until clean. **Hard gate: no commit until clean.**
8. `/document`: JSDoc sync, `specs.md` sync, root `README.md` sync only if `src/lib`'s public surface changed — done directly by the main thread, no docs-authoring subagent. **Hard gate: no commit until complete.** Then branch + PR, never push `main`.

Invariants:

- Strict cycle: no phase skips; a step skipped as not-applicable must be recorded in `specs.md` with a reason.
- Pause rule: if any step reveals the spec or mock surface is wrong, stop, update spec + mocks (and affected tests) first, then resume.
- Single package, no monorepo `pack` step: bare `vp check` / `vp test` are always correct here — no `vp run <task>` indirection to reach for.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
