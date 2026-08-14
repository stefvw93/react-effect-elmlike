# devtools.ts — an RTK-style logger as a providable service

## Overview & Purpose

`tea.ts` declares `DevtoolsEvent` and `RuntimeOptions.onEvent`, and
`createRuntime` **ignores its options argument entirely**. Nothing in the
library ever emits. Worse, `src/examples/app.tsx` and `src/examples/cart.tsx`
both pass an `onEvent` with a `console.debug` inside, so a reader copying the
example installs an observer that never fires and gets no signal that it is
dead. This is `tea.specs.md` **Open work #3** and one of its Known limitations;
this feature closes both.

What replaces it is a redux-logger / RTK-style debug utility — collapsed console
groups showing prev state, action, next state — installed as an **Effect service
through the root layer**. Being a service is the point: the sink is swappable
(console logger, in-memory recorder for tests, a `postMessage` transport later)
and costs nothing when nobody installs one.

**The hard constraint is that the fold is synchronous.** `createFeatureStore`'s
`fold`/`foldOne` are plain functions; only commands are Effects. A sink whose
method returned an `Effect` would put a forked fiber and a scheduler hop on the
hottest path in the library, and the log could land after the state had already
moved on. So the service is resolved **synchronously** from the root runtime's
cached context, and the sink shape is a plain synchronous function.

### Settled decisions

1. The sink is a **`Context.Reference`** with a no-op default, holding a
   **synchronous** `{ onEvent: (event: DevtoolsEvent) => void }`. A `Reference`
   is total — reading it can never fail and never widens `R`.
2. **`RuntimeOptions.onEvent` is removed outright**, along with the
   `RuntimeOptions` interface and `createRuntime`'s second parameter. The
   examples are updated in the same pass.
3. All four event categories ship: **transitions, commands issued, outputs
   emitted, defects**.
4. New module `src/lib/devtools.ts`, re-exported from `src/lib/index.ts`.
5. The default console predicate is **`skipUnchangedAmbient`**, not the blunter
   `skipUnchanged` (see Expected Behavior).
6. `DevtoolsCommand.dropped` ships, and so does `createRecorder`.
7. **No timestamp on the event.** The sink is called synchronously at the
   emission point, so emit-time and receive-time are the same instant.

### Verified against the installed `effect@4.0.0-beta.102`

The design leans on all four of these, so each was probed against the installed
dist rather than assumed:

| Claim                                                                                                                | Result                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Context.Reference(key, { defaultValue })` + `Context.getReferenceUnsafe(ctx, ref)` is total and synchronous         | Confirmed (`Context.d.ts:1760`, `:1320`)                                                                                                                                                       |
| `getReferenceUnsafe` caches the default, so repeated reads are identity-stable                                       | Confirmed, even for a fresh-object thunk. Only `Ref.defaultValue()` re-invokes and returns a new object — so **never compare against `defaultValue()`**, compare against the exported constant |
| `ManagedRuntime.cachedContext` is `undefined` until the first `runFork`, then set **synchronously** for a sync layer | Confirmed. `start()` does `runFork(run(cells))` immediately before `fold({_tag:"Mounted"})`, so `Mounted` **is** captured under a sync root layer                                              |
| An **async** root layer leaves `cachedContext` undefined after `runFork`                                             | Confirmed — a real blind window, recorded under Known limitations rather than hidden                                                                                                           |
| `Reference<S> extends Service<never, S>`, so `Layer.succeed(Devtools, sink)` is `Layer<never>`                       | Confirmed (`Context.d.ts:372`) — merging devtools into the root moves neither `RootR` nor any existing `component(bp)` call                                                                    |

## Public surface

```ts
// --- the event ---
export type DevtoolsCause =
  | { readonly _tag: "Dispatch" }
  | { readonly _tag: "Command"; readonly action: string; readonly key?: string }
  | { readonly _tag: "Lifecycle" }
  | { readonly _tag: "Defect"; readonly from: string };

export interface DevtoolsEnvelope {
  readonly name: string; // from `component(bp, { name })`; "TeaFeature" when unnamed
  readonly instance: string; // which mount
  readonly cause: DevtoolsCause;
}

