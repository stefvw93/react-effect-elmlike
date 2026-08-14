/**
 * Unit tests for `tea.ts`, against `tea.specs.md`'s Acceptance Criteria.
 *
 * `createRuntime` (and its returned `{ Provider, component, useRuntime }`) is
 * out of scope — see specs.md. Everything else with a real implementation is
 * covered here.
 */

import {
  Cause,
  Context,
  Effect,
  Equivalence,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Ref,
  Schema,
  SchemaParser,
  Stream,
} from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Action, Command, createFeatureStore, define, Next } from "./tea";

// ---------------------------------------------------------------------------
// Vocabularies (Action, Action.output, Action.of)
// ---------------------------------------------------------------------------

/**
 * The channel brand is module-private, so it is located by description. Used to
 * assert the value-level half of what `ChannelOf` asserts at the type level.
 */
const channelOf = (branded: object): unknown => {
  const brand = Object.getOwnPropertySymbols(branded).find(
    (symbol) => symbol.description === "@tea/channel",
  );
  return brand === undefined ? undefined : (branded as Record<symbol, unknown>)[brand];
};

describe("vocabularies", () => {
  it("constructs a single message branded with its channel", () => {
    const Foo = Action("Foo", { id: Schema.String });
    const OutboundFoo = Action.output("Foo", { id: Schema.String });

    expect(Foo.make({ id: "x" })).toEqual({ _tag: "Foo", id: "x" });

    // A `TaggedStruct`, so `_tag` is part of the *schema*, not only of the
    // value `make` happens to produce — that is what makes the message
    // encodable and what `toTaggedUnion` discriminates on.
    expect(Object.keys(Foo.fields).sort()).toEqual(["_tag", "id"]);

    // The channel brand is a real runtime property, not only a phantom:
    // `Action.of` reads it off member zero to brand the vocabulary, so the
    // value-level half has to be there for the type-level half to be honest.
    expect(channelOf(Foo)).toBe("internal");
    expect(channelOf(OutboundFoo)).toBe("outbound");
  });

  it("`.of` builds a tagged union exposing cases, guards, and match", () => {
    const Started = Action("Started", {});
    const Failed = Action("Failed", { reason: Schema.String });
    const Async = Action.of([Started, Failed]);

    expect(Object.keys(Async.cases)).toEqual(["Started", "Failed"]);
    expect(Async.guards.Started({ _tag: "Started" })).toBe(true);
    expect(Async.guards.Started({ _tag: "Failed", reason: "x" })).toBe(false);

    const matched = Async.match(
      { _tag: "Failed", reason: "boom" },
      { Started: () => "started", Failed: (f) => `failed:${f.reason}` },
    );
    expect(matched).toBe("failed:boom");

    // Exposed by `Schema.toTaggedUnion` itself, not hand-rolled here — a
    // presence check is enough; Effect's own suite covers its behavior.
    expect(typeof Async.mapMembers).toBe("function");

    // One `make` per case, filling `_tag` — this is what lets a reducer or a
    // command construct a member without repeating the discriminant, and it is
    // the half of `cases` that a plain array of schemas could not provide.
    expect(Async.cases.Started.make({})).toEqual({ _tag: "Started" });
    expect(Async.cases.Failed.make({ reason: "boom" })).toEqual({
      _tag: "Failed",
      reason: "boom",
    });
  });

  it("`.of` reads its channel off the members rather than being told", () => {
    const Internal = Action.of([Action("Foo", {})]);
    const Outbound = Action.of([Action.output("Bar", {})]);

    // One `of`, two channels: the vocabulary's brand comes from member zero,
    // which is the value-level counterpart of `ChannelOf`.
    expect(channelOf(Internal)).toBe("internal");
    expect(channelOf(Outbound)).toBe("outbound");

    // ...and there is no per-channel `of` to disagree with it. Asking the
    // caller to name a channel the members already carry would be a second
    // source of truth. (The type-level half is in tea.tst.ts.)
    expect("of" in Action.output).toBe(false);
  });

  it("a vocabulary built with `.of` nests, flattening the outer `cases`", () => {
    const Started = Action("Started", {});
    const Failed = Action("Failed", { reason: Schema.String });
    const Async = Action.of([Started, Failed]);
    const CheckoutRequested = Action("CheckoutRequested", {});
    const CartActions = Action.of([Async, CheckoutRequested]);

    expect(Object.keys(CartActions.cases).sort()).toEqual(
      ["CheckoutRequested", "Failed", "Started"].sort(),
    );

    // Key presence alone would be satisfied by a placeholder. A flattened tag
    // has to be a first-class case of the *outer* union — constructible and
    // discriminable there — since `Reducer` keys off `cases` and a handler for
    // `Failed` has to receive the inner member's own type.
    expect(CartActions.cases.Failed.make({ reason: "boom" })).toEqual({
      _tag: "Failed",
      reason: "boom",
    });
    expect(CartActions.guards.Failed({ _tag: "Failed", reason: "boom" })).toBe(true);
    expect(CartActions.guards.Failed({ _tag: "CheckoutRequested" })).toBe(false);
  });

  // Reserved lifecycle tags are rejected at compile time only — see
  // `src/lib/__type-tests__/tea.tst.ts`. `NotLifecycleTag` isn't a runtime
  // check, so there is nothing to assert here at runtime.
});

// ---------------------------------------------------------------------------
// Command ADT + constructors + policy wrappers
// ---------------------------------------------------------------------------

