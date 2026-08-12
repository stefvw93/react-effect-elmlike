# tea.ts — TEA-style feature runtime core

## Overview & Purpose

`tea.ts` is the pure core of an Elm-Architecture-style runtime for React: a
feature is declared as a `Blueprint` — schema-typed props/state, an internal
action vocabulary, an optional outbound output vocabulary, optional
ambient-input hooks, and a reducer — and the runtime interprets the
side-effecting `Command` ADT it returns (`none`/`effect`/`stream`/`batch`/
`cancel`, with `restart`/`ignore`/`queue`/`parallel` concurrency policies) via
an `Effect`-based interpreter.

The `Command` surface described above is the **current** one. See _Design
decisions — command leaf_ below for three decisions taken against it: the leaf
becomes an `Effect` handed a `dispatch` rather than a `Stream`, `raise` and
`Command.output` are cut in favour of a single tag-routed `dispatch`, and the
Elm-style subscription split is deferred.

This spec is retroactive: `tea.ts` already carries a real implementation
(everything except `createRuntime`). It exists to bring that surface under
test coverage and to pin down documented-but-unverified behavior before
changing anything.

**The React binding was out of scope for the first pass and is now in scope.**
`createRuntime`'s `{ Provider, component, useRuntime }` was the one `declare
const` left in the file; `Provider` and `useRuntime` have since landed, and the
remaining three `declare`s — the `internals` symbol, `createFeatureStore` and
`validateProps` — are what _React binding_ below specifies. Everything else with
a real implementation stays in scope, including the type-level guards that
encode real invariants (`Disjoint`, `NoTransform`, `NoPropCollision`,
`Exhaustive`/`Excess`, `ServiceOf`/`ServicesOf`).

## Acceptance Criteria

### Vocabularies (`Action`, `Action.output`, `Action.of`)

- [x] A single message (`Action("Tag", fields)` / `Action.output("Tag", fields)`) constructs a `Schema.TaggedStruct` branded with its channel (`"internal"` vs `"outbound"`).
- [x] `Action.of([...])` builds a branded tagged union (`Schema.toTaggedUnion`) exposing `cases`, `guards`, `match`, `mapMembers`, and a `make` constructor per case.
- [x] `Action.of` infers the vocabulary's channel from its members' brand (`ChannelOf`) — there is no per-channel `of`.
- [x] `Action.of` rejects a member list mixing internal and outbound messages (`SameChannel`), at the call rather than at `define`.
- [x] A vocabulary built with `.of` can be nested inside another `.of` call, and the outer vocabulary's `cases` include the flattened inner tags.
- [x] The two channels are not mutually assignable: a `Message<Tag, Fields, "internal">` is not assignable where `Message<Tag, Fields, "outbound">` is expected, and vice versa (channel brand is load-bearing, not just cosmetic).
- [x] Constructing a message with a reserved `LifecycleTag` (`"Mounted" | "PropsChanged" | "Error" | "Unmounted" | "HookChanged"`) is a compile error.

### `Command` ADT and constructors

- [x] `Command.none` is the `{ _tag: "None" }` no-op.
- [x] `Command.effect(effect)` wraps an `Effect` that runs for effects and emits nothing.
- [x] `Command.stream(stream)` wraps a `Stream` whose emissions feed back into the reducer (or leave as outputs). _(Criterion is superseded by the pending command-leaf redesign — see below. Covered now so the routing behavior is pinned before the leaf changes.)_
- [x] `Command.batch(...commands)` runs each member independently, each keeping its own policy.
- [x] `Command.cancel(target)` interrupts a running group, addressed by tag only or by `{ tag, key }`.
- [x] `Command.output(message, payload)` emits an outbound message as a one-shot stream; passing an internal message is a compile error. _(Criterion is superseded by the pending command-leaf redesign — see below. Covered now so the payload contract is pinned before `dispatch` replaces it.)_
- [x] `Command.restart(key?)`, `.ignore(key?)`, `.queue(key?)` wrap a command in a `Guarded` policy node; all three are `Pipeable` (`cmd.pipe(Command.restart())`).
- [x] Nesting `Guarded` wrappers: the outermost policy wins (an inner `Guarded` is not overridden if an outer one already set a policy for the same dispatch).

### `Next` accessors

- [x] `Next.state(next)` returns the state whether `next` is a bare state or a `[state, command]` tuple.
- [x] `Next.command(next)` returns the command for a tuple, `undefined` for a bare state.

### `define(...).create(...)` → `Blueprint.reduce`

- [x] `reduce` dispatches by `_tag` to the matching reducer handler (declared action or lifecycle action) and returns its `Next`.
- [x] **Unhandled _lifecycle_ actions leave state unchanged and do not throw.** (Bug fix — see below.)
- [x] A missing handler for anything that is _not_ a lifecycle tag (reachable only by bypassing the typed `dispatch`/`reduce` surface, e.g. a bad cast) still throws — the no-op is specific to `LifecycleTag`, not "any missing handler." (Caught during `/review-step`: an earlier version of the fix no-opped unconditionally, silently swallowing this case too.) **Also covers inherited `Object.prototype` keys — see below.**
- [x] Dispatching `{ _tag: "Unmounted" }` runs the `Unmounted` handler if declared but the _returned state_ is discarded — only its command matters. (Testable directly via `reduce`, no mounting required.) Discarded by `reduce` and by `run` alike, including when the handler returns a bare state with no command — see _Resolved: `reduce` discards `Unmounted`'s state_ below.

### `define(...).create(...)` → `Blueprint.run`

- [x] Seeded actions (from the `actions` iterable passed to `run`) are processed but are not themselves recorded in `emitted`.
- [x] Actions/outputs a command's effect/stream emits during the run are fed back into the reducer loop.
- [x] `emitted` collects every non-output action that arrived via a command (not seed actions, not outputs).
- [x] `outputs` collects every message whose tag is in the declared output vocabulary's `cases`; an output never re-enters the reducer and never appears in `emitted`. **`cases` is checked with `Object.hasOwn` — see the prototype-chain note below.**
- [x] `Command.batch` members run independently — each keeps its own concurrency group/policy.
- [x] `Command.cancel({ tag })` (no `key`) interrupts every running group under that tag; `Command.cancel({ tag, key })` interrupts only that specific group.
- [x] Policy `"restart"`: a new dispatch into the same group interrupts the prior in-flight fiber.
- [x] Policy `"ignore"`: a new dispatch into the same group is dropped while one is already in-flight.
- [x] Policy `"queue"`: a new dispatch into the same group waits for the prior to settle before running; both eventually complete.
- [x] Policy `"parallel"` (the default, i.e. no `Guarded` wrapper): concurrent dispatches into the same group all run concurrently and all complete.
- [x] Services requested by a command's effect/stream (`R`) are satisfied from `options.layer` via `Effect.provide`.
- [x] `run` resolves only once quiescent: nothing queued and nothing in flight (including fibers that settle without ever emitting, e.g. a bare `Command.effect` or an interrupted group).
- [x] **`run` does not terminate on a never-completing command.** No longer suspected — **confirmed**: a probe asserting that `run` _does_ settle within 100ms on `Command.stream(Stream.never)` timed out. `runGuarded` increments `inFlight` and only decrements after `Fiber.await` settles, so a stream that never completes pins it at 1, the quiescence break (`queueSize === 0 && inFlightCount === 0`) is never taken, and the drain loop blocks on `Queue.take`. Pinned against the **current `Stream` leaf** with `Effect.timeoutOption` — load-bearing, since a plain `it` hangs the suite rather than failing it — and paired with a control (`Stream.empty`, same harness, same budget) so the assertion cannot pass vacuously. **This box records the bug, it does not fix it**: the test asserts today's behavior deliberately, so the deferred `Cmd`/`Sub` split (_Design decisions_, §3) becomes visible when it lands. Whoever fixes it inverts this test rather than deleting it.

### Known bug fixed by this pass

`Blueprint.reduce`'s JSDoc states unhandled lifecycle actions return state
unchanged; the implementation instead calls `parts.reducer[action._tag]`
unconditionally, which is `undefined` for any lifecycle handler the feature
didn't declare and throws on call. The identical bug is duplicated in `run`'s
internal `step`, where the fix is already sitting commented out. Both call
sites no-op (return current state, no command) specifically when the missing
handler is for a `LifecycleTag` — matching the documented behavior without
widening it. A missing handler for anything else still throws, exactly as it
did before: every declared action tag is required in `reducer` by `Reducer`'s
type, so reaching that branch means the action bypassed the typed surface,
and swallowing it silently would trade one bug for a harder-to-find one.

### Second bug found by this pass: prototype-chain tags bypassed the throw

Both lookups on the missing-handler path walked the prototype chain.
`parts.reducer[action._tag]` resolved `"constructor"` to `Object` — truthy, so
it was _called_ as a handler and its return value used as the next state — and
`isLifecycleTag`'s `tag in LifecycleTags` was `true` for `"toString"`,
`"valueOf"` and every other `Object.prototype` key, so those silently no-opped
instead of throwing. Either way the documented "this still throws" branch was
unreachable for that whole family of tags.

Fixed with `Object.hasOwn` at both sites (`isLifecycleTag`, and a shared
`handlerFor` used by `reduce` and `run`'s `step`). Only reachable by bypassing
the typed surface — a bad cast, a malformed devtools replay — which is exactly
what that branch exists to catch, and where failing loudly matters most.

**A third site had the same hole:** `run`'s `isOutput` asked
`action._tag in spec.output.cases`, so `{ _tag: "constructor" }` was classified
as a declared output and collected into `outputs` rather than reaching the
throw. That one is the worst of the three — an unknown tag does not merely
no-op, it _leaves the feature_ through an `on<Tag>` prop and reaches the
parent. Also fixed with `Object.hasOwn`.

Worth noting as a pattern rather than three incidents: every `in` / index
lookup in this file is keyed by an attacker- or replay-supplied `_tag` against
an object literal, and every one of them inherits `Object.prototype`. Any new
tag-keyed lookup wants `Object.hasOwn` from the start.

### Resolved: `reduce` discards `Unmounted`'s state

`run`'s `step` discarded the state an `Unmounted` handler returns; `reduce`
returned it. Both are in this library, so this was not a userland replica
drifting — it was the library disagreeing with itself about the one action
whose contract is "the state has nowhere to go".

That mattered because `reduce`'s own JSDoc sells it as the way to test teardown
"without mounting anything". A test that folded `Unmounted` through `reduce`
saw `{ count: 999 }`; the same feature under `run` saw the state before it, and
the disagreement was silent in both directions.

**Resolved as option 1: `reduce` discards too.** It returns
`[snapshot.state, command]` for `Unmounted`, or bare `snapshot.state` when the
handler attached no command — so the criterion above is true as written and
`reduce` is a faithful model of the runtime.

Costs, accepted: `reduce` stops being a plain "look up the handler and return
what it said", and the handler's returned state is unobservable anywhere. The
second is the point rather than a loss — it is already unobservable under `run`,
so observing it in `reduce` only ever meant asserting a value production cannot
produce.

The option not taken was to drop the criterion's parenthetical and document the
discard as a _runtime_ fact. Smaller change, but it left the library with two
answers and callers having to know which one they were in.

A third option was raised and not taken: type `Unmounted`'s handler to return
`Command<Action, R> | void` rather than `Next<State, Action, R>`, so a state
cannot be returned at all. It dissolves the question instead of picking a
winner, but it breaks the "uniform in shape" property `LifecycleHandlers`
deliberately holds, and it is a wider change than the discard. Worth revisiting
if the command-leaf redesign churns this area anyway.

Coverage: the tuple case ("Unmounted discards the handler's returned state;
only its command matters"), the bare-state case ("…even with no command
attached" — the shape a tuple-only discard would miss), and the `run`
counterpart ("Blueprint.run discards Unmounted's returned state").

### Open bugs, found by review and not yet fixed

Neither is reachable through the documented surface, and neither breaks a
criterion above — which is why they are here rather than in the two
bug sections. Both are one-line fixes with a test each.

- [x] `run`'s snapshot leaks `layer` into every handler. `const snapshot = { ...options }` spread `options` whole — `{ props, hooks, layer }` — so `{ ...snapshot, state }` handed each handler a `Snapshot` carrying a fourth key. Invisible to the type (excess-property checking does not fire on a non-fresh spread) and harmless to read, but it put a `Layer` on the one object this file elsewhere claims is entirely encodable, and a cast reached it from userland. Fixed by naming the fields: `{ props: options.props, hooks: options.hooks }`. Asserted on the handler's own keys, since the leak is invisible to both the type and every existing assertion.
- [x] Stray `Effect.log("step", action)` in `run`'s `step`. Debug leftover — every action folded through `run` wrote a log line, so any suite using `run` was noisy and the default logger did formatting work nobody asked for. Removed. Contrary to this box's first wording ("no test; its absence is the assertion"), it _is_ directly testable: `Logger.layer([capture])` provided to the `run` effect replaces the logger set and collects what it emits, so the criterion is "`run` logs nothing of its own" — which also catches the next debug line somebody leaves behind, where a one-off deletion would not.

### Command leaf redesign (decided in _Design decisions_ below, not yet implemented)

Sequenced **after** the non-termination test above, so the current leaf's
behavior is pinned before it moves. Three boxes rather than one: each is
independently completable, and the first two are separate commits with a
working tree in between.

- [!] _Not attempted — excluded by the TDD loop's own "do not touch the pending command-leaf redesign" instruction; flip back to `[ ]` for a pass allowed to do it._ The leaf is an `Effect` handed a `dispatch`: `Command.effect((dispatch) => Effect<unknown, never, R>)`, with `dispatch: (action: Emit<A, O>) => Effect<void>` offering into `run`'s queue. The `Stream` variant and `Command.stream` are removed; a long-lived stream becomes `Stream.runForEach(source, dispatch)` inside the effect. `None`/`Batch`/`Cancel`/`Guarded` are untouched — policy, group and cancellation have nowhere to attach on a bare `Effect`. Blast radius is `interpret`'s `"Stream"` case and the constructor. The previous `Command.effect` (runs for effects, emits nothing) is the same constructor with an unused parameter, so its criterion survives verbatim.
- [!] _Not attempted — same exclusion as the box above._ `Command.output` is removed, including its compile-error-on-an-internal-message criterion. Outbound messages go through the same `dispatch`, routed by `_tag` against `spec.output.cases` — which is already how routing works, and already `Object.hasOwn`-checked. The channel brand keeps its declaration-time jobs (`ChannelOf`, `SameChannel`, `define({ action: … })`, `Disjoint`, `OutputProps`); it simply stops being checked at the command call site, where it never affected routing anyway.
- [!] _Not attempted — same exclusion as the two boxes above; the covariance test it refers to exists and passes against the current leaf._ Type-level: `Command<Narrow>` stays assignable to `Command<Wide>` under the callback encoding, and `Command.none: Command<never>` stays the bottom. `Dispatch<A>` is contravariant in `A` and sits in the callback's parameter position — contravariant again — so the two compose to covariant. The existing covariance test must pass unchanged against the new leaf; that is the point of having written it first.

### Type-level guards (exercised via TSTyche, not vitest)

- [x] `Disjoint<A, O>` is a compile error when an action tag and an output tag collide.
- [x] `NoPropCollision<PropsSchema, O>` is a compile error when a declared prop name collides with a derived `on<OutputTag>` name.
- [x] `NoTransform<PropsSchema>` is a compile error when a props schema's `Encoded` differs from its `Type` (a transforming/decoding props schema).
- [x] `Exhaustive<U, State>` / `Excess<N, State>` catch a reducer handler returning a state object with a key not present in the declared state schema.
- [x] `ServiceOf`/`ServicesOf` union services across multiple reducer handlers' return types without collapsing to `never` (the exact regression this type exists to prevent).
- [x] `OutputProps<Output>` derives one required `on<Tag>` prop per output case, with `_tag` stripped from the payload type.
- [x] `Command`'s `Pipeable` typing: `cmd.pipe(Command.restart())` preserves the command's `A` and `R` type parameters. **Includes the variance case the leaf redesign has to preserve — see below.**

### React binding (`createRuntime` → `component`)

The three remaining `declare`s. `internals` is the smallest and the most urgent:
`declare const internals: unique symbol` emits **nothing**, so `create`'s
`[internals]: {…}` key and `component`'s `blueprint[internals]` read both hit a
`ReferenceError` the moment either runs. It has to become a real
`Symbol("@tea/internals")`. The other two are `createFeatureStore` (the live
fold) and `validateProps`.

- [x] `Blueprint` carries a `BlueprintInternals` slot behind a real module-private `unique symbol` — `initialState`, `render`, `useHooks`, the props schema, and the declared output tags — populated by `create` and read only by `component`. `reduce` and `run` remain the entire public surface: the slot is absent from `Object.keys(blueprint)` and unreachable by name from userland.
- [x] `component(blueprint)` returns an `FC` that renders `render({ state, props, hooks, dispatch })` and re-renders when a command changes state.
- [x] Incoming props are split by derived name — exactly `outputTags.map(t => "on" + t)` — before validation; declared props whose names merely start with `on` (e.g. `onScroll`) are left alone. `NoPropCollision` is what makes the split unambiguous.
- [x] `validateProps` runs the props schema with `onExcessProperty: "error"` and `errors: "all"`, and **throws** on failure rather than reporting — a malformed prop is the parent's defect, so it reaches the nearest React error boundary. It runs on mount and on every props-identity change, and not on a re-render driven by this feature's own state (React hands back the identical props object then).
- [x] A message whose tag is in `outputTags` leaves through the matching `on<Tag>` prop with `_tag` stripped from the payload, and never re-enters the reducer. Everything else re-enters. Own-keys only, per the prototype-chain note above.
- [x] An output with no corresponding `on<Tag>` prop at runtime **throws**, matching the missing-handler precedent: `OutputProps` makes every one required, so an absent handler means the typed surface was bypassed.
- [x] `dispatch` accepts only declared actions and is reference-stable for the life of the mount, so it can be passed to a memoised child without invalidating it.
- [x] Lifecycle actions are raised by the runtime, in this order and no other: `Mounted` once per mount, then `PropsChanged`/`HookChanged` as ambient inputs change, then `Unmounted` once at teardown.
- [x] `PropsChanged` and `HookChanged` are detected **by value, during render** — props via `Schema.toEquivalence(propsSchema)`, hooks via `Equivalence.Record(Equivalence.strictEqual())` — and the state their handlers produce is what that same render draws. No extra render cycle, and no paint of the pre-change state.
- [x] `store.sync` is idempotent: called twice with equivalent props and hooks it raises nothing the second time, so a render React discards (StrictMode, Suspense retry, concurrent restart) costs nothing.
- [x] A defect from a command, or a feature `layer` that fails to build, reaches the `Error` handler; with no `Error` handler declared it is rethrown **during render**, which is the only place React's error boundary can catch it.
- [x] Services come from the root `ManagedRuntime` via context; `component(bp, { layer })` satisfies the residue `Exclude<R, RootR>`.

#### Store lifetime, and why it is split

The store **object** (state cell, subscribers, pending queue) is created in
`useState`'s initialiser and lives as long as the component instance. Its
**Effect scope** is opened by the mount effect and closed by that effect's
cleanup.

The split is forced by StrictMode. A store created in `useState` survives
React's simulated unmount → remount, so a single `dispose()` in the cleanup
leaves the remounted component holding a closed scope — every command after
that point forks into nothing and silently does not run. That is not the
cosmetic double-build already documented for the root runtime; it breaks
development outright. Splitting the two lifetimes makes a remount re-arm the
store, and state survives it, which is what React means by remounting the same
instance.

`Mounted` therefore fires once **per effect cycle** — twice in dev. Latching it
to once per store object was considered and rejected: it hides non-idempotent
`Mounted` handlers that will misbehave in production under Suspense and
offscreen remounts, which is the bug StrictMode exists to surface.

#### The fold is synchronous; only commands are Effects

`sync` returns the state to render, so a fold cannot round-trip through an
Effect queue — the value would arrive a render too late, which is the extra
cycle the whole design avoids. So every action folds in a plain function call:
read state, run the handler, write state, notify subscribers, fork the command.

A re-entrancy guard serialises them. Without it a command that emits on the
forking stack — `Stream.succeed`, which is exactly what `Command.output` is
today — re-enters the fold mid-write, and the outer fold writes stale state on
the way out. Actions arriving while a fold is on the stack queue behind it.

This is also why the machinery is **extracted rather than duplicated**.
`interpret`, `runGuarded`, `cancelGroup` and `groupId` become one internal core;
`run` is that core with a synchronous drain to quiescence, and the store is the
same core with a forked drain loop that never terminates. `Blueprint.run`'s own
JSDoc already names this the honest factoring, and the alternative is two
implementations of policy, group and cancellation semantics that must agree
forever. Every existing `run` criterion above must stay green through the
extraction — that suite is the safety net for it.

#### Feature layers are per mount

A layer passed to `component` is built when the store starts and released when
it stops. Consistent with `OwnershipRule`: anything that must survive a mount
belongs in the root layer, and building per mount makes that structural instead
of advisory. Three `<Cart>` mounts build three copies, and that cost is the
pressure that pushes genuinely shared services up to the root.

Memoising across mounts was rejected for the reason `OwnershipRule` gives:
service state would outlive the mount that created it — a store with extra
steps, reintroduced one layer down where nothing checks it — and nothing would
ever release it.

#### Teardown outlives the mount scope

`LifecycleHandlers.Unmounted` promises its command outlives the component and
dies only with the Provider. That was written when the root scope was the only
scope; a per-mount scope would interrupt the teardown command `stop()` had just
issued, making the handler useless for the one job it exists for.

Resolved by keeping the promise and ordering the teardown: `stop()` raises
`Unmounted`, forks its command into the **root** runtime's scope, and closes the
mount scope only once that command settles. Closing immediately was the literal
reading of the JSDoc and was rejected — it releases the feature's own layer out
from under a teardown command that needs it, which is precisely the feature that
had a reason to bring a layer at all.

#### Found by `/review-step`: the store's error path did not exist

Six confirmed defects, four of them reproduced by the reviewer against the
shipped code. Recorded rather than quietly patched, because five of the six were
invisible — no throw, no log, no failing test — and the shapes recur.

- [x] **A dying command reached nothing.** `runGuarded` forks the command and threw the fiber's `Exit` away, and a dying child does not propagate to its parent, so an enclosing `catchCause` could never see it — `interpret` has already returned by the time the command runs. Every runtime defect from a command (a failed fetch, a missing service, a bug in an `Effect`) vanished: no `Error` handler, no boundary, no log. Fixed with an `onExit` hook on `commandInterpreter`, filtered so interruption — which is how `restart` and unmount normally end a command — is not mistaken for a defect.
- [x] **`raiseDefect` queued an `Error` nobody drained.** It pushed onto `pending` without starting a fold, so a defect raised _outside_ an in-progress fold sat there until an unrelated dispatch happened to arrive — at which point it fired late and looked caused by that dispatch. Now it goes through `fold`, which queues behind a running fold and drains when there is none.
- [x] **A remount's `Mounted` command was stolen and killed.** The command queue was per store while the fiber draining it was per mount, so after `stop` the previous fiber was still parked on `Queue.take` and took the _next_ mount's command; the interrupt that followed killed it. A feature that loads its data on mount never loaded it in development. Fixed by making the queue, groups and in-flight counter per mount, so a stale fiber can only take from a queue nobody offers to again.
- [x] **Teardown ran without the services it needed.** `stop` forked teardown externally and read a `context` cell the mount fiber wrote, so a mount that ended before `Layer.build` resolved ran teardown unprovided — and the "release the lock" command died with a missing-service defect that was itself discarded. Fixed twice over: teardown is now delivered _in-band_ as a queue entry, so it runs on the fiber that owns the scope, and `context` is local to that fiber rather than a shared cell.
- [x] **A feature could swallow its caller's bug.** The `TypeError` for a missing `on<Tag>` prop was caught by `fold` and routed into the feature's own `Error` handler, so a feature with error handling absorbed it and transitioned into an error state instead of anyone finding out. It now goes straight to the boundary, like a bad prop.
- [x] **Three `runtime.runSync` calls ran during render.** Creating the queue and refs through the root `ManagedRuntime` forced its layer to build synchronously, which an async root layer cannot do — so the first mount of any feature would block or throw. All three are context-free, so they use the default runtime.

Two more were taken as written rather than argued with:

- [x] `sync` advanced its comparison baseline unconditionally, so a render React discarded left the committed render comparing new against new — losing the change rather than merely repeating it. The baseline now moves only when something moved. The residual is honest and unfixable from here: a discarded render that _did_ see a change still advances it. Equal-by-value objects are interchangeable, so keeping the older reference costs nothing.
- [x] `handlersRef.current = handlers` was a bare render-phase write with no commit-phase counterpart. Moved into an effect; outputs arrive on command fibers, i.e. after commit, so it is early enough.

Dead surface removed in the same pass: `createFeatureStore`'s `name` argument (required, never read), and `commandInterpreter`'s returned `cancelGroup` (no call site). `inFlight` stays — `run`'s quiescence check reads it, and the store must pass one for the shared interpreter to write.

**What this says about the process.** The node suite was green through all six. `/e2e` caught a seventh independently (the render-phase notify). The defects that survived to `/review-step` were all on the _error_ path, which is exactly the path unit tests written from acceptance criteria do not exercise — the criteria say what happens when things work.

#### `/review-step` iteration 2: the fixes had their own defects

Nine more, five of them in code written to fix iteration 1. Worth recording as a
pattern rather than a list: **every one was on the failure path the first pass
had just built**, which is the part with no happy-path test to keep it honest.

- [x] **The recursion guard was dead on arrival.** `onExit` reported every command defect with the constant `"Command"`, so `raiseDefect`'s `from === "Error"` check never fired for a command the `Error` handler itself forked — Error → command → defect → Error, unbounded, measured at ~5000 folds in 200ms. The synchronous-throw sibling _was_ guarded and tested, which is precisely why this looked covered. `interpret` already knew the issuing tag; the hook signature threw it away. Now `onExit` carries `ctx`.
- [x] **`queue` meant "share their fate".** `Fiber.joinAll` re-raises the prior's cause, so a dying command killed everything queued behind it before their bodies ran — and `onExit` then reported that one failure once per follower. Pre-existing in `runGuarded`; invisible until something started watching Exits. The join is now exit-only.
- [x] **A dead mount fiber left the store deaf.** Nothing cleared `mount` when the fiber died, so a failing layer meant every later dispatch — including the Retry the `Error` handler had just rendered — queued into a void, and `stop`'s teardown went to the same dead queue. Cleared in an `Effect.ensuring`, guarded on identity so a newer mount is not clobbered.
- [x] **Teardown ran one hop.** `stop` cleared `mount` immediately, so an `Unmounted` command that emitted an action whose handler returned _another_ command lost the second one — "close the session" ran, "release the lock" did not. `mount` now stays until the fiber returns, and the fiber drains its own teardown chain to quiescence before closing the scope.
- [x] **Joining teardown double-reported it.** Each fiber's `onExit` already reports its own failure; `joinAll` re-raising the same cause into the mount fiber had the terminal `catchCause` raise it again, and killed the fiber instead of letting it return normally.
- [x] **Commands dispatched before `start` were dropped.** `dispatch` reaches the subtree during render and React runs descendants' layout effects before this component's passive effect, so a child dispatching from `useLayoutEffect` folded before anything was armed: the state moved, the command vanished. Buffered and flushed by `start`.

Open, and deliberately not patched in this pass:

- [ ] `sync` writes the state cell after `useSyncExternalStore` has already read `getSnapshot`, so React's post-render consistency check can schedule the very re-render the render-body `sync` exists to avoid. The one-render browser test still passes, so the cost is not always paid — but the mechanism is real and the design's headline claim rests on it. Needs its own pass, probably `useSyncExternalStore`'s `getSnapshot` returning a value captured for the render rather than the live cell.
- [ ] `Command.batch` members share one `CommandContext`, so an outer `restart`/`ignore` wrapping a batch puts every member in one group — contradicting the criterion above that batch members each keep their own policy. Pre-existing in `run`, surfaced by reading the extracted interpreter.
- [ ] `create` derives the output-tag set twice: `Object.keys(spec.output.cases)` for the internals slot, `Object.hasOwn(spec.output.cases, tag)` in `run`. One rule, two spellings, in one closure.

#### Deferred, and recorded rather than silently absent

- [ ] `RuntimeOptions.onEvent` stays **declared and unwired** this pass; no `DevtoolsEvent` is emitted. Deferred deliberately: the `cause: { _tag: "Output", from, output }` variant needs a parent↔child channel that does not exist, and the obvious substitute — attributing whatever the parent dispatches next to the child's output — invents causality it cannot verify, since the handler may dispatch zero actions, three, or none synchronously. Wiring the other two `cause` variants and omitting the third was the runner-up. This box records the gap so the dead option is visible; it is not a criterion this pass satisfies.
- SSR: not applicable. This is a Vite SPA with a single `createRoot` entry and no server render, so `useSyncExternalStore` is used without `getServerSnapshot`. Revisit only if a server entry appears.

#### Found by the browser suite: `sync` notified subscribers during render

The render-body `sync` moved state and then notified subscribers, and the only
subscriber is `useSyncExternalStore` — so an ambient change scheduled a React
update _from inside a render_. React said so out loud ("Cannot update a
component while rendering a different component"), and only the browser suite
saw it: the node tests drive the store with no React attached, so nothing there
could notice.

Redundant as well as illegal. `sync` already hands the new state straight back
to the render that asked for it, so the paint is happening either way; the
notify could only ever have scheduled a second one — the extra render cycle this
whole design exists to avoid, reintroduced by the mechanism meant to prevent it.

Fixed with a `syncing` flag that suppresses notification for that window only.
Changes arriving from `dispatch` or a command fiber are outside render and still
notify. This is the concrete payoff of `/e2e` being mandatory for this pass
rather than skipped as "the node tests cover the fold".

- e2e: covered. `src/lib/tea.browser.test.tsx`, ten tests under `vitest.browser.config.ts` — initial paint, click-driven repaint, outputs crossing the boundary (both handler shapes), one-render props change, props identity churn raising nothing, StrictMode remount, `on`-prefixed declared props surviving the split, excess-prop rejection, and the missing-`on<Tag>` throw.

## Design decisions — command leaf (pending, not yet implemented)

Three decisions taken after reviewing Elm, Elmish (F#), Halogen (PureScript),
TCA (Swift) and the Redux effect libraries. They change the `Command` surface,
so the acceptance criteria above are annotated for what moves. Recorded here
before implementation so the reasoning survives the change.

### 1. The command leaf is an `Effect` handed a `dispatch`, not a `Stream`

`Command`'s `Stream` variant is replaced by an `Effect` that receives `dispatch`
as a parameter:

```ts
Command.effect((dispatch) =>
  Effect.gen(function* () {
    yield* dispatch(Started());
    const items = yield* api.fetch(id);
    yield* dispatch(Loaded({ items }));
  }),
);
```

**The ADT stays.** `None`/`Batch`/`Cancel`/`Guarded` are orthogonal to the leaf:
policy, group and cancellation have nowhere to attach on a bare `Effect`, and
`interpret` walks them. Only the leaf payload changes, so the blast radius is
two sites — `interpret`'s `"Stream"` case and `Command.output`.

**Nothing is lost.** A long-lived stream is one line inside the effect —
`Stream.runForEach(socket, dispatch)` — so `Stream.merge`, `Stream.callback`,
`Stream.debounce` and `Schedule`-based retry remain available exactly as before.
What is gained is sequencing: "dispatch, await, dispatch, branch on the result"
is straight-line code where the `Stream` form needed `concat`/`merge`/`catchAll`
gymnastics. Conditional emission, loops, early return and `acquireRelease`
around a subscription all become ordinary.

**Prior art is unanimous, and one implementation ran this exact experiment.**
Elm's `Cmd msg` is a one-shot `Task` plus a `Result -> Msg` function, not a
stream. Elmish's is literally `Dispatch<'msg> -> unit`, batched as a list.
Halogen's `handleAction` is monadic with `H.subscribe`/`H.fork` inside it. TCA
shipped `Effect<Action>` as a Combine `Publisher` — the design here — and
replaced it in 1.0 with `Effect.run { send in … }`, keeping `.cancellable(id:)`
and `.cancel(id:)`. Of the Redux family, the stream-native option
(redux-observable) is the least adopted; the dispatch-callback (thunk) and the
generator-with-`put` (saga) options dominate, and saga's
`takeLatest`/`takeEvery`/`takeLeading` are this file's `restart`/`parallel`/
`ignore` under other names.

