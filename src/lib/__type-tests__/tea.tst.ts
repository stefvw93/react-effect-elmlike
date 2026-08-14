import { Effect, Layer, Schema } from "effect";
import { expect, test } from "tstyche";
import type { ReactNode } from "react";
import {
  Action,
  type AnyVocabulary,
  type ChannelOf,
  Children,
  Command,
  createRuntime,
  define,
  type Dispatcher,
  type Disjoint,
  type Exhaustive,
  type MemberOf,
  type Message,
  type NoPropCollision,
  type NoTransform,
  type OutputProps,
  type ServicesOf,
  type TagsOf,
} from "../tea";

// ---------------------------------------------------------------------------
// Channel brand
// ---------------------------------------------------------------------------

test("the channel brand keeps internal and outbound messages mutually unassignable", () => {
  const ActionFoo = Action("Foo", { id: Schema.String });
  const OutputFoo = Action.output("Foo", { id: Schema.String });

  // Positive control: same tag, same fields, same channel stays assignable, so
  // the two rejections below are attributable to the brand rather than to some
  // unrelated structural difference between the two constructors.
  const ActionFooAgain = Action("Foo", { id: Schema.String });
  expect(ActionFoo).type.toBeAssignableTo<typeof ActionFooAgain>();

  expect(ActionFoo).type.not.toBeAssignableTo<typeof OutputFoo>();
  expect(OutputFoo).type.not.toBeAssignableTo<typeof ActionFoo>();

  // Stated on `Message` directly, since that is what the criterion is about:
  // the phantom, not the constructor that happened to apply it.
  type Fields = { readonly id: typeof Schema.String };
  expect<Message<"Foo", Fields, "internal">>().type.not.toBeAssignableTo<
    Message<"Foo", Fields, "outbound">
  >();
  expect<Message<"Foo", Fields, "outbound">>().type.not.toBeAssignableTo<
    Message<"Foo", Fields, "internal">
  >();
});

test("a reserved lifecycle tag cannot be declared as an action or output", () => {
  // Reserved tag: `NotLifecycleTag` narrows the guard to `never`, so the
  // literal argument can no longer satisfy the parameter.
  // @ts-expect-error is not assignable to parameter of type 'never'
  Action("Mounted", {});
  // @ts-expect-error is not assignable to parameter of type 'never'
  Action.output("Unmounted", {});

  // Every reserved tag, on both constructors. Two spot checks left three tags
  // unpinned — `HookChanged` most of all, being the newest member of
  // `LifecycleTag` and so the likeliest to be dropped by a refactor.
  expect(Action).type.not.toBeCallableWith("Mounted", {});
  expect(Action).type.not.toBeCallableWith("PropsChanged", {});
  expect(Action).type.not.toBeCallableWith("HookChanged", {});
  expect(Action).type.not.toBeCallableWith("Error", {});
  expect(Action).type.not.toBeCallableWith("Unmounted", {});

  expect(Action.output).type.not.toBeCallableWith("Mounted", {});
  expect(Action.output).type.not.toBeCallableWith("PropsChanged", {});
  expect(Action.output).type.not.toBeCallableWith("HookChanged", {});
  expect(Action.output).type.not.toBeCallableWith("Error", {});
  expect(Action.output).type.not.toBeCallableWith("Unmounted", {});

  // Control: an unreserved capitalised tag is still accepted, so the ten
  // rejections above are `NotLifecycleTag` and not a broken signature.
  expect(Action).type.toBeCallableWith("Mount", {});
  expect(Action.output).type.toBeCallableWith("Unmount", {});
});

// ---------------------------------------------------------------------------
// Command.output — channel enforced at the point of use
// ---------------------------------------------------------------------------