export interface DevtoolsTransition extends DevtoolsEnvelope {
  readonly _tag: "Transition";
  readonly action: { readonly _tag: string };
  readonly previous: unknown;
  readonly next: unknown;
}
export interface DevtoolsCommand extends DevtoolsEnvelope {
  readonly _tag: "Command";
  readonly group: Group; // the address `Cancel` would name
  readonly command: CommandSummary;
  readonly dropped: boolean; // no mount draining the queue
}
export interface DevtoolsOutput extends DevtoolsEnvelope {
  readonly _tag: "Output";
  readonly output: { readonly _tag: string }; // whole message, unlike the on<Tag> payload
}
export interface DevtoolsDefect extends DevtoolsEnvelope {
  readonly _tag: "Defect";
  readonly from: string; // action tag it is attributed to
  readonly defect: DefectSummary;
  readonly handled: boolean; // an Error handler took it, vs React's boundary
}
export type DevtoolsEvent = DevtoolsTransition | DevtoolsCommand | DevtoolsOutput | DevtoolsDefect;

// --- encodable summaries ---
export type CommandSummary =
  | { readonly _tag: "None" }
  | { readonly _tag: "Effect" } // the effect itself is erased
  | { readonly _tag: "Keyed"; readonly key: string; readonly command: CommandSummary }
  | { readonly _tag: "Batch"; readonly commands: ReadonlyArray<CommandSummary> }
  | { readonly _tag: "Cancel"; readonly target: Group };
export interface DefectSummary {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}
export const summarizeCommand: (command: Command<any, any>) => CommandSummary;
export const summarizeDefect: (error: unknown) => DefectSummary;

// --- the sink ---
export interface DevtoolsSink {
  readonly onEvent: (event: DevtoolsEvent) => void;
}
export const noopDevtools: DevtoolsSink; // frozen module constant, identity-compared
export const Devtools: Context.Reference<DevtoolsSink>; // key "@tea/Devtools"
export const devtoolsLayer: (sink: DevtoolsSink) => Layer.Layer<never>;

// --- console logger ---
export interface DevtoolsConsole {
  // injectable, so the logger's own tests are deterministic
  readonly group: (...args: ReadonlyArray<unknown>) => void;
  readonly groupCollapsed: (...args: ReadonlyArray<unknown>) => void;
  readonly groupEnd: () => void;
  readonly log: (...args: ReadonlyArray<unknown>) => void;
  readonly error: (...args: ReadonlyArray<unknown>) => void;
}
export interface DevtoolsColors {
  readonly previous?: string;
  readonly action?: string;
  readonly next?: string;
  readonly command?: string;
  readonly output?: string;
  readonly defect?: string;
}
export interface ConsoleDevtoolsOptions {
  readonly collapsed?: boolean; // default true
  readonly predicate?: (event: DevtoolsEvent) => boolean; // default skipUnchangedAmbient
  readonly diff?: boolean; // default false
  readonly timestamps?: boolean; // default true
  readonly colors?: DevtoolsColors;
  readonly console?: DevtoolsConsole; // default globalThis.console
}
export const createConsoleDevtools: (options?: ConsoleDevtoolsOptions) => DevtoolsSink;
export const consoleDevtoolsLayer: (options?: ConsoleDevtoolsOptions) => Layer.Layer<never>;