**Why the callback parameter and not an ambient service.** The alternative was a
per-feature `Context.Tag` created inside `define`, putting `dispatch` in `R`.
Rejected on three counts. It makes dispatch ambient, so any service in `R` could
require the tag and dispatch into a feature from anywhere — a message bus with
extra steps, which is what the outbound-channel design exists to prevent. The
tag has identity, so hot-reloading `define` mints a new one while in-flight
commands hold the old. And it pollutes `R`, requiring an `Exclude` by brand
layered onto the `ServicesOf` walk that is already documented as fragile. The
callback reaches only where it is handed, keeps `Command<A, R>` intact so
`ServicesOf`/`Next`/`Emit` are untouched, and lets the interpreter close over
the issuing action's tag — which makes `DevtoolsEvent.cause` attribution easier
rather than harder. Anyone wanting ambient dispatch can still build it locally
with `Effect.provideService` from the parameter.

**Variance.** `Dispatch<A> = (a: A) => Effect<void>` is contravariant in `A`, and
sits in parameter position of the callback — contravariant again. The two
compose to **covariant**, so `Command<OrderPlaced>` remains assignable to
`Command<Emit<A, O>>` and `Command.none: Command<never>` remains the bottom,
exactly as with `Stream<A>`. (An earlier reading of this concluded the opposite
and was the main argument against the callback form.)