test("`Command.output` rejects an internal message, accepts an outbound one", () => {
  const InternalFoo = Action("Foo", {});
  const OutboundFoo = Action.output("Foo", {});

  expect(Command.output).type.not.toBeCallableWith(InternalFoo, {});
  expect(Command.output).type.toBeCallableWith(OutboundFoo, {});

  // The payload is the message's fields minus `_tag`, so the discriminant
  // comes from the message and never from the caller. Without these, the
  // channel is checked but the thing being announced is not.
  const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });

  expect(Command.output).type.toBeCallableWith(OrderPlaced, { orderId: "order_1" });
  expect(Command.output).type.not.toBeCallableWith(OrderPlaced, {});
  expect(Command.output).type.not.toBeCallableWith(OrderPlaced, { orderId: 1 });
  expect(Command.output).type.not.toBeCallableWith(OrderPlaced, {
    _tag: "OrderPlaced",
    orderId: "order_1",
  });
});

// ---------------------------------------------------------------------------
// Vocabulary composition (`.of`), flattening
// ---------------------------------------------------------------------------

test("`.of` composes members and flattens nested vocabularies into `cases`", () => {
  const Started = Action("Started", {});
  const Failed = Action("Failed", { reason: Schema.String });
  const Async = Action.of([Started, Failed]);
  const CheckoutRequested = Action("CheckoutRequested", {});
  const CartActions = Action.of([Async, CheckoutRequested]);

  expect<TagsOf<typeof CartActions>>().type.toBe<"Started" | "Failed" | "CheckoutRequested">();
  expect<MemberOf<typeof CartActions>>().type.toBe<
    | { readonly _tag: "Started" }
    | { readonly _tag: "Failed"; readonly reason: string }
    | { readonly _tag: "CheckoutRequested" }
  >();
});

test("`.of` reads its channel off the members rather than being told", () => {
  const Internal = Action.of([Action("Foo", {})]);
  const Outbound = Action.of([Action.output("Bar", {})]);

  // The brand is what `define` checks, so proving it survives inference is the
  // whole point of dropping the per-channel `of`.
  expect<ChannelOf<readonly [typeof Internal]>>().type.toBe<"internal">();
  expect<ChannelOf<readonly [typeof Outbound]>>().type.toBe<"outbound">();

  expect(Internal).type.toBeAssignableTo<AnyVocabulary<"internal">>();
  expect(Internal).type.not.toBeAssignableTo<AnyVocabulary<"outbound">>();
  expect(Outbound).type.toBeAssignableTo<AnyVocabulary<"outbound">>();
  expect(Outbound).type.not.toBeAssignableTo<AnyVocabulary<"internal">>();

  // And there is no per-channel `of` to disagree with the brand: the outbound
  // constructor is a bare `MessageConstructor`, call signature and nothing
  // else, so `Action.output.of` cannot be written.
  expect<keyof typeof Action.output>().type.toBe<never>();
});

test("`.of` rejects a member list that straddles both channels", () => {
  // Positive control: without it the rejection below passes vacuously for any
  // reason `.of` might be uncallable, rather than because of `SameChannel`.
  expect(Action.of).type.toBeCallableWith([Action("Foo", {}), Action("Baz", {})]);
  expect(Action.of).type.toBeCallableWith([Action.output("Bar", {}), Action.output("Qux", {})]);

  expect(Action.of).type.not.toBeCallableWith([Action("Foo", {}), Action.output("Bar", {})]);

  // Empty is the one ambiguous list: it satisfies both guards, so the channel
  // is unresolvable and `ChannelOf` refuses rather than picking one.
  expect<ChannelOf<readonly []>>().type.toBe<never>();
});

// ---------------------------------------------------------------------------
// Disjoint
// ---------------------------------------------------------------------------

test("`Disjoint` rejects an action/output tag collision", () => {
  const Actions = Action.of([Action("Foo", {})]);
  const NonCollidingOutputs = Action.of([Action.output("Bar", {})]);
  const CollidingOutputs = Action.of([Action.output("Foo", {})]);

  expect<Disjoint<typeof Actions, typeof NonCollidingOutputs>>().type.toBe<unknown>();
  expect<Disjoint<typeof Actions, typeof CollidingOutputs>>().type.toBe<never>();

  // Computing to `never` is only half of it — the guard has to be *wired* to
  // `define`'s `output` property. Intersected onto the wrong one, or dropped,
  // the two assertions above stay green while a colliding pair compiles.
  const props = Schema.Struct({});
  const state = Schema.Struct({});

  expect(define).type.toBeCallableWith({ props, state, action: Actions });
  expect(define).type.toBeCallableWith({
    props,
    state,
    action: Actions,
    output: NonCollidingOutputs,
  });
  expect(define).type.not.toBeCallableWith({
    props,
    state,
    action: Actions,
    output: CollidingOutputs,
  });
});