// --- predicates & recorder ---
export const skipUnchangedAmbient: (event: DevtoolsEvent) => boolean; // the default
export const skipUnchanged: (event: DevtoolsEvent) => boolean;
export interface DevtoolsRecorder {
  readonly sink: DevtoolsSink;
  readonly events: ReadonlyArray<DevtoolsEvent>;
  readonly clear: () => void;
}
export const createRecorder: () => DevtoolsRecorder;
```

Installing it:

```ts
const { Provider, component } = createRuntime(
  Layer.mergeAll(AppLayer, import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty),
);
```

Both ternary branches are `Layer<never>`, so it types cleanly and `RootR` is
untouched — no existing `component(bp)` call changes.

## Acceptance Criteria

### The event and its summaries

- [ ] `DevtoolsEvent` is a four-member tagged union (`Transition`, `Command`, `Output`, `Defect`) and narrows by `_tag`.
- [ ] `cause` is **required** on every member; every emission site knows its cause.
- [ ] `DevtoolsCause` has exactly four variants: `Dispatch`, `Command` (with `action` and optional `key`), `Lifecycle`, `Defect` (with `from`). The old `cause: { _tag: "Output" }` variant is **deleted, not made optional** — see Expected Behavior.
- [ ] `summarizeCommand` erases the effect (`{ _tag: "Effect" }` carries no function), preserves `Keyed` nesting and `Batch` order, and passes `Cancel`'s target through.
- [ ] `summarizeDefect` produces `{ message }` plus optional `name`/`stack` from an `Error`, from a string, from a symbol, and from `undefined`, and never throws.
- [ ] Every event is **JSON round-trippable**: `JSON.parse(JSON.stringify(event))` deep-equals the event, given encodable state and actions.
- [ ] The `Transition` for the runtime's own `Error` action carries `action: { _tag: "Error" }` and not the action object the runtime built, which holds a live `Error` and a `Cause`. See Expected Behavior.
- [ ] The `Transition` for `HookChanged` carries `action: { _tag: "HookChanged" }`. Hooks are `Record<string, unknown>`, so the previous record the runtime attaches routinely holds functions — `structuredClone` throws on one, which would disable the sink rather than merely losing a field.
- [ ] `PropsChanged` **keeps** its `previous` props, which are a schema value and encode.

### The sink service

- [ ] `Devtools` is a `Context.Reference<DevtoolsSink>` keyed `"@tea/Devtools"` whose default is `noopDevtools`.
- [ ] Reading the reference from an empty context returns `noopDevtools` **by identity**, and repeated reads return the same object.
- [ ] `noopDevtools.onEvent` is a no-op and the object is frozen.
- [ ] `devtoolsLayer(sink)` types as `Layer.Layer<never>` and installs `sink` where `Devtools` is read.
- [ ] `createRecorder()` returns a sink that appends every event in emission order to `events`, and `clear()` empties it.

### Emission from `createFeatureStore`

- [ ] `start()` emits a `Transition` for `Mounted` with `cause: Lifecycle`.
- [ ] `dispatch(action)` emits a `Transition` with `cause: { _tag: "Dispatch" }`, the store's `name` and `instance`, and `previous`/`next` as the actual state references.
- [ ] `sync` with changed props emits a `PropsChanged` `Transition` with `cause: Lifecycle`; a handler that returns the same state gives `previous === next`.
- [ ] A reducer returning a command emits one `Command` event whose `command` is the summary, whose `group` is the address `Cancel` would name, and whose `dropped` reflects whether any mount was there to take it.
- [ ] An action a command dispatches carries `cause: { _tag: "Command", action, key? }`; `key` is present when the command was `Keyed`, proving the key reached the leaf.
- [ ] `Command.output(…)` emits an `Output` event carrying the **whole message including `_tag`** (unlike the `on<Tag>` prop, which gets `_tag` stripped), and it lands **before** the `on<Tag>` handler runs.
- [ ] A dying command emits **exactly one** `Defect` (`from` = the action tag, `handled: true` when an `Error` handler takes it), followed by a `Transition` for `Error` with `cause: { _tag: "Defect", from }`. That second event is not a duplicate — see Expected Behavior.
- [ ] With no `Error` handler declared, the same defect emits one `Defect` with `handled: false`, and the error still reaches the store's `defect` sink.
- [ ] A throwing `on<Tag>` handler emits one `Defect` with `handled: false` and does **not** reach the feature's `Error` handler.
- [ ] `stop()` emits the `Unmounted` `Transition` and the teardown `Command` event, even though teardown bypasses `fold` and calls `blueprint.reduce` directly.
- [ ] `instance` is stable across `stop(); start()` on one store, and differs between two stores of the same `name`.
- [ ] `name` comes from `component(bp, { name })` and falls back to `"TeaFeature"`.

### Robustness and cost

- [ ] **A throwing sink does not break the fold**: state still moves, no defect is raised, and the sink is disabled — it is not called again.
- [ ] With no devtools layer installed, every path above behaves exactly as it does today and nothing throws.
- [ ] With no sink installed, an emission site **allocates nothing**: no summaries, no event literals, no strings, and no thunk-passing helper. **Verified by construction, not by a test** — every site is `const target = devtools(); if (target !== undefined) …`, and the absence of an allocation is not observable from outside the fold. A test asserting it would have to mock the module and would then be asserting the mock. What _is_ tested is the observable half: the sink is resolved at most once (`resolves the sink once and reuses it`) and a store with no layer behaves identically.

### Console logger

- [ ] `collapsed: true` (the default) uses `groupCollapsed`; `collapsed: false` uses `group`.
- [ ] `groupEnd()` fires **exactly once per group even when the body throws** — a throw inside a group would otherwise nest every subsequent console line for the life of the page.
- [ ] **A throw while printing does not escape the logger.** It is reported through `console.error` and the sink keeps working. Printing reads user state, so such a throw is a property of one value, not of the sink — and the store disables a sink that throws, which would take devtools dark for the rest of the page because one state object had a hostile getter. If `console.error` throws too, that is swallowed: there is nothing left to report it with.
- [ ] The elapsed map is **bounded**, independently of the `Unmounted` transition that normally clears an entry — a mount whose fiber died never folds one.
- [ ] A transition prints `prev state` / `action` / `next state` / `cause` lines with `%c` colour directives.
- [ ] Defect bodies go through `console.error`, not `console.log`.
- [ ] The default predicate (`skipUnchangedAmbient`) drops an unchanged `PropsChanged`/`HookChanged`, keeps a `PropsChanged` that moved state, and keeps `Unmounted` and an unchanged **dispatch**.
- [ ] `skipUnchanged` drops any transition where `previous === next`, including `Unmounted`.
- [ ] `diff: true` prints a **shallow own-keys** diff (`+ key`, `- key`, `~ key: prev → next`).
- [ ] Elapsed time appears from the second event of a given `${name}#${instance}` onward, and the elapsed map **drops its entry on an `Unmounted` transition**.
- [ ] `timestamps: false` omits the clock, `timestamps: true` (default) includes it.
- [ ] Everything above is asserted against an injected `DevtoolsConsole`, never the global.

