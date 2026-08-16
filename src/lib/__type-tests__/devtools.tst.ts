import { Effect, Layer, Schema } from "effect";
import { expect, test } from "tstyche";
import {
  consoleDevtoolsLayer,
  type CommandSummary,
  type DefectSummary,
  type DevtoolsCause,
  type DevtoolsCommand,
  type DevtoolsDefect,
  type DevtoolsEvent,
  type DevtoolsOutput,
  type DevtoolsSink,
  type DevtoolsTransition,
  devtoolsLayer,
} from "../devtools";
import { Action, Command, createRuntime, define, type Group } from "../tea";

// ---------------------------------------------------------------------------
// The event narrows
// ---------------------------------------------------------------------------

declare const event: DevtoolsEvent;
declare const sink: DevtoolsSink;

test("`DevtoolsEvent` narrows to exactly one member per `_tag`", () => {
  if (event._tag === "Transition") expect(event).type.toBe<DevtoolsTransition>();
  if (event._tag === "Command") expect(event).type.toBe<DevtoolsCommand>();
  if (event._tag === "Output") expect(event).type.toBe<DevtoolsOutput>();
  if (event._tag === "Defect") expect(event).type.toBe<DevtoolsDefect>();

  // Four members and no fifth. A `_tag` outside the set narrows the union away
  // entirely, which is the only way to state "this list is closed" without
  // restating the list.
  if (
    event._tag !== "Transition" &&
    event._tag !== "Command" &&
    event._tag !== "Output" &&
    event._tag !== "Defect"
  ) {
    expect(event).type.toBe<never>();
  }
});

test("`cause` is required on every member, not optional", () => {
  // The whole reason the `Output` cause was deleted rather than left optional:
  // with no unfillable variant, every emission site can name its cause, so the
  // field can be required and a reader never has to ask whether `undefined`
  // means "no cause" or "cause unknown".
  expect(event.cause).type.toBe<DevtoolsCause>();
  expect<{
    readonly _tag: "Output";
    readonly name: string;
    readonly instance: string;
    readonly output: { readonly _tag: "X" };
  }>().type.not.toBeAssignableTo<DevtoolsEvent>();
});

declare const cause: DevtoolsCause;

test("`DevtoolsCause` has no variant for an output crossing into a parent", () => {
  // The runtime cannot see what a parent did with an output — it leaves through
  // a plain React callback — so there is nothing here to fill such a variant
  // with. A devtools UI draws that edge from a `DevtoolsOutput` as its own
  // inference; the runtime never claims it.
  if (
    cause._tag !== "Dispatch" &&
    cause._tag !== "Command" &&
    cause._tag !== "Lifecycle" &&
    cause._tag !== "Defect"
  ) {
    expect(cause).type.toBe<never>();
  }
});

// ---------------------------------------------------------------------------
// The layers are `Layer<never>` — the claim the install story rests on
// ---------------------------------------------------------------------------

test("both layers are `Layer<never>`, so merging one moves nothing", () => {
  expect(devtoolsLayer(sink)).type.toBe<Layer.Layer<never>>();
  expect(consoleDevtoolsLayer()).type.toBe<Layer.Layer<never>>();
  expect(consoleDevtoolsLayer({ collapsed: false, diff: true })).type.toBe<Layer.Layer<never>>();

  // `Layer<never>` and not merely `Layer<never, never, never>`-ish: the error
  // channel matters too, because a layer that can fail would push `RootE` and
  // change what `useRuntime` returns.
  expect(devtoolsLayer(sink)).type.toBe<Layer.Layer<never, never, never>>();
});

declare const dev: boolean;

test("a DEV-only ternary has one type on both branches", () => {
  // The shape every install is written in. If either branch drifted, this is
  // where it would show up as a union rather than a single layer.
  expect(dev ? consoleDevtoolsLayer() : Layer.empty).type.toBe<Layer.Layer<never>>();
});

interface FooService {
  readonly _foo: unique symbol;
}
declare const fooEffect: Effect.Effect<void, never, FooService>;
declare const fooLayer: Layer.Layer<FooService>;

const needsFoo = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("A", {})]),
}).create({
  initialState: () => ({ count: 0 }),
  reducer: { A: () => [{ count: 1 }, Command.effect(() => fooEffect)] as const },
  render: () => null,
});

test("merging devtools into a root layer leaves every `component` call unchanged", () => {
  // **The claim the whole install story rests on.** `Reference<S> extends
  // Service<never, S>`, so the merged layer's `ROut` is `FooService | never`,
  // which is `FooService`. If that ever stopped holding, adding devtools to an
  // app would break every feature that needs a service — the failure this test
  // exists to catch, and one that would otherwise surface as a wall of errors
  // in application code rather than here.
  const withDevtools = createRuntime(Layer.mergeAll(fooLayer, consoleDevtoolsLayer()));
  expect(withDevtools.component).type.toBeCallableWith(needsFoo);

  // The pipe spelling, recorded as the fallback in `devtools.specs.md`.
  expect(
    createRuntime(fooLayer.pipe(Layer.merge(consoleDevtoolsLayer()))).component,
  ).type.toBeCallableWith(needsFoo);

  // Positive control: devtools is not what satisfies `FooService`. Without the
  // real root layer this still fails, so the acceptance above is attributable
  // to `fooLayer` and not to a merge that erased the requirement.
  expect(createRuntime(consoleDevtoolsLayer()).component).type.not.toBeCallableWith(needsFoo);
});

test("`createRuntime` takes exactly one parameter", () => {
  // `RuntimeOptions` is gone. A caller still passing an observer is a compile
  // error rather than a silently ignored argument — which is the failure mode
  // the old second parameter had, and the reason the whole feature exists.
  expect(createRuntime).type.not.toBeCallableWith(Layer.empty, {
    onEvent: () => {},
  });
});