### 2. One `dispatch`, routed by tag — no `raise`, no `Command.output`

`dispatch: (action: Emit<A, O>) => Effect<void>` accepts both vocabularies, and
the runtime decides from `_tag` whether the message re-enters the reducer or
leaves as an output.

This is already how routing works: `isOutput` (`tea.ts:1168`) tests
`action._tag in spec.output.cases`, `step` (`tea.ts:1278`) branches on it, and
`Command.output` (`tea.ts:645`) is already only sugar for
`Command.stream(Stream.succeed(message.make(payload)))`. The outbound brand on
`Command.output`'s parameter never affected routing — an output constructed by
hand and passed to `Command.stream` routes correctly today.

So the check that a second `raise` function would provide — rejecting an
internal message on the outbound path — guards a mistake that only exists
because the second function exists. With one `dispatch` that program cannot be
written, which is strictly better than catching it. TCA reaches the same place
from the other direction: outputs there are the Delegate pattern, a nested case
in the same action enum sent through the ordinary `send`, with the channel
carried by the action's identity rather than by a second verb. Halogen keeps
`H.raise`, but Halogen has no vocabulary-level channel brand — the function is
its only channel marker.

**The channel brand still earns its keep**, just not at the command call site.
Its load-bearing jobs are at declaration time: `ChannelOf` inferring a
vocabulary's channel (`tea.ts:160`), `SameChannel` rejecting a mixed member list
(`tea.ts:177`), `define({ action: SomeOutputVocabulary })` failing, and
`Disjoint`/`OutputProps` staying derivable.