### Removal of `RuntimeOptions`

- [ ] `DevtoolsEvent` and `RuntimeOptions` are gone from `tea.ts`; `tea.ts` imports the event type from `./devtools`.
- [ ] `createRuntime` takes one parameter. `__type-tests__/tea.tst.ts` already passes one argument at every call site, so this is source-compatible.
- [ ] `src/examples/app.tsx` and `src/examples/cart.tsx` no longer pass a dead `onEvent`.
- [ ] `tea.specs.md` Open work #3 is closed and its `onEvent` known-limitation is replaced.

### Type-level (TSTyche) — `src/lib/__type-tests__/devtools.tst.ts`

- [ ] `DevtoolsEvent` narrows by `_tag` to each of the four members.
- [ ] `devtoolsLayer(sink)` and `consoleDevtoolsLayer()` are both `Layer.Layer<never>`.
- [ ] `createRuntime(Layer.mergeAll(fooLayer, consoleDevtoolsLayer())).component(needsFoo)` typechecks — **the claim the whole install story rests on**: merging devtools moves neither `RootR` nor any existing `component` call.
- [ ] `CommandSummary` is a faithful erasure of `Command`: same tag set, no function-valued field.
- [ ] `DevtoolsCause`, `CommandSummary` and `DefectSummary` all satisfy a locally declared recursive `Json` type — the first machine check of this file's encodability promise.

## Technical Requirements

### Changes to `src/lib/tea.ts`

