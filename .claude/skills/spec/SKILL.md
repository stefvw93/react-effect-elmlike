---
name: "spec"
description: "Step 1 of the react-effect TDD workflow. Use when starting any new feature (or retroactively spec'ing an existing one being modified): drives an interactive Q&A requirements discussion, then writes the co-located specs.md. Entry point of the cycle spec → mock → type-tests → unit-test → implement → e2e → review-step → document."
---

# /spec: Specification (TDD step 1)

Draft a co-located `specs.md` for a feature through interactive Q&A, before any code exists.

## When to run

- **Previous step:** none (this is the entry point of the workflow).
- **Next step:** `/mock`.
- **Gate:** none to enter. To exit, the user must explicitly approve the spec.

## Procedure

1. **Locate the feature.** This repo is a single package, not a monorepo — there is no package to select. Determine only the source file:
   - A library feature (part of the `tea` runtime itself) lives in `src/lib/` — either `tea.ts` or a new `src/lib/*.ts` file, re-exported from the `src/lib/index.ts` barrel.
   - A demo feature lives in `src/examples/*.tsx` (e.g. `cart.tsx`, `search.tsx`).

   The spec is co-located: `src/lib/tea.ts` gets `src/lib/tea.specs.md`; `src/examples/cart.tsx` gets `src/examples/cart.specs.md`. If a `specs.md` already exists for this feature, this run revises it. Read it first.

2. **Q&A discussion: one question at a time.** Use the AskUserQuestion tool. Ask a single question, await the answer, then ask the next. Cover, as applicable:
   - Purpose: what problem does this solve, for whom?
   - Requirements and acceptance criteria: what must observably be true?
   - API shape: inputs, outputs, Effect error union (tagged errors), services/dependencies.
   - Edge cases and failure modes.
   - Constraints: browser-observable behavior (feeds the later `/e2e` decision), performance.
   - Type-level surface: generics, constraints, inference expectations (feeds the later `/type-tests` decision).

   Keep asking until you have no material open questions. Do not batch questions.

3. **Write `specs.md`** from this template:

   ```markdown
   # <Feature Name>

   ## Overview & Purpose

   <What this is and why it exists.>

   ## Acceptance Criteria

   - [ ] <Observable, testable criterion>
   - [ ] <...>

   ## Technical Requirements <!-- optional -->

   ## Dependencies & Integrations <!-- optional -->

   ## Expected Behavior & Edge Cases <!-- optional -->
   ```

   Required sections: **Overview & Purpose**, **Acceptance Criteria**. Optional sections only when they carry real content. Acceptance criteria must be concrete enough that `/unit-test` can name test cases after them.

4. **Iterate until approved.** Present the draft, incorporate feedback, repeat. Only when the user approves is this step done.

5. **Hand off.** Tell the user the spec is approved and the next step is `/mock`.

## Rules

- No implementation code, no mocks, no tests are written in this step.
- Every new feature must have a `specs.md`; existing features without one (most of `src/lib/tea.ts` and `src/examples/*.tsx` today) get it retroactively when modified.
- If later steps reveal the spec is wrong: the cycle pauses and returns here first (spec → mock updated before implementation resumes).
