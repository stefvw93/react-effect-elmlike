# tea.ts — TEA-style feature runtime core

## Overview & Purpose

A feature is declared as a **blueprint**: schema-typed props and state, a tagged
action vocabulary, an optional outbound output vocabulary, optional ambient
hooks, and a reducer. The reducer is pure — it returns the next state and,
optionally, a `Command` describing work to do. The runtime interprets commands
as Effects.

Three consumers, one core:

- `blueprint.reduce(action, snapshot)` — the reducer as one pure function. No
  React, no Effect runtime.
- `blueprint.run(actions, options)` — folds a sequence to quiescence and reports
  what was emitted. No React.
- `component(blueprint)` — the React binding, over `createFeatureStore`.

`reduce`, `run` and the store share one command interpreter. Two
implementations of grouping and cancellation would have to agree forever.

## `children`, as an opaque prop

Props are schema values: validated, never decoded, `Encoded` equal to `Type`.
A React node is none of those things — it does not encode, it is a fresh object
on every parent render, and printing one into a devtools event dumps an element
tree. So `children` is _declared_ rather than described:

```ts
const Props = Schema.Struct({ children: Children });
```

`ReactNode` is the default, not a restriction. React lets a component call its
children as easily as render them, so `Children.as<T>()` is the same declaration
at whatever type the feature accepts:

```ts
children: Children.as<(row: Row) => ReactNode>(); // a render prop
```

The type argument is the whole contract — nothing in the runtime reads the
value, so there is no shape for the schema to check and none for it to lie
about.

Required, as written: a feature that cannot render without children says so, and
a call site that passes none is a compile error. `Schema.optionalKey(Children)`
is the optional form. There is no third state — JSX that passes no children (a
comment counts as none) omits the key entirely, so a required `Children` throws
`Missing key` if the type error is ever bypassed.

`Children` is `Schema.declare` with three deliberate properties:

- **It validates anything.** A function's shape is unobservable, `ReactNode` is
  wide and recursive — elements, iterables, thenables — and React already owns
  the question of what it can render. A schema-side re-derivation could only
  disagree with the renderer.
- **It is invisible to change detection.** Its `toEquivalence` annotation is
  constantly `true`, so new children alone never raise `PropsChanged`. Without
  it, a declaration's default equivalence is `Equal.equals` — by reference — and
  every parent render would re-run the reducer.
- **It is redacted in devtools**, to `"<children>"`, by `reportableAction`. Only
  there: `snapshot.props.children` in a reducer is the real node.

The consequence of the second point, accepted: when only children change, the
store keeps its previous `props` object, so a reducer's
`snapshot.props.children` can be the node from an earlier render. `render` is
unaffected — it reads the component's own props, so it always has the current
node. Children are for rendering, not for reducing.

The mechanism is one annotation key, `"@tea/opaque"`, whose value is the
placeholder. `define(...).create` collects the annotated fields off the props
schema once and stores them in the blueprint's internals; a feature that
declares none pays nothing at the report site. `Schema.optional(x)` is
`optionalKey(UndefinedOr(x))`, so the collection also looks one level into a
union.

`children` is the only opaque prop the library ships. A general
`opaque<T>(placeholder)` combinator — the same mechanism exposed for callbacks,
refs, DOM nodes — was built and withdrawn: the annotation and the collection are
already general, so promoting them is a one-line change if a second caller ever
turns up. Until then the surface says what it means.

Opaque declarations are **props-only, enforced**: redaction covers
`PropsChanged.previous`, while a `Transition`'s state is reported verbatim, so
a state schema declaring `Children` would put raw ReactNodes into every event.
`define` throws on one rather than silently breaking the devtools
encodability contract.

## The command model

A `Command` is a small ADT. The leaf is an `Effect`; everything Effect can
already express is left to Effect.

```ts
type Command<A, R> =
  | { _tag: "None" }
  | { _tag: "Effect"; effect: (dispatch: Dispatcher<A>) => Effect<unknown, never, R> }
  | { _tag: "Keyed"; key: string; command: Command<A, R> }
  | { _tag: "Batch"; commands: ReadonlyArray<Command<A, R>> }
  | { _tag: "Cancel"; target: Group };

// `Dispatcher`, not `Dispatch`: the latter is the React-facing dispatch handed
// to `render`, which returns void because it is called from an event handler.
type Dispatcher<A> = (action: A) => Effect<void>;
type Group = string;
```