| Site                       | Change                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `:1690-1733`               | Delete `DevtoolsEvent` and `RuntimeOptions`; `import type` the event from `./devtools`                                                                             |
| `:2613-2615`, `:2669-2675` | Drop `createRuntime`'s `options?: RuntimeOptions` parameter, its `_options` binding and the explanatory comment                                                    |
| `:824`                     | Widen `deps.emit` to `(message, ctx: CommandContext) => Effect<void>`                                                                                              |
| `:936`, `:951-954`         | Replace the single shared `dispatch` closure with a per-leaf `dispatchFor(ctx)`. `Keyed` refines `ctx` before recursing, so the leaf's ctx already carries the key |
| `:1617`                    | **No edit.** `run`'s one-parameter `emit` stays assignable to the two-parameter type and ignores the ctx                                                           |
| `~:1846`                   | Module-scope `instanceCounts` map + `nextInstance(name)`                                                                                                           |
| `:1885-1906`               | `createFeatureStore` gains optional `name` and `instance` args — **must be optional**, ~25 direct constructions in `tea.test.ts`                                   |
| `:2013-2014`               | `pending` becomes `Array<{ action, cause }>`, mirroring `run`'s own `Entry` shape                                                                                  |
| `:2066-2080`               | `offer` returns a boolean so the `Command` event can carry `dropped`                                                                                               |
| `:2093-2099`               | `emitOutput` emits the `Output` event before calling `emit`, and its own `Defect` on catch                                                                         |
| `:2105-2122`               | `foldOne` emits `Transition` (after a successful reduce, before the command event) and `Command` at the `offer` call                                               |
| `:2162-2168`               | `raiseDefect(error, from, cause)` — emits `Defect` at the top, before the routing branch                                                                           |
| `:2217`, `:2244`           | Interpreter `emit`/`onExit` supply `{ _tag: "Command", action: ctx.tag, key: ctx.key }`                                                                            |
| `:2478-2492`               | `stop()` emits the `Unmounted` transition and the teardown `Command` event — it bypasses `fold` and calls `blueprint.reduce` directly                              |
| `:2696`, `:2752`           | `component` passes its existing `name` to the store (today it only sets `displayName`)                                                                             |

### Sink resolution

```ts
let resolved = false;
let sink: DevtoolsSink | undefined;

const devtools = (): DevtoolsSink | undefined => {
  if (!resolved) {
    const context = runtime.cachedContext;
    if (context === undefined) return undefined; // root layer still building; retry next fold
    const installed = Context.getReferenceUnsafe(context, Devtools);
    sink = installed === noopDevtools ? undefined : installed;
    resolved = true;
  }
  return sink;
};
```

Every call site is `const target = devtools(); if (target !== undefined) report(target, {…})`,
so nothing is allocated when the sink is absent — no summaries, no event
literals, no strings, and no thunk-passing helper (a closure allocates whether
or not it is ever called).

`report` wraps the call in `try/catch` and **disables the sink on a throw**.
Without it, a throwing sink inside `foldOne` is caught by `fold` and routed into
the _feature's_ `Error` handler — a devtools bug becoming a feature error state,
the exact swallow-your-caller's-bug mistake `emitOutput` already exists to avoid.

### Module constraints

- `verbatimModuleSyntax` means `devtools.ts` uses `import type { Command, Group } from "./tea"`, which erases completely: exactly one runtime edge (`tea → devtools`), no cycle.
- `erasableSyntaxOnly` rules out a TS `namespace`; flat names throughout.
- `Layer.mergeAll` inference over a contravariant `ROut` is confirmed by `vp check` at `/mock` time; the fallback spelling is `AppLayer.pipe(Layer.merge(consoleDevtoolsLayer()))`.

### Sequencing constraint for `/mock`

`declare const Devtools` emits nothing at runtime, so if `tea.ts` imports it at
the mock step, `getReferenceUnsafe(ctx, undefined)` throws and the entire
existing 2934-line `tea.test.ts` goes red — which `/unit-test` forbids. So:

- `/mock` writes the full `declare` surface in `devtools.ts`, adds
  `export * from "./devtools"` to `index.ts`, and makes only the
  **type-visible** `tea.ts` edits (delete `DevtoolsEvent`/`RuntimeOptions`, drop
  the `createRuntime` parameter, widen `deps.emit`, add the optional store
  args). **No import from `devtools.ts` in `tea.ts` yet.**
- Removing `RuntimeOptions` forces `src/examples/app.tsx` and `cart.tsx` to be
  updated **in that same step** or `vp check` fails.
