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

**Out of scope for this spec and its downstream steps:** `createRuntime` and
its returned `{ Provider, component, useRuntime }` — the one `declare const`
left in the file, i.e. the React binding layer. Everything else with a real
implementation is in scope, including the type-level guards that encode real
invariants (`Disjoint`, `NoTransform`, `NoPropCollision`, `Exhaustive`/
`Excess`, `ServiceOf`/`ServicesOf`).

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

## Expected Behavior & Edge Cases

- Not applicable: `/mock` — a real implementation of everything in scope already exists; nothing to stub.
- Not applicable: `/e2e` — this file is the pure Effect/reducer core with no DOM. The React binding (`createRuntime`, browser-observable behavior) is out of scope for this pass.