**Groups are one flat namespace per mount.** A `Group` is a string name, not a
`{ tag, key }` pair. `keyed(name)` sets a command's whole address — outermost
wins, unchanged — and an unkeyed command books under its issuing action's tag,
so the booking address is always `key ?? tag`. `cancel(name)` interrupts that
one group. A key equal to some action's tag is not a collision to defend
against; it is deliberate sharing — one namespace means one meaning per name.
The semantic narrowing to document: bare-tag `cancel("Tag")` reaches only the
**unkeyed** fibers of that tag, because keyed work is addressed by its own name
only.

**Concurrency is userland.** Debounce, throttle, switch-to-latest, run-at-most-N
— all of them are Effect combinators the handler writes inside its own effect.
The runtime has no policy vocabulary, because Effect already has one and a
second one written as data can only be a worse copy.

**What the runtime does own** is the one thing a handler cannot do for itself:
naming a running fiber so that a _different_ action's handler can interrupt it.
That is `Keyed` + `Cancel`, and it is the whole supervisor.

**Take-latest is sugar, not a variant.** `Command.restart(name, command)` is
definitionally `Command.batch(Command.cancel(name), Command.keyed(name,
command))` — the 80% pattern written as one word, without the ordering mistake
hand-writing the pair invites. No new ADT variant, no interpreter branch, no
new `CommandSummary` member: devtools show the desugared batch honestly.

`Batch` sequences commands. After the leaf change its one irreplaceable job is
putting a `Cancel` before the command that replaces it — the cancel has to run
before the new fiber is registered, and nothing inside that fiber can do it.
Composing two _effects_ is `Effect.all`, not `Batch`.

```ts
// restart-on-keystroke — take-latest as one word
TextEdited: (action, { state }) => [
  { ...state, text: action.text, pending: true },
  Command.restart(
    "query",
    Command.effect((dispatch) =>
      Effect.sleep("300 millis").pipe(
        Effect.andThen(search(action.text)),
        Effect.flatMap((hits) => dispatch({ _tag: "HitsArrived", hits })),
      ),
    ),
  ),
  // ≡ Command.batch(Command.cancel("query"), Command.keyed("query", …))
];

// two effects, one fiber
Added: (action, { state }) => [
  next,
  Command.effect(() => Effect.all([persist(next), track(action)])),
];

// a long-lived subscription
Mounted: (_action, { props, state }) => [
  { ...state, connected: true },
  Command.effect((dispatch) =>
    Stream.runForEach(presenceEvents(props.roomId), (event) => dispatch(toAction(event))),
  ),
];
```

## Acceptance Criteria

`[x]` holds today. The command-leaf pass landed, and what it did not do is in
Open work and Deferred decisions rather than left as an unchecked criterion
here. The devtools pass closed the last two (its criteria live in
`devtools.specs.md`), and the flat-group-namespace + `Command.restart` pass
landed with every box checked again.

### Vocabularies (`Action`, `Action.output`, `Action.of`)

- [x] `Action("Tag", fields)` / `Action.output("Tag", fields)` constructs a `Schema.TaggedStruct` branded with its channel (`"internal"` vs `"outbound"`).
- [x] `Action.of([...])` builds a branded tagged union exposing `cases`, `guards`, `match`, `mapMembers`, and a `make` per case.
- [x] `Action.of` infers the channel from its members' brand; there is no per-channel `of`.
- [x] `Action.of` rejects a member list mixing channels, at the call rather than at `define`.
- [x] A vocabulary built with `.of` nests inside another `.of`, and the outer `cases` include the flattened inner tags.
- [x] The channels are not mutually assignable in either direction.
- [x] A reserved `LifecycleTag` (`Mounted`/`PropsChanged`/`Error`/`Unmounted`/`HookChanged`) as a message tag is a compile error.

### `Command`