// ---------------------------------------------------------------------------
// NoPropCollision
// ---------------------------------------------------------------------------

test("`NoPropCollision` rejects a declared prop colliding with a derived `on<Tag>` name", () => {
  const Outputs = Action.of([Action.output("Foo", {})]);
  const NonCollidingProps = Schema.Struct({ somethingElse: Schema.String });
  const CollidingProps = Schema.Struct({ onFoo: Schema.String });

  expect<NoPropCollision<typeof NonCollidingProps, typeof Outputs>>().type.toBe<unknown>();
  expect<NoPropCollision<typeof CollidingProps, typeof Outputs>>().type.toBe<never>();

  // Wired to `define`, not merely computing. The guard sits on `output`
  // alongside `Disjoint`, so a mis-wiring shows up here and nowhere above.
  const state = Schema.Struct({});
  const Actions = Action.of([Action("Bar", {})]);

  expect(define).type.toBeCallableWith({
    props: NonCollidingProps,
    state,
    action: Actions,
    output: Outputs,
  });
  expect(define).type.not.toBeCallableWith({
    props: CollidingProps,
    state,
    action: Actions,
    output: Outputs,
  });

  // And the collision is with the *derived* name specifically: `onFoo` is a
  // perfectly good prop until an output called `Foo` exists to derive it.
  expect(define).type.toBeCallableWith({ props: CollidingProps, state, action: Actions });
});

// ---------------------------------------------------------------------------
// NoTransform
// ---------------------------------------------------------------------------

test("`NoTransform` rejects a props schema whose `Encoded` differs from its `Type`", () => {
  const PlainProps = Schema.Struct({ id: Schema.String });
  const TransformingProps = Schema.Struct({ id: Schema.NumberFromString });

  expect<NoTransform<typeof PlainProps>>().type.toBe<unknown>();
  expect<NoTransform<typeof TransformingProps>>().type.toBe<never>();

  const state = Schema.Struct({});
  const Actions = Action.of([Action("Bar", {})]);

  expect(define).type.toBeCallableWith({ props: PlainProps, state, action: Actions });
  expect(define).type.not.toBeCallableWith({ props: TransformingProps, state, action: Actions });

  // The intersection has to keep bare `PropsSchema` as the inference site. If
  // `NoTransform<PropsSchema>` stood alone as the parameter type there would
  // be nothing to infer from, `PropsSchema` would fall back to its constraint,
  // and props would degrade to a record of `unknown` downstream — taking the
  // guard with it, since `NoTransform<Struct<Struct.Fields>>` is `unknown` and
  // accepts the very schema it exists to reject. Both assertions above survive
  // that; this one does not.
  const Defined = define({ props: PlainProps, state, action: Actions });

  expect<Parameters<Parameters<typeof Defined.initialState>[0]>[0]>().type.toBe<{
    readonly id: string;
  }>();
});

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