**Cost, accepted:** `raise(OrderPlaced(…))` states in local text that the line
crosses the boundary; `dispatch(OrderPlaced(…))` requires knowing which
vocabulary the tag belongs to. Mitigated by the channel being declared in one
place (`Action.output`), surfaced at the boundary as an `on<Tag>` prop, and
labellable in devtools since routing is by tag regardless.

**Lifecycle tags stay unreachable.** `Emit<A, O>` is `MemberOf<A> | MemberOf<O>`
and lifecycle tags are in neither vocabulary, so the inbound-only guarantee is
unchanged.

### 3. Subscriptions stay in commands — for now

Elm and Elmish put long-lived streams in a separate `subscriptions(model)`
function, diffed by id, so lifetime is derived from state rather than commanded.
Halogen and TCA instead keep imperative handles (`SubscriptionId`/`ForkId`,
`cancellable(id:)`). This design follows the latter. **Deferred, not rejected** —
sequenced after the leaf change, because the leaf is two sites and no new
concepts while the split is a new slot, a diff engine, a `run` contract change
and a new `DevtoolsEvent.cause` variant.

The argument for eventually splitting, recorded so it is not lost: a long-lived
resource is currently named by the accident of what started it. `Group.tag` is
the issuing action's tag, filled by the runtime, so a socket opened at mount is
`Mounted::socket`. Two consequences follow.