- [x] `Command.none` is the `{ _tag: "None" }` no-op.
- [x] `Command.effect((dispatch) => Effect<unknown, never, R>)` is the only leaf. A command that emits nothing ignores the parameter.
- [x] `Command.stream` and the `Stream` variant are removed. A long-lived source is `Stream.runForEach(source, dispatch)` inside the effect, so the whole `Stream` vocabulary stays available one call earlier.
- [x] `Command.keyed(key, command)` names the group a command's fibers book under — the whole address, outermost wins. Also curried (`Command.keyed(key)`) and so pipeable. An unkeyed command books under its issuing action's tag.
- [x] `Command.ignore`, `Command.queue`, the `Policy` type and the `Guarded` node are removed.
- [x] `Command.restart(name, command)` returns — as pure sugar, not a policy: it constructs exactly `Command.batch(Command.cancel(name), Command.keyed(name, command))`. Also curried (`Command.restart(name)`) and so pipeable.
- [x] `Command.batch(...commands)` interprets its members in order under one context. With no policy there is no supersession question and nothing to decide.
- [x] `Command.cancel(name)` interrupts the one group booked under `name`, whatever action tags forked its members. The fiber book is a flat map by name — no tag level, no delimiter encoding.
- [x] Bare-tag `cancel("Tag")` reaches only the **unkeyed** fibers of that tag; work forked under `keyed(name)` is addressed by `name` alone.
- [x] Cancelling work started from several action tags under one `keyed(name)` is one line — `cancel(name)` — naming no foreign tag.
- [x] `Command.output(message, payload)` emits an outbound message; passing an internal message is a compile error. _Re-expressed on the new leaf internally; signature unchanged. Removing it is deferred — see Deferred decisions._
- [x] Commands are `Pipeable`, and piping preserves `A` and `R`.

### `Next` accessors

- [x] `Next.state(next)` returns the state whether `next` is a bare state or a `[state, command]` tuple.
- [x] `Next.command(next)` returns the command for a tuple, `undefined` for a bare state.

### `Blueprint.reduce`

- [x] Dispatches by `_tag` to the matching handler (declared or lifecycle) and returns its `Next`.
- [x] An unhandled _lifecycle_ action leaves state unchanged and does not throw.
- [x] A missing handler for anything that is not a lifecycle tag throws — reachable only by bypassing the typed surface.
- [x] Every tag-keyed lookup uses `Object.hasOwn`, so `constructor`/`toString` and the rest of `Object.prototype` cannot pose as handlers, lifecycle tags, or declared outputs.
- [x] `Unmounted`'s handler runs but its returned state is discarded — only its command matters. `reduce` and `run` agree on this.

### `Blueprint.run`

- [x] Seeded actions are processed but are not recorded in `emitted`.
- [x] Actions a command emits feed back into the reducer loop; `emitted` collects them.
- [x] `outputs` collects messages whose tag is a declared output; an output never re-enters the reducer.
- [x] `Command.cancel(name)` interrupts the group booked under `name`; an unkeyed command's group is its issuing action's tag.
- [x] `Command.batch` members run in order, sharing the issuing action's context.
- [x] Services a command requests (`R`) are satisfied from `options.layer`.
- [x] `run` resolves only at quiescence: nothing queued, nothing in flight — including fibers that settle without emitting.
- [x] **`run` does not terminate on a never-completing command**, and its test asserts that deliberately. See Known limitations.

### React binding (`createRuntime` → `component`)

