---
name: "type-tests"
description: "Step 3 of the react-effect TDD workflow. Use after /mock: assesses whether the feature has meaningful type-level surface and, if so, writes __type-tests__/*.tst.ts TSTyche type tests with expect().type matchers, installing tstyche on first use. If not applicable, records an explicit skip in specs.md, never a silent skip."
---

# /type-tests: TSTyche type tests (TDD step 3)

Verify the mocked type surface with TSTyche, or record an explicit, reasoned skip.

## When to run

- **Previous step:** `/mock` (the `declare`-based surface must exist in the source file).
- **Next step:** `/unit-test`.
- **Gate:** the step always concludes with either a `.tst.ts` file or an explicit `type-tests: not applicable, <reason>` line in `specs.md`. Silent skips are forbidden.

## Procedure

1. **Assess applicability.** Does the feature have meaningful type-level behavior worth locking down? `src/lib/tea.ts` is heavy on this (branded phantom types, mapped/conditional types like `Excess`/`Exhaustive`, inferred `ServicesOf`) — most real additions there warrant a type test.
   - Generics and generic constraints
   - Overloads
   - Conditional/inferred types (what does the compiler deduce for a consumer?)
   - Surfaces that must _reject_ plausible-but-wrong usage (e.g. an excess state property, a lifecycle tag reused as an action tag)

   Trivial concrete signatures (already fully enforced by the main typecheck) do not warrant a type test.

2. **If not applicable:** add to the feature's `specs.md`:

   ```markdown
   type-tests: not applicable, <one-line reason>
   ```

   Report the skip and reason to the user, then hand off to `/unit-test`.

3. **If applicable and `tstyche` isn't installed yet:** this is the first time the repo needs it, so set it up now, inline:
   - `vp install -D tstyche`
   - Add a root `tstyche.json` with `testFileMatch` pointed at `src/**/__type-tests__/*.tst.ts`.

   This repo has no monorepo `pack` step, so no `run.tasks` wrapper is needed — tests run via `vp exec tstyche` directly.

4. **Write the test file** at `src/**/__type-tests__/<feature>.tst.ts`. Each file is self-contained and tests one feature. Pattern:

   ```typescript
   import { expect, test } from "tstyche";

   test("descriptive name of the behavior", () => {
     // Positive: exact type identity.
     expect(someValue).type.toBe<SomeType>();
     // Pure type-level comparison (no value involved).
     expect<Derived<A>>().type.toBe<Expected>();
     // Assignability when identity is not the intent.
     expect(wider).type.toBeAssignableTo<Narrow>();

     // Negative: rejected call (argument types/arity).
     expect(fn).type.not.toBeCallableWith("bad", 123);
     // Negative: property must not exist.
     expect(obj).type.not.toHaveProperty("secret");
   });
   ```

   Cover:
   - Positive cases: valid usage compiles and inference lands on the expected types. Assert with `.type.toBe<T>()` (exact identity; prefer over `toBeAssignableTo` unless assignability _is_ the intent).
   - Negative cases: each rejection asserted by one `.not` matcher. Where no matcher fits (wrong-assignment-type, contextual typing inside a larger expression), keep a `// @ts-expect-error <fragment>` directive. TSTyche requires a fragment of the expected diagnostic message after the directive and validates it (`checkSuppressedErrors`). Put prose on its own comment line above.
   - One assertion per rejection. A single check swallowing two mistakes proves nothing.

   Constraints: `declare` fixtures live at module scope (`declare` is illegal inside `test()` bodies). `test()` callbacks must not start comments with `@ts-expect-error` unless they are real directives. TSTyche parses them.

5. **Validate** with `vp exec tstyche`. The files also stay inside the tsc program (`tsconfig.app.json` `include: ["src"]`), so `vp check` still typechecks the test code itself. But **only `vp exec tstyche` evaluates the assertions**; a failed `toBe` is invisible to `vp check`.

6. **Hand off.** Next step is `/unit-test`.

## Rules

- `.tst.ts` extension, under `__type-tests__/`, self-contained per feature.
- Import test globals from `"tstyche"` (`expect`, `test`); no hand-rolled `Expect<Equal<>>` helpers.
- Type tests run against the mock surface. They must pass _before_ implementation exists (they compare types, not runtime behavior).
- If writing the tests reveals the mocked types are wrong, apply the pause rule: go back to `/spec` + `/mock` first.
- TSTyche runs its own pinned TypeScript per `tstyche.json`, separate from this repo's `typescript@~7` (tsgo). On checker disagreement, trust `vp check` for program correctness and TSTyche for assertion verdicts.