describe("Command", () => {
  it("none is the no-op tag, carrying nothing to interpret", () => {
    expect(Command.none).toMatchObject({ _tag: "None" });
    // The tag and `pipe`, and nothing else — every other variant carries a
    // payload `interpret` has to read, and this one is defined by having none.
    expect(Object.keys(Command.none).sort()).toEqual(["_tag", "pipe"]);
  });

  it("effect wraps the Effect it was given", () => {
    const inner = Effect.void;
    const cmd = Command.effect(inner);
    expect(cmd).toMatchObject({ _tag: "Effect" });
    // Wrapped, not adapted — `interpret` is the only thing that transforms it.
    if (cmd._tag !== "Effect") throw new TypeError("expected Effect");
    expect(cmd.effect).toBe(inner);
  });

  it("stream wraps the Stream it was given", () => {
    const inner = Stream.empty;
    const cmd = Command.stream(inner);
    expect(cmd).toMatchObject({ _tag: "Stream" });
    if (cmd._tag !== "Stream") throw new TypeError("expected Stream");
    expect(cmd.stream).toBe(inner);
  });

  it("batch collects members, each independent", () => {
    const cmd = Command.batch(Command.none, Command.effect(Effect.void));
    expect(cmd).toMatchObject({ _tag: "Batch", commands: [{ _tag: "None" }, { _tag: "Effect" }] });
  });

  it("cancel accepts a bare tag string or a { tag, key } group", () => {
    expect(Command.cancel("Foo")).toMatchObject({ _tag: "Cancel", target: { tag: "Foo" } });
    expect(Command.cancel({ tag: "Foo", key: "sku-1" })).toMatchObject({
      _tag: "Cancel",
      target: { tag: "Foo", key: "sku-1" },
    });
  });

  it("output emits an outbound message as a one-shot stream", async () => {
    const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });
    const cmd = Command.output(OrderPlaced, { orderId: "o1" });
    if (cmd._tag !== "Stream") throw new TypeError("expected Stream");
    const emitted = await Effect.runPromise(Stream.runCollect(cmd.stream));
    expect(emitted).toEqual([{ _tag: "OrderPlaced", orderId: "o1" }]);
  });

  it("restart/ignore/queue wrap a command in a Guarded node, and are pipeable", () => {
    const base = Command.none;
    const wrappers = [
      ["restart", Command.restart],
      ["ignore", Command.ignore],
      ["queue", Command.queue],
    ] as const;

    for (const [policy, wrap] of wrappers) {
      const keyed = base.pipe(wrap("sku-1"));
      expect(keyed).toMatchObject({
        _tag: "Guarded",
        policy,
        key: "sku-1",
        command: { _tag: "None" },
      });

      const unkeyed = base.pipe(wrap());
      expect(unkeyed).toMatchObject({ _tag: "Guarded", policy, command: { _tag: "None" } });

      // An omitted key has to stay `undefined`. `groupId` interpolates it into
      // the group id, so a stray value would silently split one group into two
      // and every policy would stop applying. `toMatchObject` cannot catch
      // that — it ignores keys it was not given.
      if (unkeyed._tag !== "Guarded") throw new TypeError("expected Guarded");
      expect(unkeyed.key).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Next accessors
// ---------------------------------------------------------------------------

describe("Next", () => {
  it("state() reads through a bare state or a [state, command] tuple", () => {
    const state = { count: 1 };

    expect(Next.state(state)).toEqual({ count: 1 });
    expect(Next.state([state, Command.none])).toEqual({ count: 1 });

    // Identity, not merely equality. `PropsChanged` fires on every
    // ancestor-driven render and its documented no-op is "return the same
    // state reference" — so an accessor that copied, or that rebuilt the
    // object on the way out, would make that contract unexpressible and turn
    // every prop change into a state change.
    expect(Next.state(state)).toBe(state);
    expect(Next.state([state, Command.none])).toBe(state);
  });

  it("command() is undefined for bare state, present for a tuple", () => {
    expect(Next.command({ count: 1 })).toBeUndefined();

    // A fresh instance rather than the `Command.none` singleton. `toBe`
    // against a module-level constant is also satisfied by an accessor that
    // returns that constant unconditionally, which is exactly the bug that
    // would make every command a no-op.
    const command = Command.effect(Effect.void);
    expect(Next.command([{ count: 1 }, command])).toBe(command);
    expect(Next.command([{ count: 1 }, command])).not.toBe(Command.none);
  });
});

// ---------------------------------------------------------------------------
// define(...).create(...) -> Blueprint.reduce
// ---------------------------------------------------------------------------

const CounterState = Schema.Struct({ count: Schema.Number });
const CounterProps = Schema.Struct({ start: Schema.Number, step: Schema.Number });
const Incremented = Action("Incremented", {});

const Counter = define({
  props: CounterProps,
  state: CounterState,
  action: Action.of([Incremented]),
});

const counter = Counter.create({
  initialState: (props) => ({ count: props.start }),
  reducer: {
    Incremented: (_action, { state, props }) => ({ count: state.count + props.step }),
    // Only `Mounted` is handled; PropsChanged/HookChanged/Error/Unmounted are not,
    // which is exactly the case the documented "state unchanged" fix covers.
    Mounted: (_action, { state }) => state,
  },
  render: () => null,
});

const at = (count: number) => ({
  state: { count },
  props: { start: 0, step: 5 },
  hooks: {},
});

describe("Blueprint.reduce", () => {
  it("dispatches a declared action to its handler", () => {
    const next = counter.reduce({ _tag: "Incremented" }, at(10));
    expect(Next.state(next)).toEqual({ count: 15 });
  });

  it("routes by _tag — declared and lifecycle alike — and returns the whole Next", () => {
    const Up = Action("Up", {});
    const Down = Action("Down", {});
    const TwoWay = define({
      props: CounterProps,
      state: CounterState,
      action: Action.of([Up, Down]),
    });
    const mountCommand = Command.effect(Effect.void);
    const twoWay = TwoWay.create({
      initialState: (props) => ({ count: props.start }),
      reducer: {
        Up: (_action, { state }) => ({ count: state.count + 1 }),
        Down: (_action, { state }) => ({ count: state.count - 1 }),
        Mounted: (_action, { state }) => [state, mountCommand] as const,
      },
      render: () => null,
    });

    const snapshot = at(10);

    // Two declared tags with opposite effects: a single-action vocabulary
    // cannot show that routing discriminates, only that *some* handler ran.
    expect(Next.state(twoWay.reduce({ _tag: "Up" }, snapshot))).toEqual({ count: 11 });
    expect(Next.state(twoWay.reduce({ _tag: "Down" }, snapshot))).toEqual({ count: 9 });

    // A lifecycle action routes through the same lookup — that is the whole
    // point of them living in the reducer's key space rather than beside it.
    const mounted = twoWay.reduce({ _tag: "Mounted" }, snapshot);

    // And the handler's `Next` comes back intact, command included. Reading
    // only the state would hide a `reduce` that dropped the command.
    expect(Next.state(mounted)).toBe(snapshot.state);
    expect(Next.command(mounted)).toBe(mountCommand);
  });

  it("an unhandled lifecycle action leaves state unchanged and does not throw", () => {
    const snapshot = at(10);

    // Every lifecycle tag `counter` declares no handler for — it declares only
    // `Mounted`. One tag is not a sweep: `HookChanged` is the newest member of
    // `LifecycleTag` and the likeliest to be missed, and `Unmounted` reaches
    // this branch on teardown of any feature that ignores it, which is most.
    const unhandled: ReadonlyArray<Parameters<typeof counter.reduce>[0]> = [
      { _tag: "PropsChanged", previous: snapshot.props },
      { _tag: "HookChanged", previous: {} },
      { _tag: "Error", error: new Error("boom"), cause: Cause.die(new Error("boom")) },
      { _tag: "Unmounted" },
    ];

    for (const action of unhandled) {
      expect(() => counter.reduce(action, snapshot)).not.toThrow();

      const next = counter.reduce(action, snapshot);
      // The same reference, not an equal object. A copy would make every
      // ignored lifecycle action read as a state change downstream — and
      // `PropsChanged` fires on every ancestor-driven render.
      expect(Next.state(next)).toBe(snapshot.state);
      // No command either: the no-op has to be total, not merely state-shaped.
      expect(Next.command(next)).toBeUndefined();
    }
  });

  it("a genuinely unhandled tag (not a lifecycle tag) throws rather than silently no-opping", () => {
    // Reachable only by bypassing the typed surface — every declared action
    // tag is required in `reducer` by `Reducer`'s type, so this simulates a
    // bad cast or a malformed replay, not a legitimate dispatch.
    const bogus = { _tag: "NotAKnownTag" } as unknown as Parameters<typeof counter.reduce>[0];
    expect(() => counter.reduce(bogus, at(10))).toThrow(/No reducer handler/);
  });

  it("a tag inherited from Object.prototype is still a missing handler, and throws", () => {
    // `Object.prototype` keys are the adversarial case for both lookups in
    // `reduce`: `parts.reducer[tag]` resolves `constructor`/`toString` to
    // inherited functions, and `tag in LifecycleTags` is true for them too.
    // Neither is a declared handler and none is a `LifecycleTag`, so each has
    // to reach the throw — this is exactly the "bypassed the typed surface"
    // case the criterion is about, and the shape a malformed devtools replay
    // would take.
    for (const tag of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const bogus = { _tag: tag } as unknown as Parameters<typeof counter.reduce>[0];
      expect(() => counter.reduce(bogus, at(10))).toThrow(/No reducer handler/);
    }
  });

  it("Unmounted discards the handler's returned state; only its command matters", () => {
    const WithUnmount = Counter.create({
      initialState: (props) => ({ count: props.start }),
      reducer: {
        Incremented: (_action, { state, props }) => ({ count: state.count + props.step }),
        Unmounted: () => [{ count: 999 }, Command.effect(Effect.void)] as const,
      },
      render: () => null,
    });

    const next = WithUnmount.reduce({ _tag: "Unmounted" }, at(10));
    // The command is still reachable...
    expect(Next.command(next)).toMatchObject({ _tag: "Effect" });
    // ...and the returned state is discarded here too, not only by the runtime.
    // `reduce` is documented as the way to test teardown without mounting, so
    // it has to give the same answer `run` does — see the `run` counterpart
    // below. A handler's `{ count: 999 }` is unobservable in both.
    expect(Next.state(next)).toEqual({ count: 10 });
  });

  it("Unmounted discards the returned state even with no command attached", () => {
    // The bare-state return is the shape that would otherwise slip through: it
    // is not a tuple, so a discard implemented only on the tuple branch would
    // still hand back the handler's state.
    const WithUnmount = Counter.create({
      initialState: (props) => ({ count: props.start }),
      reducer: {
        Incremented: (_action, { state, props }) => ({ count: state.count + props.step }),
        Unmounted: () => ({ count: 999 }),
      },
      render: () => null,
    });

    const next = WithUnmount.reduce({ _tag: "Unmounted" }, at(10));
    expect(Next.state(next)).toEqual({ count: 10 });
    expect(Next.command(next)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// define(...).create(...) -> Blueprint.run
// ---------------------------------------------------------------------------

class TestLog extends Context.Service<TestLog, { readonly ref: Ref.Ref<ReadonlyArray<string>> }>()(
  "TestLog",
) {}

const push = (msg: string) =>
  Effect.flatMap(TestLog, ({ ref }) => Ref.update(ref, (log) => [...log, msg]));

const makeLogLayer = () =>
  Effect.runSync(
    Effect.map(Ref.make<ReadonlyArray<string>>([]), (ref) => ({
      ref,
      layer: Layer.succeed(TestLog, { ref }),
    })),
  );

const RunState = Schema.Struct({ count: Schema.Number });
const RunProps = Schema.Struct({});
const Go = Action("Go", { ms: Schema.Number, id: Schema.String });
const Bump = Action("Bump", {});
const Announced = Action.output("Announced", { id: Schema.String });

describe("Blueprint.run", () => {
  it("seeded actions are processed but not recorded in `emitted`", async () => {
    const Echo = Action("Echo", {});
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump, Echo]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        // The second seed emits `Echo`, so `emitted` ends up non-empty. With
        // no command anywhere, `emitted` would be `[]` whether or not seeds
        // were excluded from it — the assertion could not fail for the reason
        // the criterion states.
        Bump: (_action, { state }) => {
          const count = state.count + 1;
          return count === 2
            ? [{ count }, Command.stream(Stream.succeed({ _tag: "Echo" as const }))]
            : { count };
        },
        Echo: (_action, { state }) => ({ count: state.count + 10 }),
      },
      render: () => null,
    });

    const { state, emitted } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }, { _tag: "Bump" }], {
        props: {},
        hooks: {},
        layer: Layer.empty,
      }),
    );

    // 1 + 1 from the two seeds, then +10 from the echoed action: both seeds
    // were processed, and in order.
    expect(state).toEqual({ count: 12 });
    // Only the command-borne action is recorded. Two `Bump` seeds went through
    // the reducer and neither appears.
    expect(emitted).toEqual([{ _tag: "Echo" }]);
  });

  it("a command's emissions feed back into the reducer and land in `emitted`", async () => {
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Bump: (_action, { state }) =>
          state.count === 0
            ? [
                { count: state.count + 1 },
                Command.stream(Stream.succeed({ _tag: "Bump" as const })),
              ]
            : { count: state.count + 1 },
      },
      render: () => null,
    });

    const { state, emitted } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    expect(state).toEqual({ count: 2 });
    expect(emitted).toEqual([{ _tag: "Bump" }]);
  });

  it("emissions re-enter the loop transitively, not only once", async () => {
    const Echo = Action("Echo", {});
    const Done = Action("Done", {});
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Bump, Echo, Done]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Bump: (_action, { state }) => [
          { count: state.count + 1 },
          Command.stream(Stream.succeed({ _tag: "Echo" as const })),
        ],
        Echo: (_action, { state }) => [
          { count: state.count + 10 },
          Command.stream(Stream.succeed({ _tag: "Done" as const })),
        ],
        Done: (_action, { state }) => ({ count: state.count + 100 }),
      },
      render: () => null,
    });

    const { state, emitted } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    // Depth two. An interpreter that stepped a command's emissions but not
    // *their* commands would stop at 11 with `[Echo]` — which is what a single
    // drain pass looks like, and what the existing depth-one test accepts.
    expect(state).toEqual({ count: 111 });
    expect(emitted).toEqual([{ _tag: "Echo" }, { _tag: "Done" }]);
  });

  it("`emitted` records every emission, including repeats of the same action", async () => {
    const Tick = Action("Tick", {});
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump, Tick]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Bump: (_action, { state }) => [
          { count: state.count + 1 },
          Command.stream(
            Stream.fromIterable([
              { _tag: "Tick" as const },
              { _tag: "Tick" as const },
              { _tag: "Tick" as const },
            ]),
          ),
        ],
        Tick: (_action, { state }) => ({ count: state.count + 10 }),
      },
      render: () => null,
    });

    const { state, emitted } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    // Every other test emits distinct actions exactly once, so a `Set`-backed
    // or first-only `emitted` would look correct in all of them. Three
    // identical actions separate "every" from "each distinct one".
    expect(state).toEqual({ count: 31 });
    expect(emitted).toEqual([{ _tag: "Tick" }, { _tag: "Tick" }, { _tag: "Tick" }]);
  });

  it("outputs land in `outputs`, never in `emitted`, and never re-enter the reducer", async () => {
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Bump]),
      output: Action.of([Announced]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Bump: (_action, { state }) => [
          { count: state.count + 1 },
          Command.output(Announced, { id: "a1" }),
        ],
      },
      render: () => null,
    });

    const { state, emitted, outputs } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    expect(state).toEqual({ count: 1 });
    expect(emitted).toEqual([]);
    expect(outputs).toEqual([{ _tag: "Announced", id: "a1" }]);
  });

  it("a prototype-chain tag is not an output either — it still throws", async () => {
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Bump]),
      output: Action.of([Announced]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: (_action, { state }) => ({ count: state.count + 1 }) },
      render: () => null,
    });

    // `isOutput` asks `_tag in spec.output.cases`, and `cases` inherits from
    // `Object.prototype` like everything else. `"constructor"` is not a
    // declared output, so classifying it as one would route an unknown action
    // into `outputs` and out to the parent instead of reaching the throw.
    const bogus = { _tag: "constructor" } as unknown as Parameters<typeof feature.reduce>[0];

    await expect(
      Effect.runPromise(feature.run([bogus], { props: {}, hooks: {}, layer: Layer.empty })),
    ).rejects.toThrow(/No reducer handler/);
  });

  it("Batch runs members independently, each keeping its own policy", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.batch(
            Command.effect(
              Effect.andThen(push(`${action.id}:start`), Effect.sleep(`${action.ms} millis`)),
            ).pipe(Command.restart(`a-${action.id}`)),
            Command.effect(push(`${action.id}:other`)),
          ),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run([{ _tag: "Go", ms: 5, id: "x" }], { props: {}, hooks: {}, layer }),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).toContain("x:start");
    expect(log).toContain("x:other");
  });

  it("Batch members keep their own policies — one guarded member does not govern the others", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.batch(
            // Guarded by "ignore": still in flight when the second Go lands,
            // so that one is dropped.
            Command.effect(
              Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:guarded`)),
            ).pipe(Command.ignore("g")),
            // Unguarded sibling: must run on *both* dispatches. If a batch
            // applied one member's policy to the whole node, this would be
            // dropped too and the assertion below would catch it.
            Command.effect(push(`${action.id}:free`)),
          ),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 20, id: "first" },
          { _tag: "Go", ms: 0, id: "second" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).toContain("first:guarded");
    expect(log).not.toContain("second:guarded");
    expect(log).toContain("first:free");
    expect(log).toContain("second:free");
  });

  it("Batch members occupy their own groups — cancelling one leaves its sibling running", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Go, Action("Stop", {}), Action("Arm", {})]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: () => [
          { count: 0 },
          // Two members under the same tag but different keys. If a batch
          // shared one group across its members, cancelling "a" would take
          // "b" with it — the policy test above cannot see that, since it
          // only distinguishes which member's *policy* applied.
          Command.batch(
            Command.effect(
              Effect.andThen(
                push("a:start"),
                Effect.andThen(Effect.sleep("200 millis"), push("a:done")),
              ),
            ).pipe(Command.queue("a")),
            Command.effect(
              Effect.andThen(
                push("b:start"),
                Effect.andThen(Effect.sleep("60 millis"), push("b:done")),
              ),
            ).pipe(Command.queue("b")),
          ),
        ],
        Arm: () => [
          { count: 0 },
          Command.stream(
            Stream.fromEffect(
              Effect.andThen(Effect.sleep("20 millis"), Effect.succeed({ _tag: "Stop" as const })),
            ),
          ),
        ],
        Stop: () => [{ count: 0 }, Command.cancel({ tag: "Go", key: "a" })],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run([{ _tag: "Go", ms: 0, id: "x" }, { _tag: "Arm" }], {
        props: {},
        hooks: {},
        layer,
      }),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).toContain("a:start");
    expect(log).toContain("b:start");
    expect(log).not.toContain("a:done");
    expect(log).toContain("b:done");
  });

  it("Cancel by tag only interrupts every group under that tag", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Go, Action("Stop", {}), Action("Arm", {})]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.ensuring(
              Effect.andThen(
                push(`${action.id}:start`),
                Effect.andThen(Effect.sleep("200 millis"), push(`${action.id}:done`)),
              ),
              push(`${action.id}:ensuring`),
            ),
          ).pipe(Command.queue(action.id)),
        ],

        /**
         * `Stop` is emitted by a command rather than seeded, and that is
         * load-bearing. Seeds are all offered to the queue up-front, and the
         * drain loop can reach `Stop` before either forked fiber has been
         * scheduled — so cancelling would interrupt fibers that never started,
         * which is a different thing from interrupting a *running* group and
         * leaves no finalizer trace to prove otherwise.
         */
        Arm: () => [
          { count: 0 },
          Command.stream(
            Stream.fromEffect(
              Effect.andThen(Effect.sleep("30 millis"), Effect.succeed({ _tag: "Stop" as const })),
            ),
          ),
        ],
        Stop: () => [{ count: 0 }, Command.cancel("Go")],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [{ _tag: "Go", ms: 0, id: "a" }, { _tag: "Go", ms: 0, id: "b" }, { _tag: "Arm" }],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    // Both groups were genuinely running when the cancel landed...
    expect(log).toContain("a:start");
    expect(log).toContain("b:start");
    // ...neither completed...
    expect(log).not.toContain("a:done");
    expect(log).not.toContain("b:done");
    // ...and both were interrupted rather than never scheduled. The two
    // absences above are equally satisfied by work that never started; the
    // finalizer only runs for a fiber that did.
    expect(log).toContain("a:ensuring");
    expect(log).toContain("b:ensuring");
  });

  it("Cancel by tag+key interrupts only that specific group", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Go, Action("Stop", { id: Schema.String }), Action("Arm", {})]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.ensuring(
              Effect.andThen(
                push(`${action.id}:start`),
                Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
              ),
              push(`${action.id}:ensuring`),
            ),
          ).pipe(Command.queue(action.id)),
        ],
        // Delayed like the tag-only test, and for the same reason: a seeded
        // `Stop` can be reached before either group has been scheduled, and
        // "cancelled only group a" is not shown by killing a fiber that never
        // ran.
        Arm: () => [
          { count: 0 },
          Command.stream(
            Stream.fromEffect(
              Effect.andThen(
                Effect.sleep("20 millis"),
                Effect.succeed({ _tag: "Stop" as const, id: "a" }),
              ),
            ),
          ),
        ],
        Stop: (action) => [{ count: 0 }, Command.cancel({ tag: "Go", key: action.id })],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [{ _tag: "Go", ms: 200, id: "a" }, { _tag: "Go", ms: 60, id: "b" }, { _tag: "Arm" }],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    // Both were running when the cancel landed.
    expect(log).toContain("a:start");
    expect(log).toContain("b:start");
    // Only `a`'s group was named, and only `a` was interrupted — its finalizer
    // proves it got far enough to be interrupted rather than never started.
    expect(log).not.toContain("a:done");
    expect(log).toContain("a:ensuring");
    // The unnamed sibling ran to completion.
    expect(log).toContain("b:done");
  });

  it('policy "restart" interrupts the prior in-flight fiber in the same group', async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Go, Action("Arm", {})]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.ensuring(
              Effect.andThen(
                push(`${action.id}:start`),
                Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
              ),
              push(`${action.id}:ensuring`),
            ),
          ).pipe(Command.restart("group")),
        ],
        // The second dispatch arrives late, so the first is genuinely
        // *in-flight* when it lands. Seeded back-to-back, both would be
        // handled in one drain pass and the "prior" fiber would be interrupted
        // before the scheduler ever started it — which is not what the
        // criterion says restart does.
        Arm: () => [
          { count: 0 },
          Command.stream(
            Stream.fromEffect(
              Effect.andThen(
                Effect.sleep("20 millis"),
                Effect.succeed({ _tag: "Go" as const, ms: 0, id: "second" }),
              ),
            ),
          ),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run([{ _tag: "Go", ms: 200, id: "first" }, { _tag: "Arm" }], {
        props: {},
        hooks: {},
        layer,
      }),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    // The first was running...
    expect(log).toContain("first:start");
    // ...was interrupted rather than allowed to finish...
    expect(log).not.toContain("first:done");
    expect(log).toContain("first:ensuring");
    // ...and the restarting dispatch ran in its place.
    expect(log).toContain("second:done");
  });

  it('policy "ignore" drops a new dispatch while one is in-flight', async () => {
    const { ref, layer } = makeLogLayer();
    const Arm = Action("Arm", { delay: Schema.Number, id: Schema.String });
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go, Arm]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.andThen(
              push(`${action.id}:start`),
              Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
            ),
          ).pipe(Command.ignore("group")),
        ],
        Arm: (action) => [
          { count: 0 },
          Command.stream(
            Stream.fromEffect(
              Effect.andThen(
                Effect.sleep(`${action.delay} millis`),
                Effect.succeed({ _tag: "Go" as const, ms: 0, id: action.id }),
              ),
            ),
          ),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 60, id: "first" },
          // Lands while `first` is running — dropped.
          { _tag: "Arm", delay: 20, id: "second" },
          // Lands well after `first` has settled — must be admitted. Nothing
          // previously distinguished "ignore while busy" from "ignore
          // forever": a group that never reopened passed the old test.
          { _tag: "Arm", delay: 200, id: "third" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).toContain("first:start");
    expect(log).toContain("first:done");
    expect(log).not.toContain("second:start");
    expect(log).not.toContain("second:done");
    expect(log).toContain("third:done");
  });

  it('policy "queue" defers a new dispatch until the prior settles; both complete', async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.andThen(
              push(`${action.id}:start`),
              Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
            ),
          ).pipe(Command.queue("group")),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 40, id: "first" },
          { _tag: "Go", ms: 0, id: "second" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    // The criterion says the newcomer waits *before running*, which completion
    // order alone cannot show — a second command that started immediately and
    // happened to finish later would produce the same two `:done` entries in
    // the same order. Interleaving the starts pins it: under "parallel" this
    // reads first:start, second:start, second:done, first:done.
    expect(log).toEqual(["first:start", "first:done", "second:start", "second:done"]);
  });

  it('policy "parallel" (the default) runs concurrent dispatches concurrently; both complete', async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.andThen(
              push(`${action.id}:start`),
              Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
            ),
          ),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 40, id: "first" },
          { _tag: "Go", ms: 0, id: "second" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    // "Both completed" is equally true under "queue", so it cannot show that
    // the default is concurrent. The interleaving is what does: the second
    // starts while the first is still sleeping and overtakes it. Under
    // "queue" this same feature reads
    // first:start, first:done, second:start, second:done — the exact inverse
    // asserted by the test above.
    expect(log).toEqual(["first:start", "second:start", "second:done", "first:done"]);
  });

  it("a nested Guarded policy does not override an outer one — outermost wins", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          // Outer "ignore" wraps an inner "restart" — outer should win, so a
          // second dispatch is dropped rather than interrupting the first.
          Command.effect(
            Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
          )
            .pipe(Command.restart("group"))
            .pipe(Command.ignore("group")),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 20, id: "first" },
          { _tag: "Go", ms: 0, id: "second" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).toContain("first:done");
    expect(log).not.toContain("second:done");
  });

  it("outermost wins in the other arrangement too — outer restart over inner ignore", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          // The mirror of the test above. One arrangement alone cannot tell
          // "the outermost policy wins" apart from "ignore always wins", since
          // both predict the same log. Here outer `restart` must beat inner
          // `ignore`: the second dispatch interrupts the first rather than
          // being dropped by it, which is the opposite outcome.
          Command.effect(
            Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
          )
            .pipe(Command.ignore("inner"))
            .pipe(Command.restart("outer")),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 200, id: "first" },
          { _tag: "Go", ms: 0, id: "second" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).not.toContain("first:done");
    expect(log).toContain("second:done");
  });

  it("services requested by a command are satisfied from options.layer", async () => {
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: () => [{ count: 1 }, Command.effect(push("via-layer"))] },
      render: () => null,
    });

    const { ref, layer } = makeLogLayer();
    await Effect.runPromise(feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer }));

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).toEqual(["via-layer"]);
  });

  it("one stream's emissions are routed per element — actions to the reducer, outputs out", async () => {
    const Feature = define({
      props: RunProps,
      state: RunState,
      action: Action.of([Bump]),
      output: Action.of([Announced]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        // Routing is by `_tag` and nothing else, so a single stream carrying
        // both kinds is the case that proves it: the destination is a property
        // of each element, not of the command that produced them.
        Bump: (_action, { state }) =>
          state.count === 0
            ? [
                { count: 1 },
                Command.stream(
                  Stream.fromIterable([
                    { _tag: "Announced" as const, id: "a1" },
                    { _tag: "Bump" as const },
                    { _tag: "Announced" as const, id: "a2" },
                  ]),
                ),
              ]
            : { count: state.count + 1 },
      },
      render: () => null,
    });

    const { state, emitted, outputs } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    // Seed `Bump` took count to 1; the streamed `Bump` re-entered and took it
    // to 2. The two outputs never reached the reducer.
    expect(state).toEqual({ count: 2 });
    expect(emitted).toEqual([{ _tag: "Bump" }]);
    expect(outputs).toEqual([
      { _tag: "Announced", id: "a1" },
      { _tag: "Announced", id: "a2" },
    ]);
  });

  it("Command.effect runs for effects and emits nothing, even when it succeeds with an action", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        // Guarded on `count` so that a regression fails the assertions below
        // rather than emitting `Bump` forever and hanging the suite.
        Bump: (_action, { state }) =>
          state.count === 0
            ? [
                { count: 1 },
                // Succeeds *with a well-formed action*. `interpret` wraps the
                // effect in `Effect.asVoid`, so the success value is discarded
                // rather than offered to the queue — an effect command has no
                // emission channel, only the `R` it asked for.
                Command.effect(
                  Effect.andThen(push("ran"), Effect.succeed({ _tag: "Bump" as const })),
                ),
              ]
            : { count: state.count + 1 },
      },
      render: () => null,
    });

    const { state, emitted } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer }),
    );

    expect(await Effect.runPromise(Ref.get(ref))).toEqual(["ran"]);
    expect(state).toEqual({ count: 1 });
    expect(emitted).toEqual([]);
  });

  it("Command.none is interpreted as a no-op and does not hold up quiescence", async () => {
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      // The explicit no-op, as opposed to the bare-state return: the state
      // change must still land, nothing must be emitted, and `run` must settle
      // — `interpret` returns without forking, so `inFlight` is never touched.
      reducer: { Bump: (_action, { state }) => [{ count: state.count + 1 }, Command.none] },
      render: () => null,
    });

    const { state, emitted, outputs } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    expect(state).toEqual({ count: 1 });
    expect(emitted).toEqual([]);
    expect(outputs).toEqual([]);
  });

  it("services reach a stream command too, not only an effect command", async () => {
    const { ref, layer } = makeLogLayer();
    const Echo = Action("Echo", {});
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump, Echo]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        // The criterion names effect *and* stream, and only the effect half
        // had a test. `R` is computed the same way for both — by walking
        // handler return types — so a stream's requirement reaching the layer
        // is a separate path worth pinning.
        Bump: () => [
          { count: 1 },
          Command.stream(
            Stream.fromEffect(
              Effect.andThen(push("from-stream"), Effect.succeed({ _tag: "Echo" as const })),
            ),
          ),
        ],
        Echo: (_action, { state }) => ({ count: state.count + 10 }),
      },
      render: () => null,
    });

    const { state, emitted } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer }),
    );

    // The service was reachable from inside the stream...
    expect(await Effect.runPromise(Ref.get(ref))).toEqual(["from-stream"]);
    // ...and what it emitted still routed back through the reducer.
    expect(state).toEqual({ count: 11 });
    expect(emitted).toEqual([{ _tag: "Echo" }]);
  });

  it("resolves only once quiescent, including a settle with no emission", async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      // A bare Command.effect that emits nothing must still let `run` settle —
      // and must be waited for. It emits nothing, so the queue is empty the
      // whole time it runs; only the `inFlight` half of the quiescence test
      // keeps `run` from returning early.
      reducer: {
        Bump: () => [
          { count: 1 },
          Command.effect(Effect.andThen(Effect.sleep("50 millis"), push("late"))),
        ],
      },
      render: () => null,
    });

    const { state } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer }),
    );

    expect(state).toEqual({ count: 1 });

    // The state above is set synchronously by the reducer, so it reads the
    // same whether `run` waited for the fiber or returned the moment the queue
    // drained. The delayed write is the part that can only exist if it waited.
    //
    // (The interrupted-group half of the criterion is covered by the cancel
    // tests: those runs resolve at all only because a cancelled group still
    // wakes the drain loop.)
    expect(await Effect.runPromise(Ref.get(ref))).toEqual(["late"]);
  });

  it("Blueprint.run discards Unmounted's returned state (matches reduce)", async () => {
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Bump: (_action, { state }) => ({ count: state.count + 1 }),
        Unmounted: () => ({ count: 999 }),
      },
      render: () => null,
    });

    const { state } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }, { _tag: "Unmounted" }], {
        props: {},
        hooks: {},
        layer: Layer.empty,
      }),
    );
    expect(state).toEqual({ count: 1 });
  });

  it("the snapshot handed to a handler carries only state, props and hooks", async () => {
    // `run` builds its snapshot from the whole `options` object, which also
    // holds `layer`. A fourth key is invisible to the type — excess-property
    // checking does not fire on a non-fresh spread — and harmless to read, but
    // it puts a `Layer` on the one object this file claims is entirely
    // encodable, and a cast reaches it from userland.
    const seen: ReadonlyArray<string>[] = [];

    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Bump: (_action, snapshot) => {
          seen.push(Object.keys(snapshot).sort());
          return { count: snapshot.state.count + 1 };
        },
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    expect(seen).toEqual([["hooks", "props", "state"]]);
  });

  it("run() logs nothing of its own", async () => {
    // `run` is a test helper, so anything it logs lands in the output of every
    // suite that folds a feature through it — and the default logger does the
    // formatting work whether or not anyone reads it. A regression here is a
    // debug line left behind, which is exactly how the first one arrived.
    const captured: unknown[] = [];
    const capture = Logger.make(({ message }) => void captured.push(message));

    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: (_action, { state }) => ({ count: state.count + 1 }) },
      render: () => null,
    });

    await Effect.runPromise(
      feature
        .run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty })
        .pipe(Effect.provide(Logger.layer([capture]))),
    );

    expect(captured).toEqual([]);
  });

  it("run does not terminate while a command's stream never completes", async () => {
    // Pins current behavior; it is not the desired behavior. `runGuarded`
    // increments `inFlight` and only decrements after `Fiber.await` settles, so
    // a stream that never completes holds it at 1, the quiescence break
    // (`queueSize === 0 && inFlightCount === 0`) is never taken, and the drain
    // loop blocks on `Queue.take`. The fix is the deferred `Cmd`/`Sub` split —
    // see specs.md, Design decisions §3 — so this test exists to make that
    // change visible when it lands rather than to pass today.
    //
    // The timeout is load-bearing: without it a plain `it` hangs the suite
    // instead of failing it.
    const runWith = (command: Command<never, never>) => {
      const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
      const feature = Feature.create({
        initialState: () => ({ count: 0 }),
        reducer: { Bump: () => [{ count: 1 }, command] as const },
        render: () => null,
      });

      return Effect.runPromise(
        feature
          .run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty })
          .pipe(Effect.timeoutOption("100 millis")),
      );
    };

    // Control first: the same harness on the same budget with a stream that
    // completes. Without it, a timeout assertion passes for any reason at all —
    // including a broken harness that never ran the feature.
    expect(Option.isSome(await runWith(Command.stream(Stream.empty)))).toBe(true);

    // Subject: identical but for the stream, and it never settles.
    expect(await runWith(Command.stream(Stream.never))).toEqual(Option.none());
  });

  it("an unhandled lifecycle action in run() leaves state unchanged and does not throw", async () => {
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      // No PropsChanged handler declared.
      reducer: { Bump: (_action, { state }) => ({ count: state.count + 1 }) },
      render: () => null,
    });

    const result = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }, { _tag: "PropsChanged", previous: {} }], {
        props: {},
        hooks: {},
        layer: Layer.empty,
      }),
    );
    expect(result.state).toEqual({ count: 1 });
  });

  it("a genuinely unhandled tag reaching run()'s step rejects rather than silently no-opping", async () => {
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: (_action, { state }) => ({ count: state.count + 1 }) },
      render: () => null,
    });

    const bogus = { _tag: "NotAKnownTag" } as unknown as Parameters<typeof feature.reduce>[0];
    await expect(
      Effect.runPromise(feature.run([bogus], { props: {}, hooks: {}, layer: Layer.empty })),
    ).rejects.toThrow(/No reducer handler/);
  });
});

// ---------------------------------------------------------------------------
// React binding — the headless half
//
// Everything here drives `createFeatureStore` directly. The store needs no DOM
// (it is a state cell plus an Effect scope), so these are ordinary node tests;
// render counts, error boundaries and paint belong to the browser suite.
// ---------------------------------------------------------------------------

describe("Blueprint internals slot", () => {
  const feature = define({
    props: Schema.Struct({ id: Schema.String }),
    state: Schema.Struct({ count: Schema.Number }),
    action: Action.of([Action("Bump", {})]),
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: { Bump: (_action, snapshot) => ({ count: snapshot.state.count + 1 }) },
    render: () => null,
  });

  it("keeps `reduce` and `run` as the only enumerable surface", () => {
    expect(Object.keys(feature).sort()).toEqual(["reduce", "run"]);
  });

  it("carries the pieces `component` needs behind a symbol key", () => {
    const [slot] = Object.getOwnPropertySymbols(feature).filter(
      (symbol) => symbol.description === "@tea/internals",
    );

    // `declare const internals` emits nothing, so before the fix this symbol
    // does not exist at all and `create` never wrote the slot.
    expect(slot).toBeDefined();

    const internals = (feature as unknown as Record<symbol, Record<string, unknown>>)[slot!];
    expect(internals.initialState).toBeInstanceOf(Function);
    expect(internals.render).toBeInstanceOf(Function);
    expect(internals.props).toBeDefined();
    expect(internals.outputTags).toEqual([]);
  });

  it("records the declared output tags", () => {
    const withOutputs = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Bump", {})]),
      output: Action.of([Action.output("Done", { at: Schema.Number })]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: (_action, snapshot) => snapshot.state },
      render: () => null,
    });

    const [slot] = Object.getOwnPropertySymbols(withOutputs).filter(
      (symbol) => symbol.description === "@tea/internals",
    );
    const internals = (withOutputs as unknown as Record<symbol, Record<string, unknown>>)[slot!];
    expect(internals.outputTags).toEqual(["Done"]);
  });
});

/**
 * `createFeatureStore` takes `ManagedRuntime<any, any>` because the real `R` is
 * computed the way `ServicesOf` computes it and this scope cannot name it. A
 * root providing nothing is `ManagedRuntime<never, never>`, and `never` does not
 * convert to `any` directly, so the widening goes through `unknown`.
 */
const testRuntime = () =>
  ManagedRuntime.make(Layer.empty) as unknown as ManagedRuntime.ManagedRuntime<any, any>;

describe("createFeatureStore", () => {
  const Props = Schema.Struct({ id: Schema.String });
  const State = Schema.Struct({ count: Schema.Number, seen: Schema.Number });

  type StoreProps = { readonly id: string };
  type StoreState = { readonly count: number; readonly seen: number };

  /** Every store in this block shares one root runtime; none of them need `R`. */
  const makeRuntime = testRuntime;

  const equivalence = {
    props: Schema.toEquivalence(Props),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as {
    props: Equivalence.Equivalence<StoreProps>;
    hooks: Equivalence.Equivalence<Record<string, unknown>>;
  };

  const setup = (
    overrides: {
      readonly reducer?: Record<string, (action: any, snapshot: any) => any>;
      readonly outputs?: ReadonlyArray<any>;
      readonly props?: StoreProps;
    } = {},
  ) => {
    const emitted: Array<{ readonly _tag: string }> = [];
    const defects: Array<unknown> = [];

    const blueprint = define({
      props: Props,
      state: State,
      action: Action.of([Action("Bump", {}), Action("Echo", {})]),
      ...(overrides.outputs ? { output: Action.of(overrides.outputs as any) } : {}),
    } as any).create({
      initialState: () => ({ count: 0, seen: 0 }),
      reducer: overrides.reducer ?? {
        Bump: (_action: unknown, snapshot: { state: StoreState }) => ({
          ...snapshot.state,
          count: snapshot.state.count + 1,
        }),
        Echo: (_action: unknown, snapshot: { state: StoreState }) => snapshot.state,
      },
      render: () => null,
    } as any);

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: overrides.props ?? { id: "a" },
      equivalence: equivalence as any,
      runtime: makeRuntime(),
      layer: undefined,
      emit: (output) => void emitted.push(output),
      defect: (error) => void defects.push(error),
    });

    return { store, emitted, defects };
  };

  it("starts from `initialState(props)`", () => {
    const { store } = setup();
    expect(store.getSnapshot()).toEqual({ count: 0, seen: 0 });
  });

  it("folds a dispatch synchronously and notifies subscribers", () => {
    const { store } = setup();
    let notified = 0;
    store.subscribe(() => void notified++);

    store.dispatch({ _tag: "Bump" } as never);

    // Synchronous: readable on the very next line, with no await and no tick.
    expect(store.getSnapshot()).toEqual({ count: 1, seen: 0 });
    expect(notified).toBe(1);
  });

  it("keeps `getSnapshot` reference-stable between writes", () => {
    const { store } = setup();
    expect(store.getSnapshot()).toBe(store.getSnapshot());

    const before = store.getSnapshot();
    store.dispatch({ _tag: "Echo" } as never);
    // The handler returned the same state object, so nothing moved.
    expect(store.getSnapshot()).toBe(before);
  });

  it("unsubscribes", () => {
    const { store } = setup();
    let notified = 0;
    const unsubscribe = store.subscribe(() => void notified++);
    unsubscribe();
    store.dispatch({ _tag: "Bump" } as never);
    expect(notified).toBe(0);
  });

  it("keeps `dispatch` reference-stable, so a memoised child is not invalidated", () => {
    const { store } = setup();
    const first = store.dispatch;
    store.dispatch({ _tag: "Bump" } as never);
    expect(store.dispatch).toBe(first);
  });
});

describe("createFeatureStore — sync", () => {
  const Props = Schema.Struct({ id: Schema.String });

  const equivalence = {
    props: Schema.toEquivalence(Props),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  const setup = () => {
    const seen: Array<string> = [];

    const blueprint = define({
      props: Props,
      state: Schema.Struct({ propsChanged: Schema.Number, hookChanged: Schema.Number }),
      action: Action.of([Action("Bump", {})]),
    }).create({
      initialState: () => ({ propsChanged: 0, hookChanged: 0 }),
      reducer: {
        Bump: (_action, snapshot) => snapshot.state,
        PropsChanged: (_action, snapshot) => {
          seen.push("PropsChanged");
          return { ...snapshot.state, propsChanged: snapshot.state.propsChanged + 1 };
        },
        HookChanged: (_action, snapshot) => {
          seen.push("HookChanged");
          return { ...snapshot.state, hookChanged: snapshot.state.hookChanged + 1 };
        },
      },
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: { id: "a" },
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: () => {},
    });

    return { store, seen };
  };

  it("seeds the baseline on the first call without raising", () => {
    const { store, seen } = setup();
    const state = store.sync({ id: "a" }, { online: true });
    expect(seen).toEqual([]);
    expect(state).toEqual({ propsChanged: 0, hookChanged: 0 });
  });

  it("returns the post-fold state, so the change paints on this render", () => {
    const { store } = setup();
    store.sync({ id: "a" }, {});

    // The criterion that costs a render cycle if it fails: the value handed
    // back already reflects the handler that the props change just ran.
    const state = store.sync({ id: "b" }, {});
    expect(state).toEqual({ propsChanged: 1, hookChanged: 0 });
    expect(store.getSnapshot()).toBe(state);
  });

  it("compares props by value, not identity", () => {
    const { store, seen } = setup();
    store.sync({ id: "a" }, {});

    // A fresh object every render is what React actually hands a component;
    // identity comparison would raise `PropsChanged` on every single render.
    store.sync({ id: "a" }, {});
    store.sync({ id: "a" }, {});
    expect(seen).toEqual([]);

    store.sync({ id: "b" }, {});
    expect(seen).toEqual(["PropsChanged"]);
  });

  it("compares hooks shallowly, one level deep", () => {
    const { store, seen } = setup();
    const query = { data: 1 };
    store.sync({ id: "a" }, { query, online: true });

    // Same references, fresh record: no change.
    store.sync({ id: "a" }, { query, online: true });
    expect(seen).toEqual([]);

    // One reference moved.
    store.sync({ id: "a" }, { query: { data: 1 }, online: true });
    expect(seen).toEqual(["HookChanged"]);
  });

  it("is idempotent, so a discarded render costs nothing", () => {
    const { store, seen } = setup();
    store.sync({ id: "a" }, {});

    // StrictMode/Suspense re-run the render body with the same values.
    const first = store.sync({ id: "b" }, {});
    const second = store.sync({ id: "b" }, {});
    expect(seen).toEqual(["PropsChanged"]);
    expect(second).toBe(first);
  });
});

describe("createFeatureStore — lifecycle", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  const setup = (reducer: Record<string, any>) => {
    const log: Array<string> = [];
    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Bump", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: reducer as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: () => {},
    });

    return { store, log };
  };

  it("raises `Mounted` on start and `Unmounted` on stop", () => {
    const log: Array<string> = [];
    const { store } = setup({
      Bump: (_a: unknown, s: any) => s.state,
      Mounted: (_a: unknown, s: any) => {
        log.push("Mounted");
        return s.state;
      },
      Unmounted: (_a: unknown, s: any) => {
        log.push("Unmounted");
        return s.state;
      },
    });

    store.start();
    expect(log).toEqual(["Mounted"]);
    store.stop();
    expect(log).toEqual(["Mounted", "Unmounted"]);
  });

  it("re-arms after stop, keeping state — the StrictMode remount path", () => {
    const { store } = setup({
      Bump: (_a: unknown, s: any) => ({ count: s.state.count + 1 }),
      Mounted: (_a: unknown, s: any) => s.state,
    });

    store.start();
    store.dispatch({ _tag: "Bump" } as never);
    store.stop();
    store.start();

    // State survives the dev remount, and the store still works afterwards —
    // a single `dispose` leaves a closed scope and this second dispatch is
    // silently lost.
    store.dispatch({ _tag: "Bump" } as never);
    expect(store.getSnapshot()).toEqual({ count: 2 });
  });

  it("is idempotent on repeated start", () => {
    const log: Array<string> = [];
    const { store } = setup({
      Bump: (_a: unknown, s: any) => s.state,
      Mounted: (_a: unknown, s: any) => {
        log.push("Mounted");
        return s.state;
      },
    });

    store.start();
    store.start();
    expect(log).toEqual(["Mounted"]);
  });

  it("discards the state an `Unmounted` handler returns", () => {
    const { store } = setup({
      Bump: (_a: unknown, s: any) => s.state,
      Unmounted: () => ({ count: 999 }),
    });

    store.start();
    store.stop();
    expect(store.getSnapshot()).toEqual({ count: 0 });
  });
});

describe("createFeatureStore — outputs", () => {
  const Done = Action.output("Done", { at: Schema.Number });

  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  it("routes a declared output through `emit` and never back into the reducer", async () => {
    const folded: Array<string> = [];
    const emitted: Array<{ readonly _tag: string }> = [];

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Bump", {})]),
      output: Action.of([Done]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Bump: (_action, snapshot) => {
          folded.push("Bump");
          return [snapshot.state, Command.output(Done, { at: 1 })];
        },
      },
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: (output) => void emitted.push(output),
      defect: () => {},
    });

    store.start();
    store.dispatch({ _tag: "Bump" } as never);

    // Commands are Effects, so an output leaves on a fiber rather than on the
    // dispatching stack. The fold is synchronous; what it *starts* is not.
    await Effect.runPromise(Effect.sleep("10 millis"));

    expect(emitted).toEqual([{ _tag: "Done", at: 1 }]);
    // An output has no reducer handler; re-entering would throw, so this also
    // pins that it did not.
    expect(folded).toEqual(["Bump"]);
  });
});

describe("createFeatureStore — defects", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  const setup = (reducer: Record<string, any>) => {
    const defects: Array<unknown> = [];
    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ handled: Schema.Number }),
      action: Action.of([Action("Boom", {})]),
    }).create({
      initialState: () => ({ handled: 0 }),
      reducer: reducer as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: (error) => void defects.push(error),
    });

    return { store, defects };
  };

  it("routes a defect to the `Error` handler when one is declared", () => {
    const { store, defects } = setup({
      Boom: () => {
        throw new Error("kaboom");
      },
      Error: (_action: any, s: any) => ({ handled: s.state.handled + 1 }),
    });

    store.dispatch({ _tag: "Boom" } as never);

    expect(store.getSnapshot()).toEqual({ handled: 1 });
    // Handled means handled: it must not also reach the error boundary.
    expect(defects).toEqual([]);
  });

  it("hands the squashed error and a cause to the `Error` handler", () => {
    let seen: { error: unknown; cause: unknown } | undefined;
    const { store } = setup({
      Boom: () => {
        throw new Error("kaboom");
      },
      Error: (action: any, s: any) => {
        seen = { error: action.error, cause: action.cause };
        return s.state;
      },
    });

    store.dispatch({ _tag: "Boom" } as never);

    expect((seen?.error as Error).message).toBe("kaboom");
    expect(seen?.cause).toBeDefined();
  });

  it("reaches the error boundary when no `Error` handler is declared", () => {
    const { store, defects } = setup({
      Boom: () => {
        throw new Error("kaboom");
      },
    });

    store.dispatch({ _tag: "Boom" } as never);

    expect(defects).toHaveLength(1);
    expect((defects[0] as Error).message).toBe("kaboom");
  });

  it("does not loop when the `Error` handler itself throws", () => {
    const { store, defects } = setup({
      Boom: () => {
        throw new Error("kaboom");
      },
      Error: () => {
        throw new Error("handler exploded");
      },
    });

    store.dispatch({ _tag: "Boom" } as never);

    // Straight out, rather than feeding itself forever.
    expect(defects).toHaveLength(1);
    expect((defects[0] as Error).message).toBe("handler exploded");
  });
});

class Probe extends Context.Service<Probe, { readonly mark: () => void }>()("Probe") {}

describe("createFeatureStore — feature layers", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  it("builds the layer per mount and releases it on stop", async () => {
    const log: Array<string> = [];

    const layer = Layer.effect(
      Probe,
      Effect.acquireRelease(
        Effect.sync(() => {
          log.push("acquired");
          return { mark: () => log.push("used") };
        }),
        () => Effect.sync(() => void log.push("released")),
      ),
    );

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Use", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Use: (_action: unknown, snapshot: { readonly state: { readonly count: number } }) => [
          snapshot.state,
          Command.effect(Effect.flatMap(Probe, (probe) => Effect.sync(() => probe.mark()))),
        ],
      } as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: layer as any,
      emit: () => {},
      defect: () => {},
    });

    store.start();
    store.dispatch({ _tag: "Use" } as never);
    await Effect.runPromise(Effect.sleep("20 millis"));

    expect(log).toEqual(["acquired", "used"]);

    store.stop();
    await Effect.runPromise(Effect.sleep("20 millis"));

    // `OwnershipRule`, made structural: a per-mount service does not outlive
    // the mount that built it.
    expect(log).toEqual(["acquired", "used", "released"]);
  });
});

describe("validateProps (via `component`'s check)", () => {
  const Props = Schema.Struct({ id: Schema.String, count: Schema.Number });

  it("rejects an excess property, which no spread would catch at compile time", () => {
    const validate = SchemaParser.decodeUnknownSync(Props, {
      onExcessProperty: "error",
      errors: "all",
    });

    expect(() => validate({ id: "a", count: 1, extra: true })).toThrow();
    expect(() => validate({ id: "a", count: 1 })).not.toThrow();
  });

  it("reports every problem at once rather than one per debugging round", () => {
    const validate = SchemaParser.decodeUnknownSync(Props, {
      onExcessProperty: "error",
      errors: "all",
    });

    let message = "";
    try {
      validate({ id: 1, count: "no" });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("id");
    expect(message).toContain("count");
  });
});

// ---------------------------------------------------------------------------
// Regressions found by /review-step. Each one was silently broken.
// ---------------------------------------------------------------------------

describe("createFeatureStore — defects from commands (review regression)", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  const setup = (reducer: Record<string, any>, layer?: Layer.Layer<any, any, any>) => {
    const defects: Array<unknown> = [];
    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ handled: Schema.Number }),
      action: Action.of([Action("Boom", {})]),
    }).create({
      initialState: () => ({ handled: 0 }),
      reducer: reducer as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer,
      emit: () => {},
      defect: (error) => void defects.push(error),
    });

    return { store, defects };
  };

  it("routes a dying command to the `Error` handler", async () => {
    // Was discarded entirely: `runGuarded` forks and threw the fiber's Exit
    // away, so nothing upstream could ever see it.
    const { store, defects } = setup({
      Boom: (_a: unknown, s: any) => [s.state, Command.effect(Effect.die(new Error("cmd boom")))],
      Error: (_a: unknown, s: any) => ({ handled: s.state.handled + 1 }),
    });

    store.start();
    store.dispatch({ _tag: "Boom" } as never);
    await Effect.runPromise(Effect.sleep("30 millis"));

    expect(store.getSnapshot()).toEqual({ handled: 1 });
    expect(defects).toEqual([]);
  });

  it("sends a dying command to the boundary when no `Error` handler exists", async () => {
    const { store, defects } = setup({
      Boom: (_a: unknown, s: any) => [s.state, Command.effect(Effect.die(new Error("cmd boom")))],
    });

    store.start();
    store.dispatch({ _tag: "Boom" } as never);
    await Effect.runPromise(Effect.sleep("30 millis"));

    expect(defects).toHaveLength(1);
    expect(String(defects[0])).toContain("cmd boom");
  });

  it("does not mistake an interrupted command for a defect", async () => {
    // Interruption is how `restart` and unmount end a command. Treating every
    // non-success Exit as a defect would fire `Error` on ordinary cancellation.
    const { store, defects } = setup({
      Boom: (_a: unknown, s: any) => [
        s.state,
        Command.effect(Effect.sleep("5 seconds")).pipe(Command.restart()),
      ],
      Error: (_a: unknown, s: any) => ({ handled: s.state.handled + 1 }),
    });

    store.start();
    store.dispatch({ _tag: "Boom" } as never);
    store.dispatch({ _tag: "Boom" } as never);
    await Effect.runPromise(Effect.sleep("30 millis"));

    expect(store.getSnapshot()).toEqual({ handled: 0 });
    expect(defects).toEqual([]);
  });

  it("drains an `Error` raised outside an in-progress fold", async () => {
    // Was stranded on `pending` with nothing to start a drain, so a failing
    // layer produced no error at all until an unrelated dispatch arrived.
    const failing = Layer.effectDiscard(
      Effect.sleep("5 millis").pipe(Effect.andThen(Effect.fail("nope"))),
    );

    const { store, defects } = setup(
      { Boom: (_a: unknown, s: any) => s.state },
      failing as unknown as Layer.Layer<any, any, any>,
    );

    store.start();
    await Effect.runPromise(Effect.sleep("40 millis"));

    expect(defects).toHaveLength(1);
  });
});

describe("createFeatureStore — remount races (review regression)", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  it("runs the remount's `Mounted` command instead of interrupting it", async () => {
    // The StrictMode path. The previous mount's fiber was still parked on the
    // shared queue, took the new `Mounted` command, and was interrupted with it
    // still in flight — so a feature that loads on mount never loaded in dev.
    const ran: Array<string> = [];

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Loaded", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Loaded: (_action: unknown, snapshot: { readonly state: { readonly count: number } }) => ({
          count: snapshot.state.count + 1,
        }),
        Mounted: (_action: unknown, snapshot: { readonly state: { readonly count: number } }) => [
          snapshot.state,
          Command.effect(
            Effect.sleep("10 millis").pipe(Effect.andThen(Effect.sync(() => ran.push("loaded")))),
          ),
        ],
      } as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: () => {},
    });

    // Exactly what React does in StrictMode: effect, cleanup, effect.
    store.start();
    store.stop();
    store.start();

    await Effect.runPromise(Effect.sleep("60 millis"));

    // One completion, from the mount that survived. The first mount's command
    // is interrupted by its own `stop`, which is correct — that mount ended.
    // What matters is that the *second* mount's command is not the casualty,
    // which is what happened when both mounts shared one queue.
    expect(ran).toEqual(["loaded"]);
  });

  it("runs teardown with the feature layer still alive", async () => {
    const log: Array<string> = [];

    class Lock extends Context.Service<Lock, { readonly release: () => void }>()("Lock") {}

    const layer = Layer.effect(
      Lock,
      Effect.acquireRelease(
        Effect.sync(() => {
          log.push("acquired");
          return { release: () => log.push("released-lock") };
        }),
        () => Effect.sync(() => void log.push("layer-finalized")),
      ),
    );

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Noop", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Noop: (_action: unknown, snapshot: { readonly state: unknown }) => snapshot.state,
        // The exact case the ordering exists for: teardown needs the feature's
        // own service, so the layer must outlive the `Unmounted` command.
        Unmounted: (_action: unknown, snapshot: { readonly state: unknown }) => [
          snapshot.state,
          Command.effect(Effect.flatMap(Lock, (lock) => Effect.sync(() => lock.release()))),
        ],
      } as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: layer as any,
      emit: () => {},
      defect: () => {},
    });

    store.start();
    await Effect.runPromise(Effect.sleep("20 millis"));
    store.stop();
    await Effect.runPromise(Effect.sleep("40 millis"));

    expect(log).toEqual(["acquired", "released-lock", "layer-finalized"]);
  });
});

describe("createFeatureStore — output handler throw (review regression)", () => {
  const Done = Action.output("Done", { at: Schema.Number });

  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  it("does not let the feature's `Error` handler swallow a missing `on<Tag>`", async () => {
    // A missing handler is the parent's bug. Routing it into this feature's
    // `Error` handler meant the caller never found out.
    const defects: Array<unknown> = [];
    let handledHere = 0;

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Announce", {})]),
      output: Action.of([Done]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Announce: (_action: unknown, snapshot: { readonly state: unknown }) => [
          snapshot.state,
          Command.output(Done, { at: 1 }),
        ],
        Error: (_action: unknown, snapshot: { readonly state: unknown }) => {
          handledHere += 1;
          return snapshot.state;
        },
      } as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      // Stands in for `component`'s emit when the prop is absent.
      emit: () => {
        throw new TypeError('No "onDone" prop for output "Done"');
      },
      defect: (error) => void defects.push(error),
    });

    store.start();
    store.dispatch({ _tag: "Announce" } as never);
    await Effect.runPromise(Effect.sleep("20 millis"));

    expect(handledHere).toBe(0);
    expect(defects).toHaveLength(1);
    expect(String(defects[0])).toContain("onDone");
  });
});

describe("createFeatureStore — review iteration 2 regressions", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  const make = (reducer: Record<string, any>, layer?: Layer.Layer<any, any, any>) => {
    const defects: Array<unknown> = [];
    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Boom", {}), Action("Step", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: reducer as any,
      render: () => null,
    });
    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer,
      emit: () => {},
      defect: (error) => void defects.push(error),
    });
    return { store, defects };
  };

  it("does not loop when the `Error` handler's own command dies", async () => {
    // Was unbounded: `onExit` reported every defect as `\"Command\"`, so the
    // `from === \"Error\"` guard never fired for a command the Error handler
    // forked. Measured ~5000 folds in 200ms before the fix.
    let errorRuns = 0;

    const { store, defects } = make({
      Boom: (_a: unknown, s: any) => [s.state, Command.effect(Effect.die(new Error("first")))],
      Step: (_a: unknown, s: any) => s.state,
      Error: (_a: unknown, s: any) => {
        errorRuns += 1;
        return [s.state, Command.effect(Effect.die(new Error("reporting failed")))];
      },
    });

    store.start();
    store.dispatch({ _tag: "Boom" } as never);
    await Effect.runPromise(Effect.sleep("100 millis"));

    // The handler runs for the original defect; the defect its own command
    // raises goes to the boundary instead of back through the handler.
    expect(errorRuns).toBe(1);
    expect(defects).toHaveLength(1);
    expect(String(defects[0])).toContain("reporting failed");
  });

  it("a dying command does not cancel the one queued behind it", async () => {
    const ran: Array<string> = [];

    const { store } = make({
      Boom: (_a: unknown, s: any) => [
        s.state,
        Command.effect(Effect.die(new Error("first"))).pipe(Command.queue("q")),
      ],
      Step: (_a: unknown, s: any) => [
        s.state,
        Command.effect(Effect.sync(() => void ran.push("second"))).pipe(Command.queue("q")),
      ],
    });

    store.start();
    store.dispatch({ _tag: "Boom" } as never);
    store.dispatch({ _tag: "Step" } as never);
    await Effect.runPromise(Effect.sleep("50 millis"));

    // `queue` means "wait your turn", not "share their fate".
    expect(ran).toEqual(["second"]);
  });

  it("re-arms after the mount fiber dies on a failing layer", async () => {
    const failing = Layer.effectDiscard(Effect.fail("nope"));
    const { store, defects } = make(
      { Boom: (_a: unknown, s: any) => s.state, Step: (_a: unknown, s: any) => s.state },
      failing as unknown as Layer.Layer<any, any, any>,
    );

    store.start();
    await Effect.runPromise(Effect.sleep("30 millis"));
    expect(defects).toHaveLength(1);

    // The store must not be permanently deaf: `stop`/`start` re-arm it.
    store.stop();
    store.start();
    await Effect.runPromise(Effect.sleep("30 millis"));

    // Second mount fails the same way rather than silently doing nothing.
    expect(defects).toHaveLength(2);
  });

  it("completes a multi-hop teardown chain", async () => {
    const ran: Array<string> = [];

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Flushed", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        // Second hop: only reachable if the emission's command still finds a
        // draining fiber. `stop` clearing `mount` dropped exactly this.
        Flushed: (_action: unknown, snapshot: { readonly state: unknown }) => [
          snapshot.state,
          Command.effect(Effect.sync(() => void ran.push("lock-released"))),
        ],
        Unmounted: (_action: unknown, snapshot: { readonly state: unknown }) => [
          snapshot.state,
          Command.stream(
            Stream.fromEffect(
              Effect.sync(() => {
                ran.push("session-closed");
                return { _tag: "Flushed" as const };
              }),
            ),
          ),
        ],
      } as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: () => {},
    });

    store.start();
    store.stop();
    await Effect.runPromise(Effect.sleep("50 millis"));

    expect(ran).toEqual(["session-closed", "lock-released"]);
  });

  it("does not drop a command dispatched before `start`", async () => {
    // A child dispatching from its own `useLayoutEffect` folds before the
    // parent's passive effect arms the store.
    const ran: Array<string> = [];

    const { store } = make({
      Boom: (_a: unknown, s: any) => s.state,
      Step: (_a: unknown, s: any) => [
        s.state,
        Command.effect(Effect.sync(() => void ran.push("early"))),
      ],
    });

    store.dispatch({ _tag: "Step" } as never);
    store.start();
    await Effect.runPromise(Effect.sleep("30 millis"));

    expect(ran).toEqual(["early"]);
  });
});