- [x] `Blueprint` carries its internals behind a module-private `unique symbol`; `reduce` and `run` remain the entire public surface.
- [x] `component(blueprint)` renders `render({ state, props, hooks, dispatch })` and re-renders when a command changes state.
- [x] Incoming props are split by derived name (`outputTags.map(t => "on" + t)`), so a declared prop merely starting with `on` is left alone.
- [x] `validateProps` runs the schema with `onExcessProperty: "error"` and **throws** — a malformed prop is the parent's defect and belongs at the error boundary. It runs on mount and on props-identity change, not on a state-driven re-render.
- [x] An output leaves through its `on<Tag>` prop with `_tag` stripped and never re-enters the reducer; a missing handler throws to the boundary rather than into this feature's `Error` handler.
- [x] `Children` is a props field that validates any value, so a feature can declare `children` and still be validated with `onExcessProperty: "error"`. Declared plainly it is required — the key is absent, not `undefined`, when JSX passes no children — and `Schema.optionalKey(Children)` is the optional form.
- [x] `Children.as<T>()` is the same declaration at any children type — a render prop, one element, a tuple of slots. It is opaque on identical terms, and the type argument is the only thing holding the caller to the contract.
- [x] `Children` carries a constantly-`true` equivalence, so a new node alone never raises `PropsChanged` and never re-runs the reducer. The corollary — a reducer's `snapshot.props.children` may be stale — is accepted, and `render` is unaffected.
- [x] The props carrying the `"@tea/opaque"` annotation are collected off the props schema at `create`, whether the key is declared directly, through `Schema.optionalKey`, or through `Schema.optional` (a union). A feature declaring none collects `[]`.
- [x] `PropsChanged`'s reported `previous` has each opaque prop replaced by its placeholder (`"<children>"`), which is what keeps every devtools event JSON round-trippable. The reducer's snapshot keeps the real node; a feature with no opaque props reports the action unchanged.
- [x] `dispatch` accepts only declared actions and is reference-stable for the life of the mount.
- [x] Lifecycle order: `Mounted` once per mount, then `PropsChanged`/`HookChanged` as ambient inputs change, then `Unmounted` at teardown. _With one uncovered window: a props change landing between the first render and the mount effect buffers its command ahead of `Mounted`'s. See open work #5._
- [x] `PropsChanged`/`HookChanged` are detected **by value** — props via `Schema.toEquivalence`, hooks via `Equivalence.Record(Equivalence.strictEqual())`.
- [x] `store.sync` folds during render, so a props-driven change paints on the render that carried the props. Moving the fold into an effect is **deferred** — see Deferred decisions.
- [x] `store.sync` is idempotent: called twice with equivalent props and hooks it raises nothing the second time, so a discarded render costs nothing.
- [x] A defect from a command, or a feature `layer` that fails to build, reaches the `Error` handler; with none declared it is rethrown during render, the only place a boundary can catch it.
- [x] Services come from the root `ManagedRuntime`; `component(bp, { layer })` satisfies the residue `Exclude<R, RootR>`.
- [x] `createRuntime` takes **one** parameter. `RuntimeOptions` and its unwired `onEvent` are removed; observation is a service installed through the root layer instead. Spec'd in `devtools.specs.md`.
- [x] The store reports transitions, commands issued, outputs emitted and defects to a synchronously-resolved `Devtools` sink, and allocates nothing at those sites when no sink is installed. Emission points are listed in `devtools.specs.md`.

### Type-level (TSTyche)

- [x] `Disjoint`, `NoTransform`, `NoPropCollision`, `Exhaustive`/`Excess`, `ServiceOf`/`ServicesOf` reject what they document and accept what they document.
- [x] `NoTransform` accepts a props schema declaring `children: Children` — `Schema.declare` is an identity codec — and the field surfaces to `initialState`, the reducer and `render` as `ReactNode`, optional under `Schema.optionalKey` and as the given function type under `Children.as<T>()`.
- [x] `Command<Narrow>` stays assignable to `Command<Wide>` under the callback leaf, and `Command.none: Command<never>` stays the bottom. `Dispatcher<A>` is contravariant in `A` and sits in a parameter position — contravariant again — so the two compose to covariant. **The existing covariance test passes unchanged.**
- [x] `Command.effect` carries `R` out of the effect it is handed. `A` has no inference site of its own, so it defaults to `never`: a command that emits nothing is `Command<never, R>` and fits every slot. Passing a bare `Effect` — the pre-redesign shape — no longer compiles, and neither does an effect with an open error channel.
- [x] Inside a handler, `dispatch` is typed by the feature's own vocabulary: `A` arrives from the contextual type of the handler's return. An undeclared tag and a declared tag with the wrong payload are both compile errors.
- [x] `Command.keyed` preserves `A` and `R`, through `.pipe`, applied directly, and nested. The key is a required string.
- [x] `Command.batch` preserves `A` and `R`, and a `Command<never>` member — the `Cancel` the variant exists to sequence — does not collapse the batch to `never`.
- [x] `Command.cancel` is `Command<never>` and takes exactly one string. An object target — `{ tag }` or `{ tag, key }` — is a compile error, as are a number and a zero-argument call.
- [x] `ignore`/`queue`/`stream` are absent from the constructor set, and the `Stream` and `Guarded` variants are absent from the ADT.
- [x] `restart` is a constructor-set member, not an ADT variant, and preserves `A` and `R` in both forms. The two-argument form keeps contextual `A` (the same rule as `keyed`); the `.pipe` form severs it, pinned with `@ts-expect-error` on identical terms.

