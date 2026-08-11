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
- [ ] `Command.batch(...commands)` runs each member independently, each keeping its own policy.
- [ ] `Command.cancel(target)` interrupts a running group, addressed by tag only or by `{ tag, key }`.
- [ ] `Command.output(message, payload)` emits an outbound message as a one-shot stream; passing an internal message is a compile error.
- [ ] `Command.restart(key?)`, `.ignore(key?)`, `.queue(key?)` wrap a command in a `Guarded` policy node; all three are `Pipeable` (`cmd.pipe(Command.restart())`).
- [ ] Nesting `Guarded` wrappers: the outermost policy wins (an inner `Guarded` is not overridden if an outer one already set a policy for the same dispatch).

### `Next` accessors

- [ ] `Next.state(next)` returns the state whether `next` is a bare state or a `[state, command]` tuple.
- [ ] `Next.command(next)` returns the command for a tuple, `undefined` for a bare state.

### `define(...).create(...)` → `Blueprint.reduce`

- [ ] `reduce` dispatches by `_tag` to the matching reducer handler (declared action or lifecycle action) and returns its `Next`.
- [ ] **Unhandled _lifecycle_ actions leave state unchanged and do not throw.** (Bug fix — see below.)
- [ ] A missing handler for anything that is _not_ a lifecycle tag (reachable only by bypassing the typed `dispatch`/`reduce` surface, e.g. a bad cast) still throws — the no-op is specific to `LifecycleTag`, not "any missing handler." (Caught during `/review-step`: an earlier version of the fix no-opped unconditionally, silently swallowing this case too.)
- [ ] Dispatching `{ _tag: "Unmounted" }` runs the `Unmounted` handler if declared but the _returned state_ is discarded — only its command matters. (Testable directly via `reduce`, no mounting required.)

### `define(...).create(...)` → `Blueprint.run`

- [ ] Seeded actions (from the `actions` iterable passed to `run`) are processed but are not themselves recorded in `emitted`.
- [ ] Actions/outputs a command's effect/stream emits during the run are fed back into the reducer loop.
- [ ] `emitted` collects every non-output action that arrived via a command (not seed actions, not outputs).
- [ ] `outputs` collects every message whose tag is in the declared output vocabulary's `cases`; an output never re-enters the reducer and never appears in `emitted`.
- [ ] `Command.batch` members run independently — each keeps its own concurrency group/policy.
- [ ] `Command.cancel({ tag })` (no `key`) interrupts every running group under that tag; `Command.cancel({ tag, key })` interrupts only that specific group.
- [ ] Policy `"restart"`: a new dispatch into the same group interrupts the prior in-flight fiber.
- [ ] Policy `"ignore"`: a new dispatch into the same group is dropped while one is already in-flight.
- [ ] Policy `"queue"`: a new dispatch into the same group waits for the prior to settle before running; both eventually complete.
- [ ] Policy `"parallel"` (the default, i.e. no `Guarded` wrapper): concurrent dispatches into the same group all run concurrently and all complete.
- [ ] Services requested by a command's effect/stream (`R`) are satisfied from `options.layer` via `Effect.provide`.
- [ ] `run` resolves only once quiescent: nothing queued and nothing in flight (including fibers that settle without ever emitting, e.g. a bare `Command.effect` or an interrupted group).

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

### Type-level guards (exercised via TSTyche, not vitest)

- [ ] `Disjoint<A, O>` is a compile error when an action tag and an output tag collide.
- [ ] `NoPropCollision<PropsSchema, O>` is a compile error when a declared prop name collides with a derived `on<OutputTag>` name.
- [ ] `NoTransform<PropsSchema>` is a compile error when a props schema's `Encoded` differs from its `Type` (a transforming/decoding props schema).
- [ ] `Exhaustive<U, State>` / `Excess<N, State>` catch a reducer handler returning a state object with a key not present in the declared state schema.
- [ ] `ServiceOf`/`ServicesOf` union services across multiple reducer handlers' return types without collapsing to `never` (the exact regression this type exists to prevent).
- [ ] `OutputProps<Output>` derives one required `on<Tag>` prop per output case, with `_tag` stripped from the payload type.
- [ ] `Command`'s `Pipeable` typing: `cmd.pipe(Command.restart())` preserves the command's `A` and `R` type parameters.

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