- `/implement` adds the imports and every emission call site at the moment
  `devtools.ts` gets its bodies.

### Console output shape

```
▸ cart#1  Bump  @ 12:34:56.789  (+412ms)
    prev state   { count: 0 }          %c #9E9E9E
    action       { _tag: "Bump" }      %c #03A9F4
    next state   { count: 1 }          %c #4CAF50
    cause        { _tag: "Dispatch" }
▸ cart#1  ⟶ Bump  batch(cancel(Bump), keyed(q, effect))    %c #9C27B0
▸ cart#1  ⇢ OrderPlaced                                     %c #009688
▸ cart#1  ✖ CheckoutRequested: network down (unhandled)     %c #F20404
```

Elapsed uses `performance.now()` in a `Map` keyed by `${name}#${instance}`.

## Dependencies & Integrations

- `effect@4.0.0-beta.102` — `Context.Reference`, `Context.getReferenceUnsafe`, `Layer.succeed`, `ManagedRuntime.cachedContext`.
- `src/lib/tea.ts` — type-only import of `Command` and `Group`; the runtime edge goes the other way (`tea → devtools`).
- `src/lib/index.ts` — `export * from "./devtools"`.

## Expected Behavior & Edge Cases

- **The `cause: { _tag: "Output", from, output }` variant is deleted, not kept optional.** It claimed _"this action was caused by a child's output"_, but an output leaves through a plain React callback into arbitrary user code — the runtime cannot know what the parent did next. That is the existing known limitation, and an unfillable optional field is a promise the runtime cannot keep. A devtools UI can still draw the edge from the `Output` event itself.
- **The one action the runtime builds itself is trimmed before it is reported.** `raiseDefect` folds `{ _tag: "Error", error, cause: Cause.die(error) }`, and neither `error` nor `cause` survives `JSON.stringify` — the first flattens to `{}`, the second to an Effect-internal shape that does not read back. Found by the round-trip test rather than by reasoning: every _user_ action is a schema value, so the only unencodable action in the system is the runtime's own. The `Transition` therefore reports `action: { _tag: "Error" }`. Nothing is lost — the `Defect` event immediately preceding it carries the same failure as an encodable `DefectSummary`, and this transition's `cause: { _tag: "Defect", from }` is the link between them.
- **Encodability is preserved**, which is what the event's JSDoc is sold on, and is why the two summary types exist: an `Error` is structured-cloneable but `JSON.stringify`s to `{}`. The cost, stated in the JSDoc: the console prints a stack _string_, so the browser's clickable frames are lost.
- **No timestamp on the event.** Keeps `Date.now()` out of the library, makes every expected event in a test a total literal, and stops an elapsed figure from implying a reducer duration the runtime does not measure. The console logger stamps its own clock at print time.
- **`skipUnchangedAmbient` is the default, not `skipUnchanged`.** Note a stale premise in the current code: `LifecycleHandlers.PropsChanged`'s JSDoc says props "fire constantly", but `sync` compares **by value** via `Schema.toEquivalence`, so an unchanged parent re-render folds nothing. The real noise is an ambient action whose handler returns the same state. The blunt version would also hide `Unmounted` unconditionally (`reduce` discards its state, so `previous === next` always) and hide a deliberate no-op dispatch — often the exact thing devtools was opened to see.
- **Not a double emission, and it must stay documented so a reviewer does not "fix" it:** when `handled` is true, the subsequent `fold({_tag:"Error"})` produces a _second_ event — a `Transition` with `cause: { _tag: "Defect", from }`. Two different facts: a defect occurred, and the `Error` action folded.
- **The `Defect` event is emitted in `raiseDefect` only.** `onExit` already calls `raiseDefect`, so emitting in both would double every dying command. `handled` comes from the branch that already exists: `from === "Error" || !handles("Error")` → `handled: false`. `emitOutput`'s catch calls `defect()` **directly**, never `raiseDefect` (deliberately), so it needs its own emission with `handled: false`.
- **A dropped command logs as dropped, not as issued** — hence `offer` returning a boolean.
- **StrictMode double-invokes the `useState` initialiser**, burning an instance id. Ids are unique, not gapless. The counter is module-global, so ids are unique per page rather than per runtime.
- `diff` is deliberately shallow: deep-diffing unknown state is unbounded work on a value the library does not own — the same argument `hooksEquivalence` already makes.