**How `A` reaches the leaf.** `A` appears only inside `Dispatcher<A>`, in a
parameter position, so nothing in the argument can infer it — it is resolved from
the contextual type of the call, which the reducer's return type supplies through
`create`'s `U extends Reducer<…>` constraint. Written standalone, with no
contextual type, `A` falls back to `never` and `dispatch` accepts nothing; the
call site names it (`Command.effect<Action>(…)`). The spec's examples rely on the
contextual path, and a type test compiles each of them to say so.

Two consequences the surface had to absorb, both found by compiling the example
above rather than by reasoning about it:

- **`Command.cancel` is generic in `A`, defaulting to `never`.** A concrete
  `Command<never>` argument is an inference source at higher priority than the
  contextual return type, so a cancel written _first_ in a batch — the position
  `restart` desugars into — fixed the batch's `A` to `never` before the sibling
  leaf was checked, and `dispatch` accepted nothing. Generic-with-a-default, the
  cancel adopts the batch's `A` instead of pinning it, and standalone — the
  cross-tag one-liner — it is still `Command<never>`.
- **`Command.keyed` takes `(key, command)` as well as `(key)`.** A `.pipe`
  receiver is checked before `.pipe`'s own contextual type exists, so
  `Command.effect((dispatch) => …).pipe(Command.keyed("q"))` severs the
  contextual path no matter what — a TypeScript rule about receivers, not
  something this surface can fix. The two-argument form puts the leaf in an
  argument position, where the contextual type reaches it. Piping still
  type-preserves and is still the right form for a command whose `A` is already
  fixed; it just cannot _carry_ inference.

Consequence for the tests: `expect(fn).type.toBeCallableWith(arg)` types `arg` on
its own, without the contextual type of the signature under test, so every
context-sensitive callback inside one collapses to `never`. Assertions about
contextual inference are therefore written as direct calls plus
`@ts-expect-error`, not as that matcher — otherwise they measure the matcher.

### Browser coverage (`/e2e`)

`src/lib/tea.browser.test.tsx` covers the React binding: that a blueprint paints,
that a real click repaints, that an output crosses into a parent's `on<Tag>`
prop. Nothing in the leaf change alters any of that, and it still passes
unchanged — which is the point of running it.

It also covers both halves of `Children` together, which only a browser can
show: a parent passes a node that changes on every tick, the node reaches the
DOM and stays current, and the reducer's `PropsChanged` never fires. A second
test mounts a render prop — children the feature _calls_, with state only it
has — and repaints it from a dispatch.

`src/examples/search.browser.test.tsx` is the leaf change's own browser test, and
search is the right demo for it: the debounce is only meaningful against real
typing, where each keystroke is a separate event and the interrupt lands between
them. It asserts through a counting fake service that four keystrokes inside one
window send exactly one query — the behaviour the old `"restart"` policy
provided, then a hand-written `Cancel` ahead of a `keyed` leaf, and now
`Command.restart` — sugar for exactly that pair. The suite must pass unchanged:
the sugar changes spelling, not behaviour.

- e2e: not applicable for `src/examples/cart.tsx` and `src/examples/presence.tsx`
  — **neither can be mounted in any environment.** Both declare their ambient
  hooks (`useCatalog`, `useOnlineStatus`, `usePageVisible`) with `declare
function` and no implementation, deliberately: they are illustrations of the
  boundary, not runnable demos, and `main.tsx` never mounts them. The `declare`s
  are module-private, so a test cannot inject past them either. Their commands
  are covered headlessly instead — `cart.tsx` ships
  `checkoutAnnouncesTheOrder`, a `blueprint.run` assertion, as its own
  documented test story. Making them mountable means writing demo behaviour that
  does not exist today, which is a change to what the examples _say_, not a
  migration of how they say it.

## Technical Requirements

- Effect 4 beta, one pinned version.
- The fold is synchronous; only commands are Effects. A re-entrancy guard
  serialises folds — a command emitting on the forking stack would otherwise
  re-enter mid-write and have the outer fold write stale state on the way out.
