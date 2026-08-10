---
name: "implement"
description: "Step 5 of the react-effect TDD workflow. Use after /unit-test's red phase: replaces the declare mocks with real code in-place, enforces signature parity with the mock surface, and loops vp check --fix → vp check → vp test until green."
---

# /implement: Implementation + green loop (TDD step 5)

Replace the `declare` mocks with real code, keeping the surface identical, until all checks and tests are green.

## When to run

- **Previous step:** `/unit-test` (tests exist and a red run is recorded).
- **Next step:** `/e2e`.
- **Gate (exit):** `vp check` and `vp test` both green, signature parity confirmed.

## Procedure

1. **Replace mocks in-place.** In the feature's source file (`src/lib/tea.ts` or another `src/lib/*.ts`, or the relevant `src/examples/*.tsx`), replace each `declare` statement with its real implementation. Same file, same exports, same signatures. Keep the JSDoc written in `/mock` (update prose only if behavior details demand it).

2. **Implementation standards:** Effect patterns throughout, tagged errors (the union declared in `/mock`), Services/Layers for shared capabilities (`Context.Service`, `Layer`), Schema at unknown/I-O boundaries, `pipe(effect, ...)` preferred, `Option` for optionality, `readonly` data, explicit type guards. `Effect.gen` vs `pipe` by readability. No JSX-style patterns. For `tea`-shaped features specifically: state changes flow only through the reducer (`Next<State, Action, R>`), side effects only through `Command` (never a bare `Effect.runFork` inside a reducer), and there is no state lifetime beyond mount/unmount — anything that must survive navigation belongs in a service, not the feature's state (see `OwnershipRule` in `src/lib/tea.ts`).

3. **Signature-parity pass (explicit, not assumed).** Diff the implemented exports against the mock surface committed in step 2:
   - No export added, removed, or renamed.
   - No signature changed (parameters, return types, generics, error union).

   Typecheck alone does not catch additions or loosened types. Do this pass deliberately. **Any deviation triggers the pause rule:** stop implementing, return to `/spec` and `/mock` to update spec + surface (and `/type-tests` + `/unit-test` if affected), then resume here.

4. **Green loop.** Repeat until both are clean:
   1. `vp check --fix`: auto-fix formatting/lint.
   2. `vp check`: format, lint, type-check. Must be green.
   3. `vp test`: run all node/jsdom tests. Every test from the red phase must now pass; no other test may regress.

   This is a single package with no `pack` step — bare `vp check`/`vp test` are always correct here; there is no `vp run <task>` indirection to reach for.

5. **Hand off.** Next step is `/e2e`.

## Rules

- Implementation must match mock signatures exactly and behavior must match `specs.md`.
- If implementation reveals mocks/specs need changes, apply the pause rule: update specs and mocks first, never drift silently.
- Fix the implementation to satisfy the tests; changing a test is only legitimate when the pause rule has first changed the spec it encodes.