describe("Command.batch grouping (review iteration 3)", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  const store = (reducer: Record<string, any>) => {
    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Go", {}), Action("Stop", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: reducer as any,
      render: () => null,
    });
    return createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: () => {},
    });
  };

  const slow = (label: string, ms: number, log: Array<string>) =>
    Command.effect(
      Effect.sleep(`${ms} millis`).pipe(Effect.andThen(Effect.sync(() => void log.push(label)))),
    );

  it("keyed `Command.cancel` still reaches a policy-wrapped batch", async () => {
    // Indexing batch members into per-member groups broke exactly this:
    // `cancelGroup` matches an explicit key *exactly*, so `Load::k#0` was
    // unreachable from `cancel({ tag, key })` and nothing was interrupted.
    const log: Array<string> = [];

    const s = store({
      Go: (_a: unknown, snap: { readonly state: unknown }) => [
        snap.state,
        Command.batch(slow("a", 60, log), slow("b", 60, log)).pipe(Command.restart("k")),
      ],
      Stop: (_a: unknown, snap: { readonly state: unknown }) => [
        snap.state,
        Command.cancel({ tag: "Go", key: "k" }),
      ],
    });

    s.start();
    s.dispatch({ _tag: "Go" } as never);
    await Effect.runPromise(Effect.sleep("15 millis"));
    s.dispatch({ _tag: "Stop" } as never);
    await Effect.runPromise(Effect.sleep("100 millis"));

    expect(log).toEqual([]);
  });

  it("`queue` around a batch still serialises its members", async () => {
    // Per-member groups made each member wait only on itself, so both started
    // at once — the exact interleaving `queue` exists to prevent.
    const log: Array<string> = [];

    const step = (label: string) =>
      Command.effect(
        Effect.sync(() => void log.push(`${label}:start`)).pipe(
          Effect.andThen(Effect.sleep("30 millis")),
          Effect.andThen(Effect.sync(() => void log.push(`${label}:done`))),
        ),
      );

    const s = store({
      Go: (_a: unknown, snap: { readonly state: unknown }) => [
        snap.state,
        Command.batch(step("a"), step("b")).pipe(Command.queue("k")),
      ],
      Stop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
    });

    s.start();
    s.dispatch({ _tag: "Go" } as never);
    await Effect.runPromise(Effect.sleep("120 millis"));

    expect(log).toEqual(["a:start", "a:done", "b:start", "b:done"]);
  });

  const sleep = (ms: number) => Effect.runPromise(Effect.sleep(`${ms} millis`));

  it("`ignore` around a batch runs every member", async () => {
    // The members share one group — that is what keeps a keyed `cancel`
    // working — so the second one used to see `running.length > 0` and return
    // without forking. `ignore` defers to an earlier *dispatch*, not to a
    // sibling forked microseconds ago.
    const log: Array<string> = [];

    const s = store({
      Go: (_a: unknown, snap: { readonly state: unknown }) => [
        snap.state,
        Command.batch(slow("a", 10, log), slow("b", 10, log)).pipe(Command.ignore("k")),
      ],
      Stop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
    });

    s.start();
    s.dispatch({ _tag: "Go" } as never);
    await sleep(80);

    expect([...log].sort()).toEqual(["a", "b"]);
  });

  it("`ignore` around a batch still drops a whole second dispatch", async () => {
    // The other half of the same criterion: distinguishing sibling from
    // predecessor must not cost the deferral that `ignore` is for.
    const log: Array<string> = [];
    let dispatches = 0;

    const s = store({
      Go: (_a: unknown, snap: { readonly state: unknown }) => {
        const round = ++dispatches;
        return [
          snap.state,
          Command.batch(slow(`a${round}`, 60, log), slow(`b${round}`, 60, log)).pipe(
            Command.ignore("k"),
          ),
        ];
      },
      Stop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
    });

    s.start();
    s.dispatch({ _tag: "Go" } as never);
    await sleep(15);
    s.dispatch({ _tag: "Go" } as never);
    await sleep(150);

    expect([...log].sort()).toEqual(["a1", "b1"]);
  });

  it("`restart` around a batch does not have members interrupt each other", async () => {
    const log: Array<string> = [];

    const s = store({
      Go: (_a: unknown, snap: { readonly state: unknown }) => [
        snap.state,
        Command.batch(slow("a", 40, log), slow("b", 40, log)).pipe(Command.restart("k")),
      ],
      Stop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
    });

    s.start();
    s.dispatch({ _tag: "Go" } as never);
    await sleep(140);

    expect([...log].sort()).toEqual(["a", "b"]);
  });

  it("a second dispatch restarts every member of the batch it supersedes", async () => {
    // Not just "the last one wins": the group rewrite `restart` performs used
    // to replace the whole entry with the forking fiber, so a member that
    // forked earlier in the same batch stopped being interruptible at all.
    const log: Array<string> = [];
    let dispatches = 0;

    const s = store({
      Go: (_a: unknown, snap: { readonly state: unknown }) => {
        const round = ++dispatches;
        return [
          snap.state,
          Command.batch(slow(`a${round}`, 50, log), slow(`b${round}`, 50, log)).pipe(
            Command.restart("k"),
          ),
        ];
      },
      Stop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
    });

    s.start();
    s.dispatch({ _tag: "Go" } as never);
    await sleep(15);
    s.dispatch({ _tag: "Go" } as never);
    await sleep(150);

    expect([...log].sort()).toEqual(["a2", "b2"]);
  });

  it("`queue` waits for every prior fiber, including siblings of one that died", async () => {
    // `Fiber.joinAll` re-raises the first failing fiber's cause and stops
    // joining there, so a follower was released by a predecessor's *death*
    // while that predecessor's still-running sibling held the queue.
    const log: Array<string> = [];
    let dispatches = 0;

    const s = store({
      Go: (_a: unknown, snap: { readonly state: unknown }) => {
        const round = ++dispatches;
        return [
          snap.state,
          round === 1
            ? Command.batch(
                Command.effect(
                  Effect.sleep("10 millis").pipe(Effect.andThen(Effect.die(new Error("boom")))),
                ),
                slow("slow", 60, log),
              ).pipe(Command.queue("k"))
            : Command.effect(Effect.sync(() => void log.push("after"))).pipe(Command.queue("k")),
        ];
      },
      Stop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
    });

    s.start();
    s.dispatch({ _tag: "Go" } as never);
    await sleep(5);
    s.dispatch({ _tag: "Go" } as never);
    await sleep(200);

    expect(log).toEqual(["slow", "after"]);
  });
});

