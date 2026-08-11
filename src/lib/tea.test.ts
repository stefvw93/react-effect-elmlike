/**
 * Unit tests for `tea.ts`, against `tea.specs.md`'s Acceptance Criteria.
 *
 * `createRuntime` (and its returned `{ Provider, component, useRuntime }`) is
 * out of scope — see specs.md. Everything else with a real implementation is
 * covered here.
 */

import { Context, Effect, Layer, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Action, Command, define, Next } from "./tea";

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

  it("an unhandled lifecycle action leaves state unchanged and does not throw", () => {
    // PropsChanged has no handler on `counter` above.
    expect(() =>
      counter.reduce({ _tag: "PropsChanged", previous: at(10).props }, at(10)),
    ).not.toThrow();
    const next = counter.reduce({ _tag: "PropsChanged", previous: at(10).props }, at(10));
    expect(Next.state(next)).toEqual({ count: 10 });
  });

  it("a genuinely unhandled tag (not a lifecycle tag) throws rather than silently no-opping", () => {
    // Reachable only by bypassing the typed surface — every declared action
    // tag is required in `reducer` by `Reducer`'s type, so this simulates a
    // bad cast or a malformed replay, not a legitimate dispatch.
    const bogus = { _tag: "NotAKnownTag" } as unknown as Parameters<typeof counter.reduce>[0];
    expect(() => counter.reduce(bogus, at(10))).toThrow(/No reducer handler/);
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
    // ...but callers must not read `Next.state(next)` as the new state — the
    // runtime (and `run`, below) is what actually discards it.
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
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: { Bump: (_action, { state }) => ({ count: state.count + 1 }) },
      render: () => null,
    });

    const { state, emitted } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );

    expect(state).toEqual({ count: 1 });
    expect(emitted).toEqual([]);
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
      action: Action.of([Go, Action("Stop", { id: Schema.String })]),
    });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(Effect.andThen(Effect.sleep("30 millis"), push(`${action.id}:done`))).pipe(
            Command.queue(action.id),
          ),
        ],
        Stop: (action) => [{ count: 0 }, Command.cancel({ tag: "Go", key: action.id })],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 0, id: "a" },
          { _tag: "Go", ms: 0, id: "b" },
          { _tag: "Stop", id: "a" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).not.toContain("a:done");
    expect(log).toContain("b:done");
  });

  it('policy "restart" interrupts the prior in-flight fiber in the same group', async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.ensuring(
              Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
              push(`${action.id}:ensuring`),
            ),
          ).pipe(Command.restart("group")),
        ],
      },
      render: () => null,
    });

    await Effect.runPromise(
      feature.run(
        [
          { _tag: "Go", ms: 50, id: "first" },
          { _tag: "Go", ms: 0, id: "second" },
        ],
        { props: {}, hooks: {}, layer },
      ),
    );

    const log = await Effect.runPromise(Ref.get(ref));
    expect(log).not.toContain("first:done");
    expect(log).toContain("second:done");
  });

  it('policy "ignore" drops a new dispatch while one is in-flight', async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
          ).pipe(Command.ignore("group")),
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

  it('policy "queue" defers a new dispatch until the prior settles; both complete', async () => {
    const { ref, layer } = makeLogLayer();
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Go]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Go: (action) => [
          { count: 0 },
          Command.effect(
            Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
          ).pipe(Command.queue("group")),
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
    expect(log).toEqual(["first:done", "second:done"]);
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
            Effect.andThen(Effect.sleep(`${action.ms} millis`), push(`${action.id}:done`)),
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
    expect(log).toContain("first:done");
    expect(log).toContain("second:done");
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

  it("resolves only once quiescent, including a settle with no emission", async () => {
    const Feature = define({ props: RunProps, state: RunState, action: Action.of([Bump]) });
    const feature = Feature.create({
      initialState: () => ({ count: 0 }),
      // A bare Command.effect that emits nothing must still let `run` settle.
      reducer: { Bump: () => [{ count: 1 }, Command.effect(Effect.sleep("5 millis"))] },
      render: () => null,
    });

    const { state } = await Effect.runPromise(
      feature.run([{ _tag: "Bump" }], { props: {}, hooks: {}, layer: Layer.empty }),
    );
    expect(state).toEqual({ count: 1 });
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