- **`run` cannot terminate with a subscription.** The drain loop (`tea.ts:1293`)
  breaks on `queueSize === 0 && inFlightCount === 0`; `runGuarded` increments
  `inFlight` and only decrements after `Fiber.await` settles. A stream that never
  completes pins `inFlight` at 1, so the loop falls through to `Queue.take` and
  blocks forever (or spins, if the stream emits periodically). **Needs a
  regression test to confirm** — see Technical Requirements.
- **Devtools attribution collapses.** Every message from a long-lived stream is
  `cause: { _tag: "Command", action: "Mounted" }`, because everything long-lived
  starts at mount.

The cheap partial — making `Group.tag` settable so a command names its own group
instead of inheriting the issuing tag — fixes attribution and `Cancel`
legibility for one field, but does not fix `run`: a never-ending fiber still
pins `inFlight`. Fixing that means marking those fibers long-lived and excluding
them from quiescence, which is introducing the `Cmd`/`Sub` distinction
implicitly. If the distinction has to exist, it belongs in the type.

Regardless of the split, the drain loop should grow a step budget — it is
currently unbounded.

### Downstream consequence: the policy surface probably shrinks

Once commands sequence, `queue` is `yield*` awaiting the prior work, `ignore` is
a state flag plus a reducer early-return (which Elm forces, and which makes
state honest about what is running), and `parallel` is the absence of a policy.
Only `restart` cannot be expressed in userland — it interrupts a fiber that a
_later_ action did not start. That leaves `restart` + `Cancel`, which is exactly
what TCA ships. Not decided; flagged for after the leaf change lands.