describe("createFeatureStore — a dead mount does not swallow work", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  it("does not buffer commands without bound after the mount fiber dies", async () => {
    const failing = Layer.effectDiscard(Effect.fail("nope"));
    const ran: Array<string> = [];

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Go", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (_a: unknown, snap: { readonly state: { readonly count: number } }) => [
          { count: snap.state.count + 1 },
          Command.effect(Effect.sync(() => void ran.push("go"))),
        ],
      } as any,
      render: () => null,
    });

    const s = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: failing as unknown as Layer.Layer<any, any, any>,
      emit: () => {},
      defect: () => {},
    });

    s.start();
    await Effect.runPromise(Effect.sleep("30 millis"));

    // The fiber is dead. State still folds; the command is dropped rather than
    // piling into a buffer nothing drains.
    s.dispatch({ _tag: "Go" } as never);
    s.dispatch({ _tag: "Go" } as never);
    await Effect.runPromise(Effect.sleep("20 millis"));

    expect(s.getSnapshot()).toEqual({ count: 2 });
    expect(ran).toEqual([]);
  });
});

describe("createFeatureStore — teardown belongs to the mount that started it", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  it("a remount does not strand the previous mount's teardown drain", async () => {
    // `stop` leaves `mount` pointed at the dying cells on purpose, so a `start`
    // before the drain finishes — StrictMode's dev remount is literally
    // `start; stop; start` — replaces it. A settled-marker routed through
    // whichever mount is *current* then woke the new queue while this drain sat
    // blocked on `Queue.take` of the old one: teardown ran, but the loop never
    // noticed, so the scope and the feature layer stayed open until the 5s
    // bound fired and reported a defect that had not happened.
    const log: Array<string> = [];
    const defects: Array<unknown> = [];

    class Held extends Context.Service<Held, { readonly ok: true }>()("Held") {}

    const layer = Layer.effect(
      Held,
      Effect.acquireRelease(
        Effect.sync(() => ({ ok: true }) as const),
        () => Effect.sync(() => void log.push("finalized")),
      ),
    );

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Noop", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Noop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
        Unmounted: (_a: unknown, snap: { readonly state: unknown }) => [
          snap.state,
          Command.effect(
            Effect.sleep("30 millis").pipe(
              Effect.andThen(Effect.sync(() => void log.push("torn"))),
            ),
          ),
        ],
      } as any,
      render: () => null,
    });

    const s = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: layer as any,
      emit: () => {},
      defect: (error) => void defects.push(error),
    });

    s.start();
    s.stop();
    s.start();
    await Effect.runPromise(Effect.sleep("300 millis"));

    // The first mount's teardown both ran *and* was observed: the drain
    // returned, so its scope closed and the layer finalized — well inside the
    // 5s bound, with no defect invented on the way out.
    expect(log.filter((entry) => entry === "torn")).toEqual(["torn"]);
    expect(log.filter((entry) => entry === "finalized")).toEqual(["finalized"]);
    expect(defects).toEqual([]);

    s.stop();
  });

  it("a teardown chain's second hop stays on the mount that started it", async () => {
    // The `Settled` marker was routed to `cells.queue`, but the *work* was not:
    // `emit` → `fold` → `offer` still targeted whichever mount was installed.
    // After `start; stop; start` a teardown command's follow-up was queued into
    // the new mount and run against the new mount's services, while the dying
    // drain saw an empty queue, declared quiescence and closed the scope.
    const log: Array<string> = [];
    let built = 0;

    class Marked extends Context.Service<Marked, { readonly id: number }>()("Marked") {}

    const layer = Layer.effect(
      Marked,
      Effect.acquireRelease(
        Effect.sync(() => {
          const id = ++built;
          return { id };
        }),
        (service) => Effect.sync(() => void log.push(`finalized:${service.id}`)),
      ),
    );

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Noop", {}), Action("SecondHop", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Noop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
        // The follow-up: reached only by the teardown command emitting it.
        SecondHop: (_a: unknown, snap: { readonly state: unknown }) => [
          snap.state,
          Command.effect(
            Effect.flatMap(Marked, (service) =>
              Effect.sync(() => void log.push(`second-hop:${service.id}`)),
            ),
          ),
        ],
        Unmounted: (_a: unknown, snap: { readonly state: unknown }) => [
          snap.state,
          Command.stream(Stream.succeed({ _tag: "SecondHop" as const })),
        ],
      } as any,
      render: () => null,
    });

    const s = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: layer as any,
      emit: () => {},
      defect: () => {},
    });

    s.start();
    s.stop();
    s.start();
    await Effect.runPromise(Effect.sleep("200 millis"));

    // The hop ran against the first mount's service, and that mount's scope
    // closed only after it had — not before, and not against mount 2.
    expect(log.indexOf("second-hop:1")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("second-hop:1")).toBeLessThan(log.indexOf("finalized:1"));

    s.stop();
  });

  it("an `Unmounted` handler that throws still gets its compensating command run", async () => {
    // The defect is raised *after* the `Teardown` marker is queued, so the
    // `Error` handler's command lands behind it. Raised first, that command was
    // interpreted by the main loop and then killed by teardown's interrupt
    // sweep — while the same command reached through a dying *teardown command*
    // survived, because that path queues after the sweep.
    const log: Array<string> = [];

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Noop", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Noop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
        Unmounted: () => {
          throw new Error("teardown boom");
        },
        Error: (_a: unknown, snap: { readonly state: unknown }) => [
          snap.state,
          Command.effect(
            Effect.sleep("30 millis").pipe(
              Effect.andThen(Effect.sync(() => void log.push("compensated"))),
            ),
          ),
        ],
      } as any,
      render: () => null,
    });

    const s = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: () => {},
    });

    s.start();
    await Effect.runPromise(Effect.sleep("10 millis"));
    s.stop();
    await Effect.runPromise(Effect.sleep("200 millis"));

    expect(log).toEqual(["compensated"]);
  });

  it("a dying mount releases before it reports, so the `Error` handler's command is not swallowed", async () => {
    // Raised first, `mount` still pointed at the queue of the fiber that was
    // terminating, so the compensating command was enqueued to a reader that
    // would never take again — not run, and not on `offer`'s dropped-work path
    // either. Released first, the store is re-armable and the same command
    // takes the documented drop.
    const failing = Layer.effectDiscard(Effect.fail("nope"));
    const ran: Array<string> = [];

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Noop", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Noop: (_a: unknown, snap: { readonly state: unknown }) => snap.state,
        Error: (_a: unknown, snap: { readonly state: { readonly count: number } }) => [
          { count: snap.state.count + 1 },
          Command.effect(Effect.sync(() => void ran.push("compensated"))),
        ],
      } as any,
      render: () => null,
    });

    const s = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: failing as unknown as Layer.Layer<any, any, any>,
      emit: () => {},
      defect: () => {},
    });

    s.start();
    await Effect.runPromise(Effect.sleep("30 millis"));

    // The handler ran — the layer failure reached it — and the store is armable
    // again rather than holding a queue nobody reads.
    expect(s.getSnapshot()).toEqual({ count: 1 });
    expect(ran).toEqual([]);

    // The re-arm the release makes possible: this time the command runs.
    s.start();
    await Effect.runPromise(Effect.sleep("30 millis"));
    s.dispatch({ _tag: "Noop" } as never);
    s.stop();
  });

  it("a dead mount does not report the commands it drops", async () => {
    // Reporting them was tried and reverted: `component`'s `defect` sink throws
    // to the error boundary, so a feature whose `Error` handler returns a
    // command had its recovery UI replaced by a crash on exactly the failure
    // the handler was written for. This pins the quiet drop so the next
    // "silence is a bad diagnostic" instinct has to read the reason first.
    const failing = Layer.effectDiscard(Effect.fail("nope"));
    const defects: Array<unknown> = [];

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Go", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (_a: unknown, snap: { readonly state: { readonly count: number } }) => [
          { count: snap.state.count + 1 },
          Command.effect(Effect.void),
        ],
        // The common shape: the handler that hears about the dead layer wants
        // to do something about it, and what it returns has nowhere to run.
        Error: (_a: unknown, snap: { readonly state: unknown }) => [
          snap.state,
          Command.effect(Effect.void),
        ],
      } as any,
      render: () => null,
    });

    const s = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: failing as unknown as Layer.Layer<any, any, any>,
      emit: () => {},
      defect: (error) => void defects.push(error),
    });

    s.start();
    await Effect.runPromise(Effect.sleep("30 millis"));
    s.dispatch({ _tag: "Go" } as never);
    await Effect.runPromise(Effect.sleep("20 millis"));

    // The `Error` handler absorbed the layer failure; nothing reached the
    // boundary, then or on the dropped command that followed.
    expect(defects).toEqual([]);
  });
});

