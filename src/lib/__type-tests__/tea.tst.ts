import { Schema } from "effect";
import { expect, test } from "tstyche";
import {
  Action,
  type AnyVocabulary,
  type ChannelOf,
  Command,
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
  // Reserved tag: LifecycleTag narrows the guard to `never`, so the literal
  // argument can no longer satisfy the parameter.
  // @ts-expect-error is not assignable to parameter of type 'never'
  Action("Mounted", {});
  // @ts-expect-error is not assignable to parameter of type 'never'
  Action.output("Unmounted", {});
});

// ---------------------------------------------------------------------------
// Command.output — channel enforced at the point of use
// ---------------------------------------------------------------------------

test("`Command.output` rejects an internal message, accepts an outbound one", () => {
  const InternalFoo = Action("Foo", {});
  const OutboundFoo = Action.output("Foo", {});

  expect(Command.output).type.not.toBeCallableWith(InternalFoo, {});
  expect(Command.output).type.toBeCallableWith(OutboundFoo, {});
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
});

// ---------------------------------------------------------------------------
// NoTransform
// ---------------------------------------------------------------------------

test("`NoTransform` rejects a props schema whose `Encoded` differs from its `Type`", () => {
  const PlainProps = Schema.Struct({ id: Schema.String });
  const TransformingProps = Schema.Struct({ id: Schema.NumberFromString });

  expect<NoTransform<typeof PlainProps>>().type.toBe<unknown>();
  expect<NoTransform<typeof TransformingProps>>().type.toBe<never>();
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
});

// ---------------------------------------------------------------------------
// ServicesOf — the regression this type exists to prevent
// ---------------------------------------------------------------------------

test("`ServicesOf` unions services across handlers instead of collapsing to `never`", () => {
  interface FooService {
    readonly _foo: unique symbol;
  }
  interface BarService {
    readonly _bar: unique symbol;
  }

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
});

// ---------------------------------------------------------------------------
// OutputProps
// ---------------------------------------------------------------------------

test("`OutputProps` derives one required `on<Tag>` prop per output, with `_tag` stripped", () => {
  const Outputs = Action.of([Action.output("OrderPlaced", { orderId: Schema.String })]);
  type Props = OutputProps<MemberOf<typeof Outputs>>;

  expect<Props>().type.toBe<{
    readonly onOrderPlaced: (payload: { readonly orderId: string }) => void;
  }>();

  expect<Props["onOrderPlaced"]>().type.toBeCallableWith({ orderId: "order_1" });
  // `_tag` is not part of the payload type, so passing it is an excess property.
  expect<Props["onOrderPlaced"]>().type.not.toBeCallableWith({
    _tag: "OrderPlaced",
    orderId: "order_1",
  });
});

// ---------------------------------------------------------------------------
// Command's Pipeable typing
// ---------------------------------------------------------------------------

interface PipeableFooService {
  readonly _foo: unique symbol;
}
declare const guarded: Command<{ readonly _tag: "X" }, PipeableFooService>;

test("a command's `A` and `R` survive a policy modifier via `.pipe`", () => {
  expect(guarded.pipe(Command.restart())).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();
  expect(guarded.pipe(Command.ignore("key"))).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();
  expect(guarded.pipe(Command.queue())).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();
});