### Effect on the acceptance criteria above

- `Command.stream(stream)` — **removed.** Replaced by
  `Command.effect((dispatch) => Effect<unknown, never, R>)`; the previous
  `Command.effect` (run for effects, emit nothing) is the same constructor with
  an unused parameter.
- `Command.output(message, payload)` — **removed**, including its
  compile-error-on-internal-message criterion. Superseded by
  `dispatch(OrderPlaced.make(…))`.
- Every `run` criterion about actions/outputs a command emits still holds
  verbatim; only the mechanism by which a command emits changes.
- The policy, `Cancel`, `batch` and quiescence criteria are unaffected.
- Type-level: `Command`'s `Pipeable` criterion still holds and gains a variance
  case — `Command<Narrow>` must remain assignable to `Command<Wide>` under the
  callback encoding.

## Technical Requirements

- Runtime tests use plain `vitest` (`describe`/`it`) with `Effect.runPromise`. No `@effect/vitest` — not installed, not used elsewhere in this repo.
- Concurrency-policy tests (`restart`/`ignore`/`queue`/`parallel`) exercise the real scheduler with short `Effect.sleep`/`Ref`/`Deferred` timing rather than `TestClock`, matching how the (now-deleted) ad-hoc smoke test verified them.
- Type-level guard tests use TSTyche (`tstyche.json` + `src/lib/__type-tests__/tea.tst.ts`), introduced by this pass — no `tstyche.json` exists anywhere in the repo yet.
- The suspected `run` non-termination on a never-completing command (see _Design decisions_, §3) needs a test with an explicit timeout — a plain `it` would hang the suite rather than fail it. Write it against the current `Stream` leaf so the behavior is pinned before the leaf changes.
- The React binding is built against the **current** `Stream` command leaf. The pending leaf redesign touches `interpret`'s `"Stream"` case and the constructor only; extracting the core moves that case without changing it, so the two passes stay independent and neither blocks the other.
- Binding tests split by what they need: fold, routing, lifecycle ordering and store lifetime are `jsdom` unit tests driving `createFeatureStore` directly with no React; anything about render counts, error boundaries or actual paint is `/e2e`.
- `@testing-library/react` is not installed and is not used elsewhere in this repo. Unit tests drive the store directly; the browser tests mount through the real DOM, matching how the existing `src/examples/*` demos are exercised.