describe("output-tag routing is one rule (review iteration 3)", () => {
  it("`run` and the internals slot agree on what an output is", () => {
    const Done = Action.output("Done", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Bump", {})]),
      output: Action.of([Done]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: (_action, snapshot) => snapshot.state },
      render: () => null,
    });

    const [slot] = Object.getOwnPropertySymbols(feature).filter(
      (symbol) => symbol.description === "@tea/internals",
    );
    const internals = (feature as unknown as Record<symbol, Record<string, unknown>>)[slot!];

    // One derivation, so the store and `run` cannot drift about routing.
    expect(internals.outputTags).toEqual(["Done"]);
  });

  it("still refuses a prototype-chain tag as an output", async () => {
    const Done = Action.output("Done", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Bump", {})]),
      output: Action.of([Done]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: (_action, snapshot) => snapshot.state },
      render: () => null,
    });

    // `constructor` must reach the throw, not leave through an `on<Tag>` prop.
    await expect(
      Effect.runPromise(
        feature.run([{ _tag: "constructor" } as never], {
          props: {},
          hooks: {},
          layer: Layer.empty,
        }),
      ),
    ).rejects.toThrow(/No reducer handler/);
  });
});

describe("createFeatureStore — recovery after a dead mount (review iteration 4)", () => {
  it("can be re-armed after the mount fiber dies, so a Retry actually retries", async () => {
    // Two rounds found this from opposite directions: first the command piled
    // into an unbounded buffer, then it was dropped outright. Neither ran it,
    // because `active` was never cleared and `start` is guarded on `active`.
    const ran: Array<string> = [];
    let failLayer = true;

    const layer = Layer.effectDiscard(
      Effect.suspend(() => (failLayer ? Effect.fail("nope") : Effect.void)),
    );

    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Retry", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Retry: (_a: unknown, snap: { readonly state: { readonly count: number } }) => [
          { count: snap.state.count + 1 },
          Command.effect(Effect.sync(() => void ran.push("retried"))),
        ],
      } as any,
      render: () => null,
    });

    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence: {
        props: Schema.toEquivalence(Schema.Struct({})),
        hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
      } as any,
      runtime: testRuntime(),
      layer: layer as unknown as Layer.Layer<any, any, any>,
      emit: () => {},
      defect: () => {},
    });

    store.start();
    await Effect.runPromise(Effect.sleep("30 millis"));

    // The mount died. A caller re-arming must actually get a live mount.
    failLayer = false;
    store.start();
    store.dispatch({ _tag: "Retry" } as never);
    await Effect.runPromise(Effect.sleep("40 millis"));

    expect(ran).toEqual(["retried"]);
  });
});