test("`Children` is a props field `NoTransform` accepts, and it surfaces as `ReactNode`", () => {
  const ChildrenProps = Schema.Struct({ children: Children });
  const OptionalChildrenProps = Schema.Struct({ children: Schema.optionalKey(Children) });

  // `Schema.declare` is an identity codec, so the guard that rejects a
  // transforming props schema has nothing to object to here.
  expect<NoTransform<typeof ChildrenProps>>().type.toBe<unknown>();
  expect<NoTransform<typeof OptionalChildrenProps>>().type.toBe<unknown>();

  const state = Schema.Struct({});
  const Actions = Action.of([Action("Bar", {})]);

  expect(define).type.toBeCallableWith({ props: ChildrenProps, state, action: Actions });

  const Defined = define({ props: ChildrenProps, state, action: Actions });

  // What a reducer, `initialState` and `render` see: the node itself, not a
  // wrapper anything has to unwrap before rendering it.
  expect<Parameters<Parameters<typeof Defined.initialState>[0]>[0]>().type.toBe<{
    readonly children: ReactNode;
  }>();

  const OptionalDefined = define({ props: OptionalChildrenProps, state, action: Actions });

  expect<Parameters<Parameters<typeof OptionalDefined.initialState>[0]>[0]>().type.toBe<{
    readonly children?: ReactNode;
  }>();

  // `Children.as<T>()` is the same declaration at another children type, and
  // the type argument is the whole contract — a render prop reaches `render`
  // as the function the parent passed.
  type Row = { readonly id: string };
  const RenderProp = Schema.Struct({ children: Children.as<(row: Row) => ReactNode>() });

  expect<NoTransform<typeof RenderProp>>().type.toBe<unknown>();

  const RenderPropDefined = define({ props: RenderProp, state, action: Actions });

  expect<Parameters<Parameters<typeof RenderPropDefined.initialState>[0]>[0]>().type.toBe<{
    readonly children: (row: Row) => ReactNode;
  }>();
});

// ---------------------------------------------------------------------------
// Exhaustive / Excess
// ---------------------------------------------------------------------------

test("`Exhaustive` catches a reducer handler returning an unknown state key", () => {
  type TestState = { readonly count: number };

  type GoodHandlers = {
    readonly Inc: (action: any, snapshot: any) => TestState;
  };
  type BadHandlers = {
    readonly Inc: (action: any, snapshot: any) => { readonly count: number; readonly lmao: number };
  };

  expect<Exhaustive<GoodHandlers, TestState>>().type.toBe<{ readonly Inc: unknown }>();
  expect<Exhaustive<BadHandlers, TestState>>().type.toBe<{
    readonly Inc: "state has no property lmao";
  }>();

  // The synthetic types above cannot show the guard is attached where it has
  // to run. It exists precisely because TypeScript's own excess-property check
  // does *not* fire through an inferred return type — an unannotated handler
  // returning `{ count, lmao }` type-checks on its own — so the only thing
  // standing between that and a compiling feature is the intersection on
  // `create`'s `reducer` parameter.
  const Defined = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: Action.of([Action("Inc", {})]),
  });

  expect(Defined.create).type.toBeCallableWith({
    initialState: () => ({ count: 0 }),
    reducer: { Inc: (_action: unknown, snapshot: { state: TestState }) => snapshot.state },
    render: () => null,
  });

  expect(Defined.create).type.not.toBeCallableWith({
    initialState: () => ({ count: 0 }),
    reducer: { Inc: () => ({ count: 1, lmao: 5 }) },
    render: () => null,
  });

  // `Definition.reducer` carries the same guard, for reducers written in their
  // own file rather than inline.
  expect(Defined.reducer).type.not.toBeCallableWith({ Inc: () => ({ count: 1, lmao: 5 }) });
});

// ---------------------------------------------------------------------------
// ServicesOf — the regression this type exists to prevent
// ---------------------------------------------------------------------------

interface FooService {
  readonly _foo: unique symbol;
}
interface BarService {
  readonly _bar: unique symbol;
}

declare const fooEffect: Effect.Effect<void, never, FooService>;
declare const barEffect: Effect.Effect<void, never, BarService>;