## Expected Behavior & Edge Cases

### First pass (reducer core)

- Not applicable: `/mock` — a real implementation of everything in scope already exists; nothing to stub.
- Not applicable: `/e2e` — this file is the pure Effect/reducer core with no DOM. The React binding (`createRuntime`, browser-observable behavior) is out of scope for this pass.

### React binding pass

- `/mock` is already satisfied: `FeatureStore`, `BlueprintInternals` and the three `declare`s are the mock surface, written with full JSDoc in `tea.ts` before this spec existed. `/implement` replaces them in place with signature parity.
- `/e2e` is **mandatory** here, unlike the first pass: the whole point of this layer is browser-observable. A real-browser test must cover at minimum a mount that renders initial state, a `dispatch` that repaints, an `on<Tag>` output reaching a parent, and a props change repainting on one render rather than two.
- The `internals` symbol landing as a real `Symbol` is load-bearing for _every_ criterion in this section — nothing else in the binding can run until it does — so it is the first thing `/implement` fixes.
- Extraction risk: the shared core must keep all 1437 lines of the existing `run` suite green, including the pinned non-termination test. A green `run` suite after extraction is the acceptance gate for the refactor itself, separate from the new criteria.
- The mount effect's cleanup is async in effect (it awaits the teardown command before closing the scope) while React's cleanup is synchronous. `stop()` therefore returns immediately and drains on a fiber; a component that remounts before the drain finishes must not have its new scope torn down by the old one's completion.