- The store **object** (state cell, subscribers, pending queue) lives as long as
  the component instance; its **Effect scope** is opened by the mount effect and
  closed by that effect's cleanup. StrictMode forces the split: a store created
  in `useState` survives a simulated unmount, so a single `dispose()` would leave
  the remounted component holding a closed scope.
- The command queue and the fiber book (a flat map from group name to fibers,
  plus an in-flight counter — plain mutable fields, since every update is one
  synchronous step on one thread) are **per mount**, not per store, so a stale
  fiber can only take from a queue nobody offers to again.
- A command's emissions route back to the mount whose command emitted them, not
  to whichever mount is currently installed. Routing is carried per pending
  action (set only for command-emitted actions), so a fresh `dispatch` a
  parent's `on<Tag>` handler makes re-entrantly during a teardown drain still
  targets the live mount.
- Output handlers are read through a latest-ref assigned in a **layout
  effect**. A passive effect left a gap — a command fiber can emit on a
  microtask between the commit and the passive flush and see the previous
  render's handler — while a render-phase assignment had the opposite hole: a
  render pass React abandons would leave a never-committed handler in the ref
  (reproduced under suspension inside a transition). Commit and layout effects
  run in one synchronous task, which closes both.
- `Cancel` (and the teardown sweep) interrupt via `Fiber.interruptAll`: every
  fiber in the group is **signalled before any is awaited**, so a slow or hung
  finalizer on one member no longer delays — or blocks forever — the interrupt
  signal to its siblings, and no member can keep emitting during another's
  finalizer window.
- The mount loop runs inside `Effect.scoped`, so the mount's own scope is
  ambient to command fibers: a command's `Effect.addFinalizer` lands on it and
  runs when the mount closes, before the feature layer is released.
- Feature layers are built per mount and released with it. Anything that must
  survive a mount belongs in the root layer.
- Teardown runs in-band, on the fiber that owns the scope, with the feature's own
  services still alive — then the scope closes. Bounded as a whole; an abandoned
  teardown is reported as a defect rather than silently closing.

## Expected Behavior & Edge Cases

- `Mounted` fires once **per effect cycle** — twice in StrictMode dev. Latching
  it to once per store object was rejected: it hides non-idempotent `Mounted`
  handlers that will misbehave under Suspense and offscreen remounts.
- Interruption is how commands normally end (`Cancel`, unmount), so it is never
  reported as a defect. Only a genuine failure is.
- A command that dies is reported via the interpreter's exit hook. It forks and
  returns, so a dying child propagates to nobody — without the hook every runtime
  defect from a command vanishes silently.
- A command dropped after the component is gone is dropped **silently**. Reporting
  it was tried and reverted: `component`'s defect sink throws to the error
  boundary, so it replaced a feature's recovery UI with a crash on exactly the
  failure its `Error` handler existed to handle.
- Unmount interrupts in-flight work **before** running the `Unmounted` command.
  Flush-on-exit therefore belongs in the `Unmounted` handler. See open work #2.
- Teardown's `Unmounted` command is unkeyed, so it books under `"Unmounted"` in
  the flat namespace. A user group named `"Unmounted"` cannot collide
  observably: the teardown sweep interrupts every user fiber before that
  command is interpreted.

## Known limitations

- **`useHooks` sees the pre-`sync` state.** `component` calls the hook spec
  with the committed state read _before_ `store.sync` folds
  `PropsChanged`/`HookChanged`, and a sync-driven fold suppresses notification
  (the change paints on the same render), so a hook value derived from state
  can lag until the next dispatch or ambient change. A follow-up notification
  would cost the second render the render-body `sync` exists to avoid; this is
  part of the deferred `store.sync` redesign below, not a patch.
- **A `Cancel` awaits the interrupted fibers' finalizers on the mount's run
  loop.** That await is what guarantees a `Batch` can sequence a `Cancel`
  before the command replacing it — but it means an uninterruptible finalizer
  that hangs stalls all subsequent command processing for that feature.
  Finalizers are expected to be brief; the 5s teardown bound catches the
  unmount case, and nothing bounds the in-mount case today.