test("`ServicesOf` unions services across handlers instead of collapsing to `never`", () => {
  type Handlers = {
    readonly A: (
      action: any,
      snapshot: any,
    ) => readonly [{ readonly count: number }, Command<never, FooService>];
    readonly B: (
      action: any,
      snapshot: any,
    ) => readonly [{ readonly count: number }, Command<never, BarService>];
    // A handler that returns bare state (no command) contributes no service —
    // it must not collapse the union to `never`.
    readonly C: (action: any, snapshot: any) => { readonly count: number };
  };

  expect<ServicesOf<Handlers>>().type.toBe<FooService | BarService>();

  // Through a real `create`, which is where the regression actually lives.
  // `R` cannot be inferred directly — candidates gathered from separate
  // properties of a mapped type do not accumulate into a union — so `create`
  // infers the reducer *record* and `ServicesOf` walks it afterwards. A
  // version that inferred `R` the naive way silently drops services, and the
  // synthetic assertion above keeps passing while it does.
  const Defined = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: Action.of([Action("A", {}), Action("B", {}), Action("C", {})]),
  });

  const blueprint = Defined.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      A: () => [{ count: 1 }, Command.effect(() => fooEffect)] as const,
      B: () => [{ count: 1 }, Command.effect(() => barEffect)] as const,
      // Contributes no service, and must not collapse the union to `never`.
      C: () => ({ count: 1 }),
    },
    render: () => null,
  });

  // `run` is where `R` becomes observable: it demands a layer providing it.
  expect<Parameters<typeof blueprint.run>[1]["layer"]>().type.toBe<
    Layer.Layer<FooService | BarService>
  >();
});

// ---------------------------------------------------------------------------
// OutputProps
// ---------------------------------------------------------------------------

test("`OutputProps` derives one required `on<Tag>` prop per output, with `_tag` stripped", () => {
  const Outputs = Action.of([
    Action.output("OrderPlaced", { orderId: Schema.String }),
    Action.output("Cancelled", { reason: Schema.String }),
  ]);
  type Props = OutputProps<MemberOf<typeof Outputs>>;

  // Two outputs, because "one per case" is exactly what a single-output
  // assertion cannot show: a mapped type that collapsed the union to its first
  // member would satisfy the old version of this test.
  expect<Props>().type.toBe<{
    readonly onOrderPlaced: (payload: { readonly orderId: string }) => void;
    readonly onCancelled: (payload: { readonly reason: string }) => void;
  }>();

  expect<Props["onOrderPlaced"]>().type.toBeCallableWith({ orderId: "order_1" });
  // `_tag` is not part of the payload type, so passing it is an excess property.
  expect<Props["onOrderPlaced"]>().type.not.toBeCallableWith({
    _tag: "OrderPlaced",
    orderId: "order_1",
  });

  // Required, not optional. This is the whole argument for per-output props
  // over one `onOutput` handler: a parent that does not care has to write
  // `onCancelled={() => {}}` and be visibly ignoring it, rather than
  // announcing into the void by default.
  expect<{
    readonly onOrderPlaced: (payload: { readonly orderId: string }) => void;
  }>().type.not.toBeAssignableTo<Props>();

  // And it degrades to `{}` for a feature that declares no outputs, so the
  // channel split stays free for a leaf feature.
  expect<OutputProps<never>>().type.toBe<{}>();
});

// ---------------------------------------------------------------------------
// The command leaf — `Command.effect`
// ---------------------------------------------------------------------------

interface PipeableFooService {
  readonly _foo: unique symbol;
}
declare const named: Command<{ readonly _tag: "X" }, PipeableFooService>;

const Contextual = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("Ping", {}), Action("Pong", { at: Schema.Number })]),
});

test("`Command.effect` carries `R` out of its effect and emits nothing by default", () => {
  // The parameter is ignored by a command that emits nothing, which is why
  // there is no second "cannot emit" constructor: it is this one, unused.
  expect(Command.effect(() => fooEffect)).type.toBe<Command<never, FooService>>();
  expect(Command.effect(() => Effect.void)).type.toBe<Command<never, never>>();

  // `Command<never>` is the bottom, so a command that emits nothing still fits
  // a slot expecting the feature's actions — see the covariance test below.
  expect(Command.effect(() => fooEffect)).type.toBeAssignableTo<
    Command<{ readonly _tag: "X" }, FooService>
  >();

  // The leaf is a callback, not an effect. Passing the effect itself — the
  // shape the pre-redesign surface took — no longer compiles.
  expect(Command.effect).type.not.toBeCallableWith(fooEffect);

  // The effect's error channel is closed: a command that can fail has to say
  // what it does about it, inside the effect, before the runtime sees it.
  expect(Command.effect).type.not.toBeCallableWith(() => Effect.fail("boom"));
});