// ---------------------------------------------------------------------------
// `CommandSummary` is a faithful erasure of `Command`
// ---------------------------------------------------------------------------

test("`CommandSummary` covers every `Command` tag and no others", () => {
  // Same tag set, stated in both directions so neither an added command
  // variant nor a stale summary variant can pass unnoticed.
  type CommandTag = Extract<Command<never>, { readonly _tag: string }>["_tag"];
  expect<CommandSummary["_tag"]>().type.toBe<CommandTag>();
});

test("`CommandSummary` preserves the structure and drops only the effect", () => {
  // Structure survives, because structure is what a debugger reads: which key
  // named the fiber, what order a batch ran in, what a cancel addressed.
  expect<Extract<CommandSummary, { readonly _tag: "Keyed" }>>().type.toBe<{
    readonly _tag: "Keyed";
    readonly key: string;
    readonly command: CommandSummary;
  }>();
  expect<Extract<CommandSummary, { readonly _tag: "Batch" }>>().type.toBe<{
    readonly _tag: "Batch";
    readonly commands: ReadonlyArray<CommandSummary>;
  }>();
  expect<Extract<CommandSummary, { readonly _tag: "Cancel" }>>().type.toBe<{
    readonly _tag: "Cancel";
    readonly target: Group;
  }>();

  // The leaf keeps its tag and nothing else. The callback is the one field that
  // cannot cross a `postMessage`, and this is the assertion that says so.
  expect<Extract<CommandSummary, { readonly _tag: "Effect" }>>().type.toBe<{
    readonly _tag: "Effect";
  }>();
  expect<Extract<CommandSummary, { readonly _tag: "Effect" }>>().type.not.toHaveProperty("effect");

  // Nor is a summary `Pipeable`, unlike the command it summarises: piping
  // builds commands, and a log entry is not a builder.
  expect<CommandSummary>().type.not.toHaveProperty("pipe");
});

// ---------------------------------------------------------------------------
// Encodability, machine-checked for the first time
// ---------------------------------------------------------------------------

/**
 * Local and recursive, on purpose. The module's central promise is that an
 * event survives `JSON.stringify` and a `postMessage` with no schema-aware
 * serialiser in between, and until this existed that promise was only prose in
 * a JSDoc. Declared here rather than exported from the library because it is a
 * property of these types, not a type the library asks anyone to use.
 */
type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/**
 * Rebuild a type as anonymous object literals, all the way down, leaving
 * functions callable.
 *
 * Needed because of a TypeScript rule rather than anything about these types:
 * an object literal or mapped type gets an implicit index signature and an
 * **interface does not**, so `DefectSummary` — an interface — would fail
 * `Json` for a reason that has nothing to do with encodability. (`Group` is a
 * string alias now, but the mapping is harmless to it.)
 * This is structure-preserving, so what the assertions below check is still
 * the real shape. Functions are passed through deliberately: mapping over one
 * would yield `{}` and quietly let a callback satisfy `Json`, which is the
 * single thing these assertions exist to rule out.
 */
type Plain<T> = T extends (...args: never) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<Plain<U>>
    : T extends object
      ? { readonly [K in keyof T]: Plain<T[K]> }
      : T;

test("every part of an event the runtime constructs is JSON-encodable", () => {
  expect<Plain<DevtoolsCause>>().type.toBeAssignableTo<Json>();
  expect<Plain<CommandSummary>>().type.toBeAssignableTo<Json>();
  expect<Plain<DefectSummary>>().type.toBeAssignableTo<Json>();
  expect<Plain<Group>>().type.toBeAssignableTo<Json>();

  // Negative controls, so the four above are not passing because `Json` admits
  // everything. Both are what the summary types exist to keep out of an event:
  // a command carries a leaf callback and a `pipe` method, and a sink is a
  // function in a box.
  expect<Plain<Command<never>>>().type.not.toBeAssignableTo<Json>();
  expect<Plain<DevtoolsSink>>().type.not.toBeAssignableTo<Json>();

  // `Error` is deliberately absent from that list. It is *structurally*
  // Json-shaped — three strings — so no type-level assertion can express why
  // it had to be replaced by `DefectSummary`. The reason is a runtime one:
  // its own properties are non-enumerable, so it `JSON.stringify`s to `{}`.
  // That claim is asserted in `devtools.test.ts`, where it can be.
});

test("what the runtime does *not* control is honestly typed as `unknown`", () => {
  // State and the action payload are the user's, so they are `unknown` here
  // rather than `Json`. Claiming `Json` for them would be a promise this
  // library cannot keep — a feature is free to put a `Map` in its state — and
  // the encodability guarantee is deliberately about the envelope the runtime
  // builds, not about what a user hands it.
  expect<DevtoolsTransition["previous"]>().type.toBe<unknown>();
  expect<DevtoolsTransition["next"]>().type.toBe<unknown>();
});

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

test("the sink is synchronous, because the fold is", () => {
  // An `Effect`-returning sink would put a forked fiber and a scheduler hop on
  // the hottest path in the library. This is the assertion that stops one
  // arriving by way of a "small" refactor.
  expect<DevtoolsSink["onEvent"]>().type.toBe<(event: DevtoolsEvent) => void>();
  expect<ReturnType<DevtoolsSink["onEvent"]>>().type.not.toBeAssignableTo<
    Effect.Effect<unknown, unknown, unknown>
  >();

  // Contravariance where it is useful: a sink written for one member only is
  // not a `DevtoolsSink`, because the runtime emits all four.
  expect(devtoolsLayer).type.not.toBeCallableWith({
    onEvent: (_: DevtoolsTransition) => {},
  });
});