- **`run` cannot terminate while a never-completing command is in flight.**
  `Command.effect((d) => Effect.never)` pins the in-flight count exactly as
  `Command.stream(Stream.never)` did, so the leaf change does not fix this. The
  fix is the `Cmd`/`Sub` split — see Deferred decisions. Its test asserts today's
  behaviour on purpose; whoever fixes it inverts that test rather than deleting
  it.
- **An action a parent takes in response to a child's output is not attributable
  to that output.** An output leaves through a plain React callback into
  arbitrary user code, so the runtime cannot know what the parent did next. The
  devtools event stream therefore carries an `Output` event and a `Dispatch`
  cause on whatever the parent dispatched, and never claims an edge between
  them — a devtools UI can draw that edge, the runtime cannot assert it. This is
  the residue of the old `cause: { _tag: "Output" }` variant, which was deleted
  rather than left as an unfillable optional field. See `devtools.specs.md`.

## Open work

Five items. Item 3 now has its decision and its own spec; the other four each
still need a decision before they need code. Items 4 and 5 were
found by the review of the command-leaf pass and **rejected for that pass**: both
are byte-identical at the commit before it, so neither is a regression the leaf
change introduced, and both need a decision about intended behaviour rather than
a patch.

### 1. Re-arming a mount that died, from `component`

A feature layer that fails to build kills the mount fiber. The store clears its
mount and arm flag, so a following `start()` _can_ build fresh cells — but
`component` arms with `useEffect(() => { store.start(); return () => store.stop(); }, [store])`
and `store` never changes, so nothing calls one. Every command after that is
dropped for the life of the component, including the Retry the `Error` handler
just rendered. A driver holding the store recovers; a React subtree does not.

Candidates: a store-bumped `version` as a dep of the arming effect (simple, but
a permanently failing layer retries forever), or a demand-driven re-arm inside
the queue-offer path (fires only when work arrives, but re-enters `fold` from
inside a fold, so the guard has to be shown to hold).

Must not break: the silent drop after a _normal_ unmount. Done when a browser
test drives a failing layer, clicks Retry, and the retried command runs — plus a
test that a permanently failing layer does not spin.

### 2. What unmount owes work already in flight

Teardown interrupts every in-flight fiber before interpreting the `Unmounted`
command, unconditionally, so `start(); dispatch(Go); stop()` loses a 50ms effect
roughly 0ms in. The sweep is what makes teardown terminate at all — a
subscription never completes — so the question is not whether to sweep but which
work the sweep may kill.

Candidates: sweep only long-lived work once the `Cmd`/`Sub` split lands; or give
in-flight work a grace window inside the existing teardown budget; or keep the
sweep and document that flush-on-exit belongs in `Unmounted`, which is the
current de-facto answer.

Must not break: teardown termination, and the teardown bound staying a
whole-teardown bound rather than a per-hop one.

### 3. `RuntimeOptions.onEvent` is accepted and ignored — **closed**

`createRuntime` never emitted a `DevtoolsEvent`, but `src/examples/app.tsx` and
`cart.tsx` presented it as working, so a reader copying the example installed an
observer that never fired and got no signal.

Closed by the third option — wire it, as a feature. `RuntimeOptions` and the
second parameter are **removed outright**; observation is a `Context.Reference`
sink installed through the root layer, resolved synchronously because the fold
is synchronous. `src/lib/devtools.ts`, spec'd in `src/lib/devtools.specs.md`.
The number is kept rather than the item deleted, so the cross-references to
items #2, #4 and #5 elsewhere in this file keep meaning what they say.

Two things it did **not** close, both recorded under Known limitations in
`devtools.specs.md` rather than here: nothing is reported before `start()`
(the root context does not exist until the first `runFork`), and a mount whose
fiber _died_ emits no `Unmounted` — which is item #1's to fix, since the same
`release()` is why the store cannot re-arm from `component` either.

### 4. `Blueprint.run` discards a dying command

`commandInterpreter`'s `onExit` is optional, and `run` is the caller that omits
it. `forkLeaf` forks and returns, so nothing awaits the fiber: a feature whose
command dies comes back from `run` with the state it already had, an empty
`emitted`, and no failure. Confirmed by running it —
`Bump: () => [state, Command.effect(() => Effect.die(new Error("kaboom")))]`
resolves clean. `createFeatureStore` passes the hook and routes a non-interrupt
exit to the `Error` handler, so the two callers of the one interpreter disagree
about the one thing the hook exists for, and the interpreter's own JSDoc says
that without it "every defect from a command is discarded silently".