## Known limitations

- **`dropped: false` means "handed to a live mount", not "ran".** The flag answers what the runtime can know at the offer. A fiber can accept a command and then be torn down before interpreting it — teardown exceeding its 5s bound is the real case, and `tea.ts` says so at that site — and a synchronous event emitted at the offer cannot be revised afterwards. Making it accurate would mean either deferring the event until the work was interpreted, which loses the ordering the log is for, or a second "and it actually ran" event, which is a bigger surface than the problem.
- **`group` is the tag-level address, not always the exact one.** `Command.cancel(group.tag)` interrupts everything the command forked, but a `Batch` can hold members under several keys, so no single precise `{ tag, key }` exists in general. Reporting a precise address only when one happened to exist would make the field mean different things on different events. The keys are in `command`, on each `Keyed` node.
- **A mount whose fiber died emits no `Unmounted`.** A feature layer that fails to build kills the mount fiber, `release()` clears `active`, and the `stop()` React then calls returns at its `active` guard before reaching the emission. The log shows the feature going quiet with no terminal event. This is the devtools face of `tea.specs.md` open work #1 — the store cannot currently re-arm from `component` either — and it is that item's fix to make, not a second emission site here. The console logger's elapsed map no longer depends on the terminal event: it is bounded independently.

- **The blind window before the root context exists.** With a synchronous root layer, only folds _before_ `start()` are lost — a descendant's `useLayoutEffect` dispatch (the buffered path) and the first render's `sync`. With an **asynchronous** root layer, everything until the layer resolves is lost. Warming the context with a `runFork(Effect.void)` inside `createRuntime` would close the sync window, but it moves _when the root layer builds_, which is observable through any layer's acquire side effects — not a debugging tool's call to make.
- **The console logger prints a stack string, not clickable frames.** The price of an encodable `DefectSummary`.

## Open work

### 1. `Blueprint.run` does not emit

`run` has no `ManagedRuntime`, no `name` and no `instance`, and its `emitted` /
`outputs` arrays already cover most of what a headless assertion wants. Its body
runs under `Effect.provide(options.layer)`, so `yield* Devtools` would resolve
from a test layer — but synthesising a `name` and an `instance` for a headless
fold is a spec decision, not a patch. Recorded here rather than left ambiguous.

## Browser coverage (`/e2e`)

Applicable, `src/lib/devtools.browser.test.tsx` — eight tests. The node suite
drives `createFeatureStore` directly and covers every emission site; what it
cannot cover is the thing devtools is installed _into_, because `component`
owns when `start` runs and the effect scheduling is React's:

- **`Mounted` is reported from a real mount.** The riskiest claim in the design:
  `start` forks the root runtime in a passive effect immediately before folding
  `Mounted`, and if `cachedContext` were not populated by then every log would
  silently begin one action late.
- A real click reports its transition and the command it issued.
- **An output reaches the log before the parent's `on<Tag>` prop is called**,
  across the actual React boundary rather than a stub `emit`.
- A `PropsChanged` folded _during render_ is reported — the one emission site
  that runs while React is rendering.
- A dying command reports one `Defect` and then the recovery fold.
- Unmounting reports `Unmounted`.
- Two mounts of one blueprint are distinguishable by `instance`, which is the
  reason that field exists.
- StrictMode's double mount stays coherent.

The output test pins the **two-hop causal chain** rather than a single edge: the
click folds `Bumped`, whose keyed command emits `Landed`, whose own unkeyed
command emits the output. So the `Output` carries `cause: { _tag: "Command",
action: "Landed" }` and not the click two hops back. Each event states the one
edge the runtime can see; walking them is the UI's job.

- e2e: **not applicable for the examples.** `tea.specs.md` already records that
  `cart.tsx` and `presence.tsx` cannot be mounted in any environment
  (declare-only ambient hooks, `declare const AppLayer`); `app.tsx` is in the
  same position for the same reason. Their change here is a two-line deletion,
  compile-checked by `vp check`.