test("the leaf's `dispatch` is typed by the feature it is written in", () => {
  // `A` has no inference site of its own — it sits behind `Dispatcher<A>` in a
  // parameter position — so it comes from the contextual type of the handler's
  // return. That is the whole ergonomic bet of the callback leaf: without it
  // every emission would need an explicit type argument, and the spec's own
  // examples would not compile as written.
  //
  // Written as direct calls rather than `toBeCallableWith`: that matcher types
  // its arguments on their own, with no contextual type from the signature
  // under test, so every context-sensitive callback inside one collapses to
  // `never` and the assertion would be measuring the matcher. A call that
  // type-checks in this file *is* the positive assertion.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [{ count: 1 }, Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 }))] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // An undeclared tag is rejected, which is the payoff for the above: the
  // emission is checked against the vocabulary rather than against `unknown`.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          // @ts-expect-error is not assignable to type '"Ping" | "Pong"'
          Command.effect((dispatch) => dispatch({ _tag: "Nope" })),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // A declared tag with the wrong payload, too — the fields travel with the tag.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          // @ts-expect-error is not assignable to parameter of type
          Command.effect((dispatch) => dispatch({ _tag: "Pong" })),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // Standalone — no contextual type — the type argument is how `A` is fixed.
  expect(
    Command.effect<{ readonly _tag: "Pong"; readonly at: number }>((dispatch) =>
      dispatch({ _tag: "Pong", at: 1 }),
    ),
  ).type.toBe<Command<{ readonly _tag: "Pong"; readonly at: number }, never>>();
});

test("`Dispatcher` is contravariant in `A`, which is what makes `Command` covariant", () => {
  // A dispatcher accepting the wider union stands in wherever the narrow one
  // is expected. `Command` puts this in a parameter position a second time,
  // and two contravariant hops compose to covariant — the property the test
  // below asserts on `Command` itself.
  expect<Dispatcher<{ readonly _tag: "X" } | { readonly _tag: "Y" }>>().type.toBeAssignableTo<
    Dispatcher<{ readonly _tag: "X" }>
  >();
  expect<Dispatcher<{ readonly _tag: "X" }>>().type.not.toBeAssignableTo<
    Dispatcher<{ readonly _tag: "X" } | { readonly _tag: "Y" }>
  >();

  // It returns an `Effect`, so it composes with the effect that calls it. A
  // `void` callback would force every call site into `Effect.sync`.
  expect<ReturnType<Dispatcher<{ readonly _tag: "X" }>>>().type.toBe<Effect.Effect<void>>();
});

// ---------------------------------------------------------------------------
// `keyed`, `batch`, `cancel` — the supervisor's whole vocabulary
// ---------------------------------------------------------------------------

test("`Command.keyed` names a command and preserves `A` and `R`", () => {
  expect(named.pipe(Command.keyed("query"))).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Not only through `.pipe`: it is a plain function of a command too.
  expect(Command.keyed("query")(named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Chained, since nesting is answerable at runtime (outermost wins) and the
  // types have to survive it too.
  expect(named.pipe(Command.keyed("outer")).pipe(Command.keyed("inner"))).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Two arguments, which is the form that keeps contextual inference alive —
  // see the test below for what it buys.
  expect(Command.keyed("query", named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // The key is required, and it is a string: the group address is data the
  // runtime compares, not an arbitrary token.
  expect(Command.keyed).type.not.toBeCallableWith();
  expect(Command.keyed).type.not.toBeCallableWith(1);
  expect(Command.keyed).type.not.toBeCallableWith(named, "query");
});

test("a leaf keeps its contextual `A` through `keyed(key, command)`, and loses it through `.pipe`", () => {
  // `Command.keyed(key, command)` puts the leaf in an argument position, where
  // the contextual type of the enclosing call still reaches it.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          Command.keyed(
            "q",
            Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // The same leaf through `.pipe` does not: a `.pipe` receiver is checked
  // before the contextual type of the `.pipe` call exists, so `A` falls back to
  // `never` and `dispatch` accepts nothing. A TypeScript rule about receivers,
  // not something this surface can fix — pinned so the two-argument form is
  // never "simplified" away.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          // @ts-expect-error is not assignable to parameter of type 'never'
          Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })).pipe(Command.keyed("q")),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });
});