The consequence is worse than a missing report: `run` is the spec's headless way
to test a feature, so _"given a failing command, this feature recovers"_ is
currently untestable through it — a test written that way passes vacuously.

The decision it needs first: what `run` should _do_ with a defect. Route it to
the `Error` handler, matching the store, and a feature that handles it looks
identical either way from the outside. Fail the returned Effect, and a test can
assert on it, but `run` stops being total and every existing caller's type
changes. Collect into a `defects` array beside `emitted` and `outputs`, and it
stays total and stays assertable, at the cost of a third output nobody asked for
yet. The third is the current favourite; none is a patch.

### 5. Buffered work can precede `Mounted`

`start()` flushes `buffered` into the queue before folding `Mounted`. `sync`
runs in the render body while `start` runs in a passive effect, so a props
change between the first render and the mount effect folds `PropsChanged`
first — its command is buffered, and the flush puts it ahead of `Mounted`'s.
Confirmed: `sync({p:1}); sync({p:2}); start()` logs `["props-cmd", "mounted-cmd"]`.

This contradicts the lifecycle-order criterion above, which is marked `[x]` and
says `Mounted` comes first. The criterion is what is wrong — it describes the
intent, and the intent is right; the code has a window it does not cover. A
`Mounted` handler seeding state that a `PropsChanged` command depends on sees
them inverted.

Not independent of the deferred `store.sync` work: the window exists _because_
`sync` folds during render while `start` runs in an effect. Moving the fold into
an effect closes it as a side effect, which is an argument for doing that piece
properly rather than special-casing the ordering here.

## Deferred decisions

### One `dispatch`, routed by tag — no `Command.output`

`Command.output` and its compile-error-on-an-internal-message criterion are
removed, and outbound messages go through the same `dispatch`, routed by `_tag`
against the declared output cases — which is already how routing works and
already own-keys checked. The channel brand keeps its declaration-time jobs
(`ChannelOf`, `SameChannel`, `Disjoint`, `OutputProps`); it stops being checked
at the command call site, where it never affected routing anyway.

**Deferred** to keep the leaf pass to one blast radius. It touches every example's
props and the brand's call-site role; the leaf change does not.

### `store.sync` folding during render

`sync` compares props and hooks by value and, when either moved, folds
`PropsChanged` / `HookChanged` **in the render body**. That is a store mutation
during render, which a discarded render repeats — the value comparison is what
makes the repeat a no-op, and the reason the idempotence criterion above exists.
The alternative is `sync` reporting only _whether_ ambient inputs moved and
`component` folding in an effect, which costs a render: the change would paint on
the render after the one that carried the props.

**Deferred**, and not merely unscheduled. Two reasons. The blast radius is not
this pass's: it moves state into `component`, both browser tests and every
example's render timing, on top of a leaf migration whose own scope was already
trimmed for the same reason (see `Command.output`, below). And the one-line
statement of it is not implementable as written — it says the fold moves to an
effect but not whether the _comparison baseline_ moves with it, and the baseline
advance is itself a render-phase mutation, so leaving it behind fixes nothing.
It needs its own `/spec` pass rather than a box on this one.

This supersedes old open item #5 ("the `useSyncExternalStore`-after-`sync`
ordering has no discriminating test"), which the previous spec rewrite promoted
into an acceptance criterion. The untested-ordering observation stands and is
recorded there; the redesign it proposed is what is deferred here.

### Subscriptions split from commands (`Cmd` / `Sub`)

Elm's runtime asks the feature for its subscriptions on every update and
diffs them: a subscription is a _declaration_, and stopping one means no longer
declaring it. Commands are one-shot; subscriptions are a set the runtime
maintains.

Collapsing both into `Command` is what makes `run`'s non-termination
unfixable — the runtime cannot tell "work that will finish" from "work that is
supposed to run forever", so quiescence cannot be defined. It also makes unmount
guess (open work #2).

**Deferred** because it is a second ADT, a diffing step, and a second lifecycle
hook, and it should land against the `Effect` leaf rather than at the same time
as it.