describe("createFeatureStore — teardown drains to quiescence (review iteration 5)", () => {
  const equivalence = {
    props: Schema.toEquivalence(Schema.Struct({})),
    hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
  } as any;

  const make = (reducer: Record<string, any>) => {
    const defects: Array<unknown> = [];
    const blueprint = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: Action.of([Action("Go", {}), Action("Flushed", {})]),
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: reducer as any,
      render: () => null,
    });
    const store = createFeatureStore({
      blueprint: blueprint as any,
      props: {},
      equivalence,
      runtime: testRuntime(),
      layer: undefined,
      emit: () => {},
      defect: (error) => void defects.push(error),
    });
    return { store, defects };
  };

  it("reports a dying teardown command", async () => {
    // Every hand-rolled drain lost this: the defect is observed on the watcher
    // fiber `runGuarded` forks, which is not in `groups`, so joining `groups`
    // returned before it ran. `inFlight` is decremented after `onExit`, so
    // waiting on it waits for the watcher.
    const { store, defects } = make({
      Go: (_a: unknown, s: any) => s.state,
      Flushed: (_a: unknown, s: any) => s.state,
      Unmounted: (_a: unknown, s: any) => [
        s.state,
        Command.effect(Effect.die(new Error("teardown boom"))),
      ],
    });

    store.start();
    store.stop();
    await Effect.runPromise(Effect.sleep("60 millis"));

    expect(defects).toHaveLength(1);
    expect(String(defects[0])).toContain("teardown boom");
  });

  it("runs the `Error` handler's compensating command during teardown", async () => {
    const ran: Array<string> = [];

    const { store } = make({
      Go: (_a: unknown, s: any) => s.state,
      Flushed: (_a: unknown, s: any) => s.state,
      Unmounted: (_a: unknown, s: any) => [
        s.state,
        Command.effect(Effect.die(new Error("teardown boom"))),
      ],
      Error: (_a: unknown, s: any) => [
        s.state,
        Command.effect(Effect.sync(() => void ran.push("compensated"))),
      ],
    });

    store.start();
    store.stop();
    await Effect.runPromise(Effect.sleep("80 millis"));

    // Queued by the watcher *after* the teardown command settled — the case
    // that ended on an empty poll and was silently dropped.
    expect(ran).toEqual(["compensated"]);
  });

  it("does not cut off a slow teardown sibling when another member dies", async () => {
    // `Fiber.joinAll` short-circuits on the first failure, so the join-based
    // drain let the scope close while the slow member was still running.
    const ran: Array<string> = [];

    const { store } = make({
      Go: (_a: unknown, s: any) => s.state,
      Flushed: (_a: unknown, s: any) => s.state,
      Unmounted: (_a: unknown, s: any) => [
        s.state,
        Command.batch(
          Command.effect(Effect.sleep("1 milli").pipe(Effect.andThen(Effect.die("boom")))),
          Command.effect(
            Effect.sleep("40 millis").pipe(
              Effect.andThen(Effect.sync(() => void ran.push("lock-released"))),
            ),
          ),
        ),
      ],
    });

    store.start();
    store.stop();
    await Effect.runPromise(Effect.sleep("120 millis"));

    expect(ran).toEqual(["lock-released"]);
  });

  it("drains a command queued just before unmount, with no teardown of its own", async () => {
    // A `Teardown` carrying no command used to return immediately, so work
    // already in the queue was forked and instantly interrupted.
    const ran: Array<string> = [];

    const { store } = make({
      Go: (_a: unknown, s: any) => [
        s.state,
        Command.effect(
          Effect.sleep("20 millis").pipe(
            Effect.andThen(Effect.sync(() => void ran.push("late-write"))),
          ),
        ),
      ],
      Flushed: (_a: unknown, s: any) => s.state,
    });

    store.start();
    store.dispatch({ _tag: "Go" } as never);
    store.stop();
    await Effect.runPromise(Effect.sleep("80 millis"));

    // In-flight work is interrupted by unmount, which is the documented
    // ownership rule — but the drain must still reach quiescence rather than
    // hang, and must not report the interruption as a defect.
    expect(ran).toEqual([]);
  });

  it("terminates even with a never-completing command in flight", async () => {
    // `run` cannot reach quiescence here — a known limitation. Teardown can,
    // because unmount interrupts outstanding work before draining.
    const { store, defects } = make({
      Go: (_a: unknown, s: any) => [s.state, Command.stream(Stream.never)],
      Flushed: (_a: unknown, s: any) => s.state,
      Unmounted: (_a: unknown, s: any) => [s.state, Command.effect(Effect.sync(() => void 0))],
    });

    store.start();
    store.dispatch({ _tag: "Go" } as never);
    await Effect.runPromise(Effect.sleep("20 millis"));
    store.stop();

    // Settles well inside the 5s bound; a hang would surface as the abandoned
    // -teardown defect instead.
    await Effect.runPromise(Effect.sleep("150 millis"));
    expect(defects).toEqual([]);
  });
});