test("`Command.batch` composes commands and preserves `A` and `R`", () => {
  expect(Command.batch(named, named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // The shape the whole variant exists for: a `Cancel` sequenced ahead of the
  // command replacing it. `Command.cancel` is `Command<never>` when it stands
  // alone, so `A` has to come from the other member rather than collapsing the
  // batch to `never`.
  expect(Command.batch(Command.cancel("X"), named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Members must agree on the command type; a batch is not a union builder.
  expect(Command.batch).type.not.toBeCallableWith(named, Effect.void);
});

test("a cancel written first in a batch does not pin the batch's `A` to `never`", () => {
  // The regression this exists for, and the reason `cancel` is generic. A
  // concrete `Command<never>` argument outranks the contextual return type as
  // an inference source, so `A` was fixed to `never` before the sibling leaf
  // was checked — and the leaf's `dispatch` accepted nothing. Cancel-first is
  // the only order that means anything, so this is *the* case, not a corner.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          Command.batch(
            Command.cancel({ tag: "Ping", key: "q" }),
            Command.keyed(
              "q",
              Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })),
            ),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // And the emission is still checked against the vocabulary inside a batch —
  // the fix widened where `A` comes from, not what it accepts.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          Command.batch(
            Command.cancel({ tag: "Ping", key: "q" }),
            // @ts-expect-error is not assignable to type '"Ping" | "Pong"'
            Command.effect((dispatch) => dispatch({ _tag: "Nope" })),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });
});

test("`Command.cancel` addresses a group by tag, or by tag and key, and emits nothing", () => {
  // `Command<never>`, so a cancel fits any feature's slot without widening it.
  expect(Command.cancel("Search")).type.toBe<Command<never, never>>();
  expect(Command.cancel({ tag: "Search" })).type.toBe<Command<never, never>>();
  expect(Command.cancel({ tag: "Search", key: "q" })).type.toBe<Command<never, never>>();

  // `tag` is the address; there is no keyed-only target, because a key only
  // refines within a tag.
  expect(Command.cancel).type.not.toBeCallableWith({ key: "q" });
  expect(Command.cancel).type.not.toBeCallableWith({ tag: "Search", keys: "q" });
  expect(Command.cancel).type.not.toBeCallableWith({ tag: 1 });
});

test("the policy vocabulary and the `Stream` leaf are gone from the surface", () => {
  // Removed with the redesign: concurrency is Effect's, not a second data
  // vocabulary. Asserted by name so a re-introduction has to argue with a test.
  expect(Command).type.not.toHaveProperty("restart");
  expect(Command).type.not.toHaveProperty("ignore");
  expect(Command).type.not.toHaveProperty("queue");
  expect(Command).type.not.toHaveProperty("stream");

  // And the whole constructor set, so a node added without a spec change fails
  // here rather than quietly widening the ADT.
  expect<keyof typeof Command>().type.toBe<
    "none" | "effect" | "keyed" | "batch" | "cancel" | "output"
  >();

  // The `Stream` variant is gone from the ADT itself, not merely from the
  // constructors: a long-lived source is `Stream.runForEach` inside the leaf.
  expect<
    Extract<Command<{ readonly _tag: "X" }>, { readonly _tag: "Stream" }>
  >().type.toBe<never>();
  expect<
    Extract<Command<{ readonly _tag: "X" }>, { readonly _tag: "Guarded" }>
  >().type.toBe<never>();
});

