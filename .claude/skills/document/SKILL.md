---
name: "document"
description: "Step 8 of the react-effect TDD workflow. Use after /review-step is clean: JSDoc sync on everything touched, specs.md sync, and a root README.md sync when src/lib's public surface changed. Written directly by the main thread, no docs-authoring subagent. Hard gate: no commit until docs are complete, then branch + PR (never push main)."
---

# /document: Documentation sweep (TDD step 8)

Bring all documentation touched by the change up to date. Commits are blocked until this step completes.

## When to run

- **Previous step:** `/review-step` (review clean).
- **Next step:** none (the workflow ends here with branch + PR).
- **Gate (exit):** full sweep complete and final `vp check` green. **No commit until then.** Then branch + PR; never push to `main`.

## Scope: everything touched by the change

This repo has no `docs/` directory, no per-package READMEs, and no docs-authoring subagent — scope is narrower than a docs framework: keep the source's own JSDoc and `specs.md` honest, and touch `README.md` only when the library's public surface moved.

1. **JSDoc** on all new/changed exported functions, types, and values (created in `/mock`; verify present and accurate now). Self-evident exports get exactly one line; doc blocks stay proportionate — this repo's existing style in `src/lib/tea.ts` runs longer than typical JSDoc when a decision has real rationale behind it (see `Vocabulary`, `OwnershipRule`), so match that bar: substance, not padding. No `@example` unless usage isn't inferable from the signature/name; no em-dashes. Omit `@type` annotations; describe non-obvious parameters; annotate Effect Schemas when not self-explanatory.
2. **`specs.md` sync**: the spec must reflect final behavior. If implementation legitimately changed details (via the pause rule), the spec already says so; verify. Acceptance criteria, skip records (`type-tests: not applicable`, `e2e: not applicable`), and edge cases must match reality.
3. **Root `README.md`**: update only when `src/lib/index.ts`'s exported surface changed in a way a reader of the README would notice (new/removed/renamed top-level export, changed usage shape). Most `src/examples/*.tsx` changes don't require a README touch — they're demo files in one app, not standalone installable packages, and don't carry their own readmes.

## Procedure

1. Inventory the diff: list changed exports and whether `src/lib`'s public surface moved.
2. Verify/complete JSDoc; sync `specs.md`.
3. Update `README.md` if step 1 found a public-surface change; otherwise skip it explicitly (no README churn for internal-only or examples-only diffs).
4. Run `vp check`: formats and lints the JSDoc and markdown. Must be green.
5. Create a branch, commit, open a PR. **Never push to `main`.**

## Rules

- Documentation is a hard gate: a feature without its docs sweep is not committable.
- Docs must match the source: every claim verifiable, code samples follow the repo's formatting (tabs, double quotes — `vp check --fix` enforces this) and Effect idioms, no `<Component/>`-style JSX in a doc-comment sample.