test("`Command` is covariant in `A`, so a narrow command satisfies a wide slot", () => {
  // `Command.output(...)` produces `Command<OneTag>` and has to be returnable
  // from a handler whose `Next` expects `Command<Emit<A, O>>`; `Command.none`
  // is `Command<never>` and has to fit everywhere. Both rest on covariance in
  // `A`, which nothing asserted.
  //
  // Pinned deliberately before the command-leaf redesign. Under the callback
  // encoding `A` sits in a doubly-contravariant position, which composes back
  // to covariant — so these assertions should survive that change unchanged,
  // and this is the test that will say so rather than a re-derivation.
  expect<Command<{ readonly _tag: "X" }>>().type.toBeAssignableTo<
    Command<{ readonly _tag: "X" } | { readonly _tag: "Y" }>
  >();

  expect<Command<never>>().type.toBeAssignableTo<Command<{ readonly _tag: "X" }>>();

  // Not the other way: a command emitting the wider union cannot stand in
  // where only `X` is accepted.
  expect<Command<{ readonly _tag: "X" } | { readonly _tag: "Y" }>>().type.not.toBeAssignableTo<
    Command<{ readonly _tag: "X" }>
  >();
});

// ---------------------------------------------------------------------------
// React binding — `createRuntime` → `component`
// ---------------------------------------------------------------------------

declare const fooLayer: Layer.Layer<FooService>;
declare const barFromFoo: Layer.Layer<BarService, never, FooService>;

const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });

const Cart = define({
  props: Schema.Struct({ customerId: Schema.String }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("Added", {})]),
  output: Action.of([OrderPlaced]),
});

const cart = Cart.create({
  initialState: () => ({ count: 0 }),
  reducer: { Added: (_action, snapshot) => snapshot.state },
  render: () => null,
});

test("`component` merges declared props with one required `on<Tag>` prop per output", () => {
  const Feature = createRuntime(Layer.empty).component(cart);

  expect(Feature).type.toBeCallableWith({
    customerId: "c1",
    onOrderPlaced: (payload: { readonly orderId: string }) => void payload.orderId,
  });

  // Required, not optional. This is the whole argument for per-output props
  // over a single `onOutput`: the exhaustiveness check lands at the JSX call
  // site, in every parent, whether or not anyone wrote an exhaustive switch.
  expect(Feature).type.not.toBeCallableWith({ customerId: "c1" });

  // Declared props are still checked, and still required.
  expect(Feature).type.not.toBeCallableWith({ onOrderPlaced: () => {} });

  // `_tag` is stripped from the payload — the prop name already carries it.
  expect<Parameters<Parameters<typeof Feature>[0]["onOrderPlaced"]>[0]>().type.toBe<{
    readonly orderId: string;
  }>();
});

test("`component` is closed over the root's `R`", () => {
  const needsFoo = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: Action.of([Action("A", {})]),
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: { A: () => [{ count: 1 }, Command.effect(() => fooEffect)] as const },
    render: () => null,
  });

  // The DI guarantee a bare `<Provider>` would throw away: a feature needing a
  // service the root does not provide is a compile error at `component`, not a
  // runtime failure on first dispatch.
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(needsFoo);

  // Positive control, so the rejection above is attributable to `R` rather
  // than to some unrelated mismatch in the blueprint's shape.
  expect(createRuntime(fooLayer).component).type.toBeCallableWith(needsFoo);

  // A feature may bring its own layer; the root must cover the residue. `Bar`
  // is supplied here, `Foo` by the root.
  const needsBoth = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: Action.of([Action("A", {}), Action("B", {})]),
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: {
      A: () => [{ count: 1 }, Command.effect(() => fooEffect)] as const,
      B: () => [{ count: 1 }, Command.effect(() => barEffect)] as const,
    },
    render: () => null,
  });

  expect(createRuntime(fooLayer).component).type.toBeCallableWith(needsBoth, {
    layer: barFromFoo,
  });

  // The residue is not a free pass: a root providing nothing still fails, because
  // `barFromFoo` itself requires `FooService`.
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(needsBoth, {
    layer: barFromFoo,
  });
});

test("a blueprint's string-keyed surface stays exactly `reduce` and `run`", () => {
  // The internals slot `component` reads is symbol-keyed, so it cannot be
  // reached by name from userland and cannot collide with a future method.
  // Asserted on the string keys specifically: a slot added as a plain property
  // would show up here, which is the regression this pins.
  expect<Extract<keyof typeof cart, string>>().type.toBe<"reduce" | "run">();
});
