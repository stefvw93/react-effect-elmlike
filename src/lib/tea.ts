import type { FC, ReactNode } from "react";
import {
  Effect,
  Fiber,
  identity,
  Pipeable,
  Queue,
  Ref,
  Schema,
  Stream,
  type Cause,
  type Layer,
  type ManagedRuntime,
} from "effect";

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Collapse a type to a flat object literal, for hovers.
 *
 * Purely cosmetic and structurally identity, but the thing it fixes is not
 * cosmetic: a component's props are the whole boundary, and until this existed
 * hovering one showed `Props & OutputProps<Output & …>` — three type aliases and
 * an intersection, with the actual prop names and callback signatures behind
 * them. Every place a boundary type reaches a call site goes through here.
 *
 * The mapped type is homomorphic, so `readonly` and `?` survive; the `& {}`
 * is what stops the compiler from printing the alias name instead of the
 * members it just computed.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The tags the runtime raises, reserved so a declared action cannot take one.
 *
 * This is what pays for the lifecycle actions having no sigil. They live in the
 * same namespace as yours now, so the namespace is policed rather than dodged —
 * and policing it is also what keeps them *inbound-only*, since `dispatch`
 * accepts only declared actions and `Mounted` can never be one.
 */
export type LifecycleTag = "Mounted" | "PropsChanged" | "Error" | "Unmounted" | "HookChanged";

/** Guard for one tag, at `Action`. See `define` for why it is an intersection. */
export type NotLifecycleTag<Tag extends string> = Tag extends LifecycleTag ? never : unknown;

/**
 * The runtime counterpart of `LifecycleTag`, kept exhaustive by the compiler:
 * a `Record` literal missing (or misspelling) a key fails to satisfy the
 * `Record<LifecycleTag, true>` annotation.
 *
 * What this exists to prevent: `reduce`/`step` treat a missing handler as a
 * no-op only for *lifecycle* actions — every `LifecycleHandlers` entry is
 * optional by design. A missing handler for a *declared* action is a
 * different thing entirely — the `Reducer` type requires one for every tag in
 * `A["cases"]`, so reaching this branch for one means the action arrived
 * without going through the typed `dispatch`/`reduce` surface (a bad cast, a
 * malformed devtools replay). That case still throws, on purpose.
 */
const LifecycleTags: Record<LifecycleTag, true> = {
  Mounted: true,
  PropsChanged: true,
  Error: true,
  Unmounted: true,
  HookChanged: true,
};

/**
 * `Object.hasOwn` rather than `in`, and the same for the reducer lookup at both
 * call sites — because both objects inherit from `Object.prototype` and both
 * lookups would otherwise resolve keys nobody declared.
 *
 * `"toString" in LifecycleTags` is `true`, so an action tagged `"toString"`
 * would be treated as a lifecycle action and silently no-op. Worse,
 * `reducer["constructor"]` resolves to `Object`, which is truthy, so it would
 * be *called* as a handler and its return value used as the next state.
 * Neither is a declared handler and neither is a `LifecycleTag`, so both have
 * to reach the throw.
 *
 * Only reachable by bypassing the typed surface — a bad cast, a malformed
 * devtools replay — which is exactly the case that branch exists to catch, and
 * the case where failing loudly matters most.
 */
const isLifecycleTag = (tag: string): tag is LifecycleTag => Object.hasOwn(LifecycleTags, tag);

/** Own properties only. See `isLifecycleTag` for why. */
const handlerFor = <Handler>(handlers: Record<string, Handler>, tag: string): Handler | undefined =>
  Object.hasOwn(handlers, tag) ? handlers[tag] : undefined;

/**
 * A message is a tagged struct and nothing more, in both directions. The
 * difference between the two vocabularies is *where a message may go*, which is
 * a fact about the boundary and not about the payload — so they are one type
 * carrying a phantom channel, and moving one across is a rename of its
 * constructor plus a move between two lists.
 *
 * **The phantom is what the first sketch was missing.** `action` and `output`
 * both returned `Schema.TaggedStruct<Tag, Fields>`, so with the same tag they
 * were *mutually assignable*: `actions: [OrderPlaced]` compiled, `outputs:
 * [CheckoutRequested]` compiled, and the two names were documentation the
 * compiler could not check. Nothing enforced the boundary except which array a
 * value happened to be typed into. Verified, not assumed.
 *
 * The brand is on the **vocabulary as well as the message**, and both halves
 * catch a different mistake: the message brand stops `Action.of([…, OrderPlaced])`,
 * the vocabulary brand stops `define({ action: CartOutputs })`. Neither error
 * can be reached by the other, so a half-finished move fails rather than
 * compiling into the wrong channel.
 *
 * It also subsumes the old `NoLifecycleTags` backstop, which existed only
 * because a bare `Schema.TaggedStruct` could bypass the constructor and land in
 * the list unchecked. There is now no unbranded way in, so the guard on the
 * string literal in `Vocabularies` is the only gate that has to exist.
 *
 * The brand is load-bearing a third way now: `Action.of` reads the channel off
 * its members rather than being told, so the phantom is an *inference site* and
 * not only a check. See `ChannelOf`.
 */
const channel: unique symbol = Symbol("@tea/channel");

export type Channel = "internal" | "outbound";

export type Message<
  Tag extends Capitalize<string>,
  Fields extends Schema.Struct.Fields,
  Ch extends Channel,
> = Schema.TaggedStruct<Tag, Fields> & { readonly [channel]: Ch };

/**
 * What `of` accepts: a message, or a whole *vocabulary* of the same channel.
 * Both satisfy this, and that is the entire composition story — see `Vocabularies`.
 */
export type AnyMessage<Ch extends Channel> = Schema.Codec<any, any> & {
  readonly Type: { readonly _tag: string };
  readonly [channel]: Ch;
};

/**
 * A vocabulary is Effect's tagged union, branded.
 *
 * `Schema.toTaggedUnion` rather than `Schema.TaggedUnion`, and the difference is
 * load-bearing: `TaggedUnion` builds from a record of field-sets and **drops
 * `members`**, while `toTaggedUnion` decorates a `Schema.Union` and keeps it.
 * `Flatten` — the type that gives `cases` its keys — recurses on `Head extends
 * Union<infer Inner>`, so a vocabulary built the first way cannot be nested
 * inside another one. Built this way it can, and that is what makes a shared
 * vocabulary a value rather than a copied list.
 *
 * What comes with it, and none of which an array of schemas had: `cases` keyed
 * by tag (the reducer's key set, flattened through nesting), `guards`, `match`,
 * `mapMembers`, a `make` constructor per case that fills `_tag`, and an
 * encodable schema for the whole vocabulary — which is the missing half of the
 * devtools transport.
 */
export type Vocabulary<
  Members extends ReadonlyArray<AnyMessage<Channel>>,
  Ch extends Channel,
> = Schema.toTaggedUnion<"_tag", Members> & { readonly [channel]: Ch };

/**
 * The channel a member list belongs to, read off the members' own brand.
 *
 * This is what lets `of` be written once for both channels instead of being
 * instantiated per channel — the members already say where they go, so asking
 * the caller to say it again is a second source of truth and a second place to
 * get it wrong.
 *
 * Both guards test *assignability of the whole tuple*, which is elementwise, so
 * a mixed list satisfies neither and lands on `never`. The empty list satisfies
 * both, which is the one genuinely ambiguous case: it also resolves to `never`,
 * so `Action.of([])` fails at `define` rather than picking a channel by coin
 * toss. Nobody writes it — `output` defaults to `NoOutputs` — and the failure is
 * loud if they do.
 */
export type ChannelOf<Members extends ReadonlyArray<AnyMessage<Channel>>> =
  Members extends ReadonlyArray<AnyMessage<"internal">>
    ? Members extends ReadonlyArray<AnyMessage<"outbound">>
      ? never
      : "internal"
    : "outbound";

/**
 * Rejects a member list that straddles both channels, at the `of` call rather
 * than wherever the resulting vocabulary is used.
 *
 * Without it a mixed list still fails — `ChannelOf` gives `"outbound"`, and the
 * internal members make the vocabulary wrong in a way `define` eventually
 * notices — but it fails one hop away from the mistake, naming the vocabulary
 * instead of the member that does not belong. Intersected onto the parameter
 * like every other guard here, so bare `Members` stays the inference site.
 */
export type SameChannel<Members extends ReadonlyArray<AnyMessage<Channel>>> =
  Members extends ReadonlyArray<AnyMessage<"internal">>
    ? unknown
    : Members extends ReadonlyArray<AnyMessage<"outbound">>
      ? unknown
      : never;

/**
 * The constraint everything downstream is written against, and it is structural
 * on purpose.
 *
 * `Vocabulary<any, Ch>` looks like the obvious spelling and does not work.
 * Intersecting drops TypeScript's variance fast path for generic references, so
 * assignability falls back to a structural comparison that reaches `match` and
 * `isAnyOf` — whose parameters are contravariant — and *every* real vocabulary
 * fails its own constraint. Naming the two members the library actually reads
 * sidesteps that, and is a tighter constraint besides.
 */
export type AnyVocabulary<Ch extends Channel> = {
  readonly [channel]: Ch;
  readonly cases: Record<string, { readonly Type: { readonly _tag: string } }>;
  readonly Type: { readonly _tag: string };
};

export type TagsOf<V extends AnyVocabulary<Channel>> = keyof V["cases"] & string;

export type MemberOf<V extends AnyVocabulary<Channel>> = V["Type"];

/**
 * The thin wrapper on `Schema.TaggedStruct` that everything else in this file is
 * built from. Its only addition is the reserved-tag guard, which lands on the
 * string literal where the error reads best.
 */
export interface MessageConstructor<Ch extends Channel> {
  <const Tag extends Capitalize<string>, const Fields extends Schema.Struct.Fields>(
    tag: Tag & NotLifecycleTag<Tag>,
    fields: Fields,
  ): Message<Tag, Fields, Ch>;
}

/**
 * One primitive, two channels, **one namespace** — so the claim that an output
 * is *an action with an external destination* is the shape of the API rather
 * than a comment attached to two sibling constants.
 *
 * `Action` and `Output` as peers said the opposite: two names, equal weight,
 * and nothing in the surface admitting they were the same constructor called
 * twice. Nesting the rarer one states the relationship and prices it correctly —
 * internal is unqualified because it is almost everything, outbound pays one
 * segment.
 *
 * `of` is channel-*polymorphic*, not duplicated per channel: the members carry
 * the brand, so `ChannelOf` reads it back and `SameChannel` rejects a mixed
 * list. That is the whole reason there is no `Action.output.of` — it would be
 * asking for a fact the argument already contains. It is
 * `Schema.Union(members).pipe(Schema.toTaggedUnion("_tag"))`, which takes
 * messages and vocabularies interchangeably and flattens the nested ones:
 *
 *     const Async = Action.of([Started, Failed])            // shared, its own module
 *     const CartActions = Action.of([Async, CheckoutRequested, CheckoutCompleted])
 *     const CartOutputs = Action.of([Action.output("OrderPlaced", { orderId: Schema.String })])
 *
 * The reducer for `CartActions` then requires all four keys. A record-of-fields
 * constructor was tried first and dropped here: it reads well and composes only
 * by object spread, which fakes reuse rather than expressing it — and a member
 * that needs `.check(…)`, or that is an existing schema, cannot be spelled at
 * all.
 *
 * Declaring the vocabulary as a *value* is also what keeps inference working.
 * `reducer` is a mapped type keyed by tag, and a mapped type is not an inference
 * site — so the action union can never be recovered from `reducer`. It would
 * collapse to `{_tag: string}` and every handler parameter would become `never`.
 */
export interface Vocabularies extends MessageConstructor<"internal"> {
  /**
   * Announced, never handled here. An output has no reducer handler — its tag is
   * not in the reducer's key set — and it is not in `dispatch`'s union, so it
   * cannot be sent by hand: the structural trick `LifecycleTag` uses for
   * inbound-only lifecycle actions, run in the other direction.
   *
   * Delivered as one `on<Tag>` prop per output — see `OutputProps`.
   */
  readonly output: MessageConstructor<"outbound">;

  readonly of: <const Members extends ReadonlyArray<AnyMessage<Channel>>>(
    members: Members & SameChannel<Members>,
  ) => Vocabulary<Members, ChannelOf<Members>>;
}

const messages = <Ch extends Channel>(ch: Ch) =>
  function message(tag: string, fields: Schema.Struct.Fields) {
    return Object.assign(Schema.TaggedStruct(tag, fields), { [channel]: ch });
  };

/**
 * Declared vocabularies. `Action(…)` is handled here and never seen outside;
 * `Action.output(…)` is the reverse.
 */
export const Action: Vocabularies = Object.assign(messages("internal"), {
  output: messages("outbound"),

  /**
   * The runtime brand comes off the first member rather than from an argument,
   * which is the value-level half of what `ChannelOf` does in the type. Both
   * halves are safe on the same premise — `SameChannel` has already rejected a
   * list whose members disagree, so member zero speaks for all of them.
   */
  of: (members: ReadonlyArray<AnyMessage<Channel>>) =>
    Object.assign(Schema.Union(members).pipe(Schema.toTaggedUnion("_tag")), {
      [channel]: members[0]?.[channel],
    }),
}) as unknown as Vocabularies;

/** The empty vocabulary, so a leaf feature declares nothing. `Type` is `never`. */
export type NoOutputs = Vocabulary<readonly [], "outbound">;

/**
 * Routing is by tag and nothing else — a command emits one union and the runtime
 * decides from `_tag` whether it re-enters the reducer or leaves through the
 * matching `on<Tag>` prop. So the two vocabularies must not overlap, or a tag
 * would mean two things and the ambiguity would be silent.
 *
 * Checked as an intersection at the declaration site for the reason `NoTransform`
 * is: the bare vocabulary is the inference site, and `& unknown` / `& never`
 * reduces afterwards so the error lands on the argument rather than on the
 * result. Cross-property references are safe in this direction only — `A` is
 * inferred from its own property before this is checked — which is why `action`
 * carries no disjointness guard and `output` carries it.
 *
 * Within one vocabulary the same check is Effect's and it is a runtime throw:
 * `toTaggedUnion` refuses a duplicate discriminant while walking members, which
 * is what keeps two nested vocabularies from quietly shadowing each other.
 */
export type Disjoint<A extends AnyVocabulary<"internal">, O extends AnyVocabulary<"outbound">> = [
  Extract<TagsOf<A>, TagsOf<O>>,
] extends [never]
  ? unknown
  : never;

/**
 * What a command may emit. One channel, two destinations, sorted by tag.
 *
 * The alternative — a third slot in `Next`, or a separate `Command.output`
 * returning a differently-typed stream — was worse in the same way: an output
 * could then only be raised where a reducer *returns*, when the useful case is
 * raising one from deep inside a long-lived `Stream.callback` that has been
 * running since `Mounted`. Commands are already the channel for "things that
 * leave and come back at their own pace"; an announcement is one of those.
 */
export type Emit<A extends AnyVocabulary<"internal">, O extends AnyVocabulary<"outbound">> =
  | MemberOf<A>
  | MemberOf<O>;

/**
 * State is a schema too, for the same reasons as the vocabularies: it is the
 * other half of what a devtools transport, a replay log, or session hydration
 * needs to encode. It also means `State` arrives from a *value*, so nothing
 * about it has to be inferred out of `initialState`'s return type.
 */
export type AnyStateSchema = Schema.Struct<any>;

export type StateOf<S extends AnyStateSchema> = S["Type"];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props are a schema too — which is what removes the last explicit type
 * argument, and what lets a component reject the props it was never given.
 *
 * The reason to bother: TypeScript's excess-property check **does not fire
 * through a spread**. `<Cart {...config} />` where `config` carries extra keys
 * is accepted by the compiler, by design. Cast-through spreads are how
 * components quietly acquire props nobody declared, and this is the only layer
 * that can see it.
 *
 * A `Struct`, then, and not a `Codec`: React hands a component exactly one
 * object, so a props schema that is not a record describes something no parent
 * can ever pass. `props: Schema.Number` satisfied the old constraint and failed
 * at the boundary on every mount instead. It is also what the rest of the file
 * already assumes — the excess-property check needs keys to find excessive, and
 * a serialiser walks `PropsSchema.fields`, which is on `Struct` and not on
 * `Codec`.
 *
 * `Schema.Record` and `Schema.StructWithRest` are records and are still out, for
 * the same reason rather than by accident: their index signature accepts keys
 * nobody declared, which is precisely what this layer exists to reject.
 * `Schema.Struct.Fields` rather than the `any` that `AnyStateSchema` uses, so a
 * props type that fails to infer degrades to `{ readonly [x: PropertyKey]:
 * unknown }` — where a wrong read is an error — instead of to `any`.
 *
 * Strictness is untouched: `PropsSchema` is inferred from the value, so
 * per-field optionality and nested schemas survive as before, and so does a
 * `.check(…)` refinement on the whole props object — `check` rebuilds to
 * `Struct`.
 *
 * **Everything in here encodes**, and that is a property the outbound channel
 * bought. A props schema used to need an escape hatch for callback props, whose
 * only honest encoding was a live function reference — which `JSON.stringify`
 * drops without complaint and `structuredClone` throws on, so every devtools
 * transport either lied about props or died on them. A callback prop is now an
 * output, so the hatch is gone and a props object is transport-safe by
 * construction.
 */
export type AnyPropsSchema = Schema.Struct<Schema.Struct.Fields>;

export type PropsOf<P extends AnyPropsSchema> = P["Type"];

/**
 * Props are **validated, never decoded**: `Encoded` must equal `Type`, so
 * `props.x` is always exactly what the parent passed. A transforming props
 * schema is a compile error.
 *
 * This is not only about honesty. Measured against this Effect build, one
 * transforming field costs ~2.3µs per check — about nineteen times a plain
 * field — while the same conversion written as a hook is a plain function call
 * during a render that is happening anyway. Transformation belongs in
 * `useHooks`, on both counts.
 */
export type NoTransform<P extends AnyPropsSchema> = [P["Encoded"]] extends [P["Type"]]
  ? [P["Type"]] extends [P["Encoded"]]
    ? unknown
    : never
  : never;

// ---------------------------------------------------------------------------
// Outputs, as props
// ---------------------------------------------------------------------------

/**
 * One `on<Tag>` prop per declared output, derived from the union.
 *
 * The alternative was a single `onOutput` carrying the tagged union, with the
 * parent writing a `switch`. That reads like a framework and these read like
 * React — but ergonomics is the smaller half of the argument. The bigger half is
 * **where the exhaustiveness check lands**.
 *
 * With one handler, adding an output is caught inside the parent's `switch`, and
 * only if the parent bothered to write an exhaustive one. With required
 * per-output props it is caught at the JSX call site, in every parent, whether
 * or not anyone was being careful — a missing prop is a missing prop. That is a
 * strictly stronger guarantee, and it is why these are **required rather than
 * optional**: an output is part of the interface, so a parent that does not care
 * about one should have to write `onThing={() => {}}` and be visibly ignoring
 * it. Optional would make announcing into the void the default, and a dropped
 * output is indistinguishable from a feature that never announced.
 *
 * `_tag` is stripped from the payload, since the prop name already carries it —
 * `onOrderPlaced={({ orderId }) => …}` rather than destructuring around a
 * discriminant nobody needs to read.
 *
 * Degrades to `{}` when a feature declares no outputs, so the split stays free
 * for leaf features.
 */
export type OutputProps<Output extends { readonly _tag: string }> = {
  readonly [K in Output["_tag"] as `on${K}`]: (
    payload: Simplify<Omit<Extract<Output, { readonly _tag: K }>, "_tag">>,
  ) => void;
};

/**
 * Derived prop names live in the same namespace as declared ones, so an output
 * called `Checkout` and a prop called `onCheckout` would collide — and the
 * collision would resolve to an intersection rather than an error, which is the
 * silent kind.
 *
 * Checked as an intersection at the declaration site, like every other guard
 * here. The error lands on `output`, which is the side that should move: a prop
 * is the parent's vocabulary and an output is this feature's, and renaming the
 * one still being designed is cheaper.
 */
export type NoPropCollision<
  PropsSchema extends AnyPropsSchema,
  O extends AnyVocabulary<"outbound">,
> = [Extract<keyof PropsOf<PropsSchema>, `on${TagsOf<O>}`>] extends [never] ? unknown : never;

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * **There is no lifetime option, and that is the design.**
 *
 * A blueprint's state is born at mount and discarded at unmount. Always. No
 * `retain`, no `key`, no registry of live machines — because every one of those
 * is a place state outlives the thing that owns it, and a place state outlives
 * its owner is a store with extra steps.
 *
 * NgRx ComponentStore states the rule this replaces, and it is a good one:
 * *state that must survive a URL change belongs to the app; state that must be
 * cleaned up on a URL change belongs to the component.* The version here is the
 * same rule with the escape hatch removed, so the answer to "but this needs to
 * survive" is forced to be structural rather than a flag:
 *
 *   - **Survives navigation** → it is a service's state, in `R`, with a Layer
 *     controlling its lifetime. The feature reads it in `Mounted` and writes to
 *     it in a command. This is also TCA's answer, arrived at from the other
 *     direction: shared data goes in the dependency graph, never in the state
 *     tree.
 *   - **Should reset** → change the React `key`. React already owns remounting;
 *     a second mechanism here could only disagree with it.
 *   - **Comes from the server** → it is a prop, and `initialState` projects it.
 *     Nothing async: an initial *fetch* is a `Mounted` command like any other.
 *
 * The cost is real and worth naming: a feature that unmounts loses in-flight
 * work, because closing the scope interrupts its fibers. That is the correct
 * default — it is the leak this design exists to prevent — but it means "keep
 * uploading after the user navigates away" is a service, not a feature.
 *
 * Someone hit this exact wall in XState production and wrote it down: *"when a
 * machine's primary responsibility is to manage the UI of a screen with
 * lifecycle tied to that of the UI, it needs to access an API cache that
 * predates it and lives on after it stops."* The answer above is better than
 * XState's, but the friction is documented and real.
 */
export type OwnershipRule = never;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * `R` is **computed from the reducer's handlers, not declared and not
 * inferred.**
 *
 * Inferring it directly does not work: candidates gathered from separate
 * properties of a mapped type do not accumulate into a union, so an inferred
 * `R` silently drops services — the failure is a wrong type, not an error.
 *
 * The way around it is to stop asking TypeScript to infer `R` at all. `create`
 * infers the *reducer record itself* (an object literal, which is a real
 * inference site), and `R` is then derived from that type by walking the
 * handlers' return types and unioning what it finds. A mapped type indexed by
 * `keyof` unions properly; only inference fails to.
 */
type ServiceOf<T> = T extends readonly [any, Command<any, infer R>] ? R : never;

export type ServicesOf<U> = {
  [K in keyof U]: ServiceOf<ReturnType<Extract<U[K], (...args: any) => any>>>;
}[keyof U];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * The async work a state change kicks off.
 *
 * An ADT rather than a bare `Stream`, because a command carries two things the
 * stream itself cannot: a concurrency policy, and the ability to *be* a
 * cancellation rather than to perform one. Composition still happens on the
 * `Stream` before it is wrapped, so nothing in Effect's vocabulary is lost —
 * `Stream.merge`, `Stream.catchTag`, `Stream.callback` are all used as before,
 * one `Command.stream(…)` from the end.
 *
 * `Pipeable`, so a policy reads as a modifier chained onto the command it
 * governs — see `Command.restart` / `.ignore` / `.queue`.
 */
export type Command<A, R = never> = Pipeable.Pipeable &
  /** Explicit no-op, for when a bare `state` return reads worse. */
  (
    | { readonly _tag: "None" }

    /** Run for effects; emit nothing. */
    | { readonly _tag: "Effect"; readonly effect: Effect.Effect<unknown, never, R> }

    /** Emit actions and outputs over time. Cannot fail — conversion is userland. */
    | { readonly _tag: "Stream"; readonly stream: Stream.Stream<A, never, R> }

    /**
     * Several commands at once, each keeping its own policy. `Stream.merge`
     * covers this only while both halves want the same group.
     */
    | { readonly _tag: "Batch"; readonly commands: ReadonlyArray<Command<A, R>> }

    /**
     * Interrupt a running group. A command in its own right, so a handler can
     * invalidate work another action started — the cross-tag case no policy can
     * express.
     */
    | { readonly _tag: "Cancel"; readonly target: Group }

    /**
     * Policy as a wrapper rather than a field, so it exists in exactly one place,
     * the variants that fork nothing cannot carry a meaningless one, and nesting
     * is answerable: the outermost wins.
     */
    | {
        readonly _tag: "Guarded";
        readonly policy: Policy;
        /** Refines the group within the issuing action's tag. */
        readonly key?: string;
        readonly command: Command<A, R>;
      }
  );

/**
 * What a policy governs and what `Cancel` addresses. The tag is the issuing
 * action's and is filled by the runtime, never written by hand; `key` refines
 * within it, so `"restart"` on `QuantityChanged` can mean per-sku.
 *
 * An omitted `key` on `Cancel` targets every group under the tag.
 */
export interface Group {
  readonly tag: string;
  readonly key?: string;
}

export type Policy = "restart" | "ignore" | "queue" | "parallel";

const pipeable = <T extends object>(value: T): T & Pipeable.Pipeable =>
  Object.assign(value, {
    pipe(this: T) {
      return Pipeable.pipeArguments(this, arguments);
    },
  });

/**
 * Discharges only the `R` channel of an effect, keeping its success type
 * exactly as inferred. Used once, by `run` — see the call site for why `R`
 * specifically cannot be verified in that scope.
 */
const discharge = <T>(effect: Effect.Effect<T, never, any>): Effect.Effect<T, never, never> =>
  effect as Effect.Effect<T, never, never>;

export const Command: {
  readonly none: Command<never>;

  readonly effect: <R>(effect: Effect.Effect<unknown, never, R>) => Command<never, R>;

  readonly stream: <A, R>(stream: Stream.Stream<A, never, R>) => Command<A, R>;

  readonly batch: <A, R>(...commands: ReadonlyArray<Command<A, R>>) => Command<A, R>;

  readonly cancel: (target: Group | string) => Command<never>;

  /**
   * Outbound announcement. The phantom on `Message` does the work here: passing
   * an internal message is a compile error, which is the first time the channel
   * split is checked at the point of use rather than by which list a value was
   * typed into.
   */
  readonly output: <Tag extends Capitalize<string>, Fields extends Schema.Struct.Fields>(
    message: Message<Tag, Fields, "outbound">,
    payload: Simplify<Omit<Schema.Struct<Fields>["Type"], "_tag">>,
  ) => Command<{ readonly _tag: Tag } & Schema.Struct<Fields>["Type"]>;

  /** Pipeable, so the policy reads as a modifier: `cmd.pipe(Command.restart())`. */
  readonly restart: (key?: string) => <A, R>(command: Command<A, R>) => Command<A, R>;
  readonly ignore: (key?: string) => <A, R>(command: Command<A, R>) => Command<A, R>;
  readonly queue: (key?: string) => <A, R>(command: Command<A, R>) => Command<A, R>;
} = {
  none: pipeable({ _tag: "None" }),

  effect: (effect) => pipeable({ _tag: "Effect", effect }),

  stream: (stream) => pipeable({ _tag: "Stream", stream }),

  batch: (...commands) => pipeable({ _tag: "Batch", commands }),

  cancel: (target) =>
    pipeable({
      _tag: "Cancel",
      target: typeof target === "string" ? { tag: target } : target,
    }),

  output: (message, payload) =>
    Command.stream(Stream.succeed((message as any).make(payload))) as any,

  restart: (key) => (command) => pipeable({ _tag: "Guarded", policy: "restart", key, command }),
  ignore: (key) => (command) => pipeable({ _tag: "Guarded", policy: "ignore", key, command }),
  queue: (key) => (command) => pipeable({ _tag: "Guarded", policy: "queue", key, command }),
};

/**
 * What a reducer returns: the next state, optionally with a command.
 *
 * `next` is React's own word for it — `setState(prev => next)` — and it is the
 * same word the lifecycle actions below use for an incoming prop or hook
 * value. Same meaning in both places.
 */
export type Next<State, Action, R = never> = State | readonly [State, Command<Action, R>];

/**
 * Accessors, so a test can fold a sequence of actions without pattern matching
 * on the tuple at every step.
 *
 * The tuple is unambiguous because `AnyStateSchema` is a `Schema.Struct`:
 * state is always an object, so an array is always a `[state, command]` pair.
 */
export const Next: {
  readonly state: <State>(next: Next<State, any, any>) => State;
  readonly command: <State, Action, R>(
    next: Next<State, Action, R>,
  ) => Command<Action, R> | undefined;
} = {
  state: (next) => (Array.isArray(next) ? next[0] : next),
  command: (next) => (Array.isArray(next) ? next[1] : undefined),
};

// ---------------------------------------------------------------------------
// Ambient inputs
// ---------------------------------------------------------------------------

/**
 * `H` is the record of hook *values* — what the hooks returned, not the hooks
 * themselves. Everything downstream reads `H[K]` directly.
 */
export type AnyHooks = Record<string, unknown>;

/**
 * How hooks are written: React-ecosystem hooks — `useQuery`, `useMediaQuery`,
 * anything — called by the runtime in render position with the current props,
 * so the rules of hooks hold and `useThing(id)`-shaped hooks still work.
 *
 * A plain function of props is a valid entry too: it is a custom hook that
 * happens to call no hooks. What the name is telling you is the *calling
 * convention* — every entry runs unconditionally, in declaration order, on
 * every render — which holds whether or not there is a `use*` call inside.
 *
 * `state` is here because the React ecosystem demands it: `useQuery` keys and
 * `enabled` flags are routinely derived from component state, and a data layer
 * you cannot drive from state is not interop. It is the one deliberate cycle in
 * the design — a hook reading state can change its value, which raises
 * `HookChanged`, which can change state again. That is the same footgun as a
 * bad dependency array, and it is on you in the same way.
 *
 * **One function, named `use…`, returning the record:**
 *
 *     useHooks: function useCartHooks(props, state) {
 *       const catalog = useCatalogQuery(props.customerId)
 *       return { catalog, stale: catalog.stale, online: useOnlineStatus() }
 *     }
 *
 * It reads like the top of an ordinary React component because that is exactly
 * what it is. The `use` prefix is not there to appease anything: this really is
 * a custom hook by React's own definition — a function that calls hooks — and
 * naming it so is what puts the body inside `rules-of-hooks`, which then
 * enforces the invariant the whole slot depends on. No conditional call, no
 * early return, no loop.
 *
 * A record of per-key functions would read the same and infer the same, but it
 * cannot express the `const catalog = …` line above: a hook called once and
 * projected several ways. Calling `useQuery` twice to get two tracked values is
 * two subscriptions, not one.
 *
 * `H` is inferred from the return type; `props` and `state` are contextually
 * typed from the surrounding `define`, so nothing here needs an annotation.
 *
 * One related house rule, forced by the same lint: reach for services with
 * `Effect.flatMap(Service, …)` or `Effect.gen`, never `Service.use(…)`. The
 * rule reads any `.use(` as React 19's `use` hook and rejects it everywhere
 * outside a component.
 */
export type HookSpec<Props, State, H extends AnyHooks> = (props: Props, state: State) => H;

/**
 * Everything readable at a moment: accumulated state plus ambient inputs.
 *
 * `props` and `hooks` are reads. Copying one into `state` is the only way to
 * reintroduce tearing, so the API never asks you to.
 */
export interface Snapshot<Props, State, H extends AnyHooks> {
  readonly state: State;
  readonly props: Props;
  readonly hooks: H;
}

export type Dispatch<Action> = (action: Action) => void;

/** The internal vocabulary. Outputs are not in `dispatch`. */
export interface RenderSnapshot<Props, State, Action, H extends AnyHooks> extends Snapshot<
  Props,
  State,
  H
> {
  readonly dispatch: Dispatch<Action>;
}

/** Pure. `ReactNode` out, JSX in — nothing accumulates through the tree. */
export type Render<Props, State, Action, H extends AnyHooks> = (
  snapshot: RenderSnapshot<Props, State, Action, H>,
) => ReactNode;

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------

/**
 * One tag for every hook, whole-object like `PropsChanged`: `previous` is the
 * last snapshot of `H`, and the handler decides what it cares about by
 * comparing it against `hooks` on the snapshot — the same shape as every
 * other whole-object comparison in this file.
 *
 * A variant per hook key was tried first and cut: hooks are a short
 * hand-written record already, so a handler per key multiplied reducer runs
 * to say what one comparison over the whole record already says — and it
 * bought that at the cost of a mistyped key silently compiling to a handler
 * that is never called (see `LifecycleHandlers`, which no longer generates
 * these).
 */
export type HookChanged<H extends AnyHooks> = {
  readonly _tag: "HookChanged";
  readonly previous: H;
};

/**
 * The lifecycle actions as values, `Unmounted` among them — so `blueprint.reduce`
 * can be handed one and teardown is testable without mounting anything.
 */
export type LifecycleAction<Props, H extends AnyHooks> =
  | { readonly _tag: "Mounted" }
  | {
      readonly _tag: "PropsChanged";
      readonly previous: Props;
    }
  | HookChanged<H>
  | {
      readonly _tag: "Error";
      readonly error: unknown;
      readonly cause: Cause.Cause<never>;
    }
  | { readonly _tag: "Unmounted" };

/**
 * One handler, in the shape every other handler has. The action shape comes from
 * `LifecycleAction`, so there is one place a lifecycle action is described.
 */
type LifecycleHandler<Tag extends LifecycleTag, Props, State, Action, H extends AnyHooks, R> = (
  action: Extract<LifecycleAction<Props, H>, { readonly _tag: Tag }>,
  snapshot: Snapshot<Props, State, H>,
) => Next<State, Action, R>;

/**
 * Actions the runtime raises. All optional — most components ignore them.
 *
 * Ambient input arriving is an *event*, so it is an action and goes through
 * `reducer` like everything else, under a key that reads like every other key
 * and a signature that matches every other signature. There is exactly one way
 * state moves, and now it looks like one way.
 *
 * They stay inbound-only: they are not in the declared vocabulary, so
 * `dispatch` will not accept them and nobody can synthesise a prop change. What
 * used to be a sigil keeping them out of your namespace is now `LifecycleTag`
 * keeping you out of theirs — the same guarantee, checked rather than dodged.
 */
export interface LifecycleHandlers<Props, State, Action, H extends AnyHooks, R = never> {
  /** Fires once, after the initial state exists. Where startup commands live. */
  readonly Mounted?: LifecycleHandler<"Mounted", Props, State, Action, H, R>;

  /**
   * Props are a fresh object every render, so this fires constantly. That is
   * fine: returning the *same state reference* is the no-op. It puts the "did
   * anything I care about change" decision in `reducer`, where it can see the
   * state.
   *
   * Whole-object, deliberately: props are one object behind a schema that can
   * be wide, and a handler per prop field would multiply reducer runs to say
   * what one comparison already says.
   */
  readonly PropsChanged?: LifecycleHandler<"PropsChanged", Props, State, Action, H, R>;

  /**
   * Fires whenever any hook's value changes, whole-object like `PropsChanged`:
   * `hooks` is a short hand-written record, and comparing it here — once — says
   * what a handler per hook key needed one comparison each to say.
   */
  readonly HookChanged?: LifecycleHandler<"HookChanged", Props, State, Action, H, R>;

  /**
   * Commands cannot fail, but they can still *die* — and a Layer can fail
   * while building the services a command asked for. Both arrive here, the
   * latter reified as a defect, since a command's own error channel is
   * `never`. Left unhandled, it is rethrown into the nearest React error
   * boundary — the idiomatic default, and no configuration for the common
   * case.
   *
   * `error` is the squashed cause, so the common handler never has to learn
   * `Cause`. `cause` is there for the ones that do.
   */
  readonly Error?: LifecycleHandler<"Error", Props, State, Action, H, R>;

  /**
   * Uniform in shape and narrow in meaning: the component is gone, so the
   * runtime reads `Next.command(…)` and discards the rest. A returned state has
   * nowhere to go and an emitted action has nowhere to land — return
   * `snapshot.state` and put the work in the command.
   *
   * `blueprint.reduce` discards it identically, so a teardown test folded
   * through `reduce` and the same feature under the runtime cannot disagree.
   *
   * Uniformity is free here. `ManagedRuntime.make` sets
   * `onFiberStart: Fiber.runIn(scope)`, so `runFork` already forks into the root
   * scope: an unmount command takes the same path as any other command. It therefore
   * outlives the component but still dies when the Provider unmounts, and its
   * finalizers run on interruption. Detaching to the global scope would be
   * unbounded, which is a leak surface with no upside.
   *
   * Scope this honestly: it releases **in-app** resources — drop a lock, cancel
   * a subscription, flush to localStorage. It is *not* guaranteed delivery to a
   * server. React unmount fires on SPA navigation, not on tab close, and the
   * browser will not wait for a fiber. Anything requiring delivery wants
   * `navigator.sendBeacon` in a `pagehide` handler, which cannot be an Effect.
   */
  readonly Unmounted?: LifecycleHandler<"Unmounted", Props, State, Action, H, R>;
}

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

/**
 * The excess-property backstop, and it has to run *after* inference rather than
 * during it.
 *
 * TypeScript's own check does not fire here. A handler is written
 * `(action, { state }) => ({ ...state, lmao: 5 })` with no return annotation, so
 * the literal's type is *inferred* rather than compared against `Next<State, …>`
 * — and freshness, which is what excess-property checking keys off, does not
 * survive being inferred into a function's return type. The contextual type from
 * the constraint is enough to type `action` and `state`, and not enough to
 * reject a key that is not in the state. Annotating every handler restores it,
 * but that is discipline rather than enforcement, and the annotation is the
 * thing `define` exists to avoid writing.
 *
 * What does survive is the key itself: `lmao` is in `U`'s inferred handler
 * return type, so the excess is recoverable from `U` once the argument has been
 * inferred. This maps over the handlers and lands a string-literal type on the
 * offending key, so the error names both the handler and the property.
 *
 * Intersected onto the parameter like every other guard here — bare `U` is the
 * inference site and the intersection reduces afterwards, so the error lands on
 * the argument rather than on the result.
 */
export type StatePart<N> = N extends readonly [infer S, unknown] ? S : N;

export type Excess<N, State> = N extends unknown ? Exclude<keyof StatePart<N>, keyof State> : never;

export type Exhaustive<U, State> = {
  readonly [K in keyof U]: U[K] extends (...args: never) => infer N
    ? [Excess<N, State>] extends [never]
      ? unknown
      : `state has no property ${Excess<N, State> & string}`
    : unknown;
};

/**
 * Exhaustive over the declared actions; lifecycle handlers stay optional; output
 * tags are absent from the key set, so writing a handler for one is a compile
 * error rather than a handler that silently never fires.
 *
 * Keyed off `cases` rather than off the union, which is a straight lookup where
 * an array of schemas needed a distributive `Extract` per key — and which is
 * also what flattens a nested vocabulary into the key set for free.
 */
export type Reducer<
  Props,
  State,
  A extends AnyVocabulary<"internal">,
  O extends AnyVocabulary<"outbound">,
  H extends AnyHooks,
  R = never,
> = {
  readonly [K in keyof A["cases"]]: (
    action: A["cases"][K]["Type"],
    snapshot: Snapshot<Props, State, H>,
  ) => Next<State, Emit<A, O>, R>;
} & LifecycleHandlers<Props, State, Emit<A, O>, H, R>;

/**
 * A feature's behaviour, before it is wired to a runtime. `component` turns one
 * into an `FC<Props>`; until then it is an inert value you can unit-test.
 */
export interface Blueprint<
  in Props,
  State,
  Action,
  Output,
  H extends AnyHooks = {},
  out R = never,
> {
  /**
   * The whole reducer as one pure function — Elm's `Msg -> Model -> Model`,
   * with the snapshot standing in for the state.
   *
   * Exposed so a test never needs the reducer record hoisted into an annotated
   * constant; annotating it would replace the literal type that `R` is computed
   * from, and that degradation is silent. Takes lifecycle actions too, so
   * "what happens when this prop changes" is a direct call rather than a
   * mounted component. Unhandled lifecycle actions return the state unchanged —
   * every `LifecycleHandlers` entry is optional by design. `Unmounted` is the
   * one handled action whose returned state is dropped rather than returned,
   * matching what the runtime does with it; only its command survives. Nothing
   * else is optional:
   * `action`'s type requires a handler for every declared tag, so a missing one
   * outside the lifecycle set means the value reaching `reduce` didn't come
   * from the typed surface, and that throws rather than swallowing the defect.
   *
   * No React, no runtime, no mounting.
   */
  readonly reduce: (
    action: Action | LifecycleAction<Props, H>,
    snapshot: Snapshot<Props, State, H>,
  ) => Next<State, Action | Output, R>;

  /**
   * Fold a sequence, run each command against `layer`, feed what it emits back
   * in, and report what left.
   *
   * Here rather than in userland because it has to agree with the runtime about
   * `initialState`, `Unmounted` discarding state, and
   * which tags re-enter versus leave. Hand-written in a test file it is a
   * replica, and a replica drifts — a test that passes against a divergent
   * replica is worse than no test. The honest way to ship it is to factor the
   * runtime as a headless core plus a React binding, at which point this is the
   * core with a synchronous clock rather than a second implementation.
   *
   * `outputs` is what makes this a *feature* test rather than a reducer test:
   * "given these actions, this feature announces `OrderPlaced` once" is the
   * assertion a parent's contract actually depends on.
   */
  readonly run: (
    actions: Iterable<Action | LifecycleAction<Props, H>>,
    options: {
      readonly props: Props;
      readonly hooks: H;
      readonly layer: Layer.Layer<R>;
    },
  ) => Effect.Effect<{
    readonly state: State;
    readonly emitted: ReadonlyArray<Action>;
    readonly outputs: ReadonlyArray<Output>;
  }>;
}

// ---------------------------------------------------------------------------
// Defining a feature
// ---------------------------------------------------------------------------

/**
 * What `define` hands back: the four pieces of a blueprint, each already bound
 * to this feature's `Props`, `State`, vocabularies and hooks.
 *
 * `initialState`, `reducer` and `render` are identity functions at runtime.
 * They exist only to *supply* those types, which is what makes a piece
 * writable on its own — in its own file, with no annotation and no
 * `satisfies SomethingComplex`. Passing the pieces inline to `create` works
 * exactly as well; use whichever suits the feature's size.
 */
export interface Definition<
  Props,
  State,
  A extends AnyVocabulary<"internal">,
  O extends AnyVocabulary<"outbound">,
  H extends AnyHooks,
> {
  readonly initialState: (initialState: (props: Props) => State) => (props: Props) => State;

  readonly reducer: <U extends Reducer<Props, State, A, O, H, any>>(
    reducer: U & Exhaustive<U, State>,
  ) => U;

  readonly render: (
    render: Render<Props, State, MemberOf<A>, H>,
  ) => Render<Props, State, MemberOf<A>, H>;

  readonly create: <U extends Reducer<Props, State, A, O, H, any>>(parts: {
    /** A pure projection of props, evaluated lazily on mount. Startup
     *  *commands* belong to `Mounted`; this is only the value. */
    readonly initialState: (props: Props) => State;
    readonly reducer: U & Exhaustive<U, State>;
    readonly render: Render<Props, State, MemberOf<A>, H>;
  }) => Blueprint<Props, State, MemberOf<A>, MemberOf<O>, H, ServicesOf<U>>;
}

/**
 * Declare what a feature is made of, then build it.
 *
 * Every piece arrives from a *value*, so there are no explicit type arguments
 * at all — `Props`, `State`, the vocabularies and the hooks are inferred from
 * one object literal.
 *
 *     const Cart = define({
 *       props: Props,
 *       state: State,
 *       action: Action.of([…]),
 *       output: Action.of([OrderPlaced]),
 *       useHooks: …,
 *     })
 *
 *     export const cart = Cart.create({ initialState, reducer, render })
 *
 * `output` defaults to the empty vocabulary, so a leaf feature declares nothing
 * and the surface is exactly what it was before the split. That default matters
 * more than it looks: the split has to cost nothing until you need it, or every
 * component grows an empty declaration and the distinction stops carrying
 * information.
 *
 * `props` is validated on mount and whenever the props object identity changes
 * — which is every render driven by an ancestor, and no render driven by this
 * feature's own state, because React hands back the identical props object
 * then. A failure throws into the nearest React error boundary rather than
 * being reported: a malformed prop is the *parent's* defect, and a handler here
 * could only swallow it.
 *
 * The check runs with `onExcessProperty: "error"` and `errors: "all"`, so one
 * bad spread reports every problem at once instead of one per debugging round.
 * It costs single-digit microseconds for a typical feature. Two things make
 * it more expensive, neither of which matters at feature granularity and both
 * of which matter if you make a blueprint out of a list row: array-valued props
 * scale linearly with length, and optional fields cost roughly 2.5× required
 * ones. Prefer `Schema.optional` anyway — `Schema.optionalKey` is the cheap one
 * but rejects `prop={undefined}`, which ordinary React produces constantly.
 */
export const define: <
  PropsSchema extends AnyPropsSchema,
  StateSchema extends AnyStateSchema,
  A extends AnyVocabulary<"internal">,
  O extends AnyVocabulary<"outbound"> = NoOutputs,
  H extends AnyHooks = {},
>(spec: {
  /**
   * The intersection is load-bearing, and both halves are doing different work.
   *
   * `PropsSchema` bare is the *inference site*. A conditional type is a
   * non-inferrable position, so `NoTransform<PropsSchema>` on its own would
   * leave nothing to infer from and `PropsSchema` would fall back to its
   * constraint — props would become an anonymous record of `unknown`
   * throughout `useHooks`, `reducer` and `render`. The guard would go with it:
   * `NoTransform<Struct<Struct.Fields>>` is `unknown`, since encoding a record
   * of `unknown` is identity — so it accepts anything, including the
   * transforming schema it exists to reject.
   *
   * `& NoTransform<PropsSchema>` is then checked against the inferred type and
   * reduces: `& unknown` is a no-op, `& never` leaves nothing assignable — so
   * the error lands on this argument rather than wherever the result is used.
   */
  readonly props: PropsSchema & NoTransform<PropsSchema>;
  readonly state: StateSchema;

  /**
   * No lifecycle-tag guard on either vocabulary. Neither can receive an
   * unbranded value, so the only way in is `Action` / `Output`, and the check is
   * already spent on the string literal there.
   */
  readonly action: A;

  /** What this feature announces. Never handled here. */
  readonly output?: O & Disjoint<A, O> & NoPropCollision<PropsSchema, O>;

  readonly useHooks?: HookSpec<PropsOf<PropsSchema>, StateOf<StateSchema>, H>;
}) => Definition<PropsOf<PropsSchema>, StateOf<StateSchema>, A, O, H> = (spec) => {
  return {
    initialState: (initialState) => (props) => initialState(props),
    reducer: identity,
    render: identity,
    create: (parts) => {
      return {
        /**
         * A missing handler is the documented no-op only for a *lifecycle*
         * tag — every `LifecycleHandlers` entry is optional by design. A
         * missing handler for anything else is a defect: `Reducer` requires
         * one for every declared action tag, so reaching this branch means
         * the action arrived without going through the typed surface (a bad
         * cast, a malformed devtools replay) — that case still throws, same
         * as calling `undefined` always did.
         */
        reduce: (action, snapshot) => {
          const handler = handlerFor(parts.reducer, action._tag);
          if (handler) {
            const next = handler(action, snapshot);
            if (action._tag !== "Unmounted") return next;

            /**
             * `Unmounted`'s returned state is discarded here for the same
             * reason `run`'s `step` discards it: the component is gone, so the
             * state has nowhere to go. Only the command survives.
             *
             * The alternative — returning the handler's `Next` verbatim and
             * leaving the discard to the runtime — made the library answer the
             * same question two ways. That matters because `reduce` is sold, a
             * few lines up, as the way to test teardown *without mounting
             * anything*: a test folding `Unmounted` through `reduce` saw
             * `{ count: 999 }` while the same feature under `run` saw the state
             * before it, and the disagreement was silent in both directions.
             *
             * The cost is that `reduce` is no longer a plain "look up the
             * handler and return what it said", and that a handler's returned
             * state becomes unobservable. Both are the point: it is already
             * unobservable in the runtime, so being able to observe it here
             * only ever meant asserting a value production can never produce.
             */
            const command = Next.command(next);
            return command === undefined ? snapshot.state : [snapshot.state, command];
          }
          if (isLifecycleTag(action._tag)) return snapshot.state;
          throw new TypeError(`No reducer handler for action "${action._tag}"`);
        },

        run: (actions, options) =>
          discharge(
            Effect.gen(function* () {
              type Entry = {
                readonly msg: { _tag: string };
                readonly origin: "seed" | "command" | "settled";
              };

              type Ctx = { readonly tag: string; readonly key?: string; readonly policy?: Policy };

              const queue = yield* Queue.unbounded<Entry>();
              const inFlight = yield* Ref.make(0);
              const groups = yield* Ref.make(new Map<string, ReadonlyArray<Fiber.Fiber<void>>>());
              const emitted: { _tag: string }[] = [];
              const outputs: { _tag: string }[] = [];
              // Named fields rather than `{ ...options }`: `options` also
              // carries `layer`, and spreading it whole put a `Layer` on every
              // handler's `Snapshot`. The type never saw it — excess-property
              // checking does not fire on a non-fresh spread — so the object
              // this file elsewhere describes as entirely encodable was
              // carrying the one value in the API that cannot be.
              const snapshot = { props: options.props, hooks: options.hooks };
              let state = parts.initialState(options.props);

              for (const action of actions) {
                yield* Queue.offer(queue, { msg: action, origin: "seed" });
              }

              // `Object.hasOwn`, for the reason given on `isLifecycleTag`:
              // `cases` inherits from `Object.prototype`, so `in` reports
              // `"constructor"`/`"toString"` as declared outputs. Routing an
              // unknown tag outbound is worse than the lifecycle case — it
              // leaves the feature through an `on<Tag>` prop instead of
              // reaching the throw.
              const isOutput = (action: { _tag: string }): boolean =>
                spec.output?.cases !== undefined && Object.hasOwn(spec.output.cases, action._tag);

              const groupId = (target: Group): string => `${target.tag}::${target.key ?? ""}`;

              const cancelGroup = (target: Group) =>
                Effect.gen(function* () {
                  const map = yield* Ref.get(groups);
                  const ids =
                    target.key !== undefined
                      ? [groupId(target)]
                      : Array.from(map.keys()).filter((id) => id.startsWith(`${target.tag}::`));

                  for (const id of ids) {
                    for (const fiber of map.get(id) ?? []) yield* Fiber.interrupt(fiber);
                  }
                });

              const runGuarded = (ctx: Ctx, run: Effect.Effect<void, never, any>) =>
                Effect.gen(function* () {
                  const policy = ctx.policy ?? "parallel";
                  const id = groupId(ctx);
                  const running = (yield* Ref.get(groups)).get(id) ?? [];

                  if (policy === "ignore" && running.length > 0) return;
                  if (policy === "restart")
                    for (const fiber of running) yield* Fiber.interrupt(fiber);

                  const awaitPrior =
                    policy === "queue" && running.length > 0
                      ? Fiber.joinAll(running).pipe(Effect.asVoid)
                      : Effect.void;

                  yield* Ref.update(inFlight, (n) => n + 1);

                  // A fiber `Fiber.interrupt`ed before the scheduler has started it never
                  // runs its own body — including an `Effect.ensuring` baked into that
                  // body — so cleanup can't live there. A separate watcher, waiting on
                  // `Fiber.await`, observes the Exit regardless of whether the fiber ever
                  // got to start.
                  const fiber: Fiber.Fiber<void> = yield* awaitPrior.pipe(
                    Effect.andThen(run),
                    Effect.forkChild,
                  );

                  yield* Ref.update(groups, (m) =>
                    new Map(m).set(
                      id,
                      policy === "restart" ? [fiber] : [...(m.get(id) ?? []), fiber],
                    ),
                  );

                  const cleanup = Effect.gen(function* () {
                    yield* Ref.update(inFlight, (n) => n - 1);
                    yield* Ref.update(groups, (m) => {
                      const next = new Map(m);
                      const remaining = (next.get(id) ?? []).filter((f) => f !== fiber);
                      if (remaining.length > 0) next.set(id, remaining);
                      else next.delete(id);
                      return next;
                    });
                    // A command that settles without ever emitting (a `Command.effect`,
                    // an interrupted/cancelled group) still has to wake the drain loop's
                    // `Queue.take` — otherwise quiescence is reached but nothing is left
                    // to unblock it. A no-op entry does that uniformly.
                    yield* Queue.offer(queue, { msg: { _tag: "__settled__" }, origin: "settled" });
                  });

                  yield* Fiber.await(fiber).pipe(Effect.andThen(cleanup), Effect.forkChild);
                });

              const interpret = (
                command: Command<any, any>,
                ctx: Ctx,
              ): Effect.Effect<void, never, any> =>
                Effect.gen(function* () {
                  switch (command._tag) {
                    case "None":
                      return;
                    case "Effect":
                      return yield* runGuarded(ctx, Effect.asVoid(command.effect));
                    case "Stream":
                      return yield* runGuarded(
                        ctx,
                        Stream.runForEach(command.stream, (msg) =>
                          Queue.offer(queue, { msg, origin: "command" }),
                        ),
                      );
                    case "Batch":
                      for (const member of command.commands) yield* interpret(member, ctx);
                      return;
                    case "Cancel":
                      return yield* cancelGroup(command.target);
                    case "Guarded": {
                      const next: Ctx =
                        ctx.policy === undefined
                          ? { tag: ctx.tag, key: command.key, policy: command.policy }
                          : ctx;
                      return yield* interpret(command.command, next);
                    }
                  }
                });

              const step = ({ msg: action, origin }: Entry) =>
                Effect.gen(function* () {
                  if (origin === "settled") return;

                  yield* Effect.log("step", action);

                  if (isOutput(action)) return void outputs.push(action);

                  const handler = handlerFor(parts.reducer, action._tag);
                  if (!handler) {
                    if (isLifecycleTag(action._tag)) return;
                    throw new TypeError(`No reducer handler for action "${action._tag}"`);
                  }

                  const next = handler(action, { ...snapshot, state });
                  const command = Next.command(next);
                  if (action._tag !== "Unmounted") state = Next.state(next);
                  if (command) yield* interpret(command, { tag: action._tag });
                });

              // drain until quiescent: nothing queued and nothing running
              while (true) {
                const queueSize = yield* Queue.size(queue);
                const inFlightCount = yield* Ref.get(inFlight);
                if (queueSize === 0 && inFlightCount === 0) break;
                const entry = yield* Queue.take(queue);
                if (entry.origin === "command" && !isOutput(entry.msg)) emitted.push(entry.msg);
                yield* step(entry);
              }

              return { state, emitted, outputs };
            }).pipe(Effect.provide(options.layer)),
            /**
             * Only `R` needs discharging here, not the success value.
             *
             * `interpret`/`runGuarded` type every command's requirement `any`
             * internally, because the real `R` is computed the same way
             * `ServicesOf<U>` is — by walking handler return types this scope
             * cannot name (see `ServiceOf`) — so TS can't see that
             * `options.layer` (typed `Layer.Layer<R>` by the caller) actually
             * discharges it. `discharge` asserts exactly that one channel;
             * `state`/`emitted`/`outputs` stay inferred and checked.
             */
          ),
      };
    },
  };
};

/** A sequence, folded. This is the shape most real assertions want. */
// export const sequence = (
//   [{ _tag: "Incremented" }, { _tag: "Incremented" }, { _tag: "Decremented" }] as const
// ).reduce((state, action) => Next.state(counter.reduce(action, { ...at(0), state })), { count: 0 }); // { count: 5 }

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Emitted for every state change in every mounted feature. Loosely typed on
 * purpose — a root observer sees features it knows nothing about. Because
 * actions, outputs, state *and* props are all schemas with no escape hatch left
 * in them, every field here encodes: this is a devtools transport, a replay log
 * or a `postMessage` away from being useful, with no schema-aware serialiser in
 * between.
 *
 * `instance` and `cause` are what turn a flat log into something usable once
 * there are N independent machines instead of one.
 *
 * Without `instance`, two `<Presence roomId="…">` are indistinguishable in the
 * stream, because `name` is a *blueprint* name. Without `cause`, order is all
 * you have — and in a decentralised architecture order tells you almost nothing
 * while causality tells you everything. `cause` is what renders
 * `cart#3/OrderPlaced → presence#1/RosterSynced` as an edge rather than as two
 * unrelated lines that happened to be adjacent.
 *
 * This is also the argument for outputs over a shared bus, restated as a data
 * structure: an output has a declared tag, a schema, and a known recipient, so
 * the edge is derivable. Bus traffic is opaque and the edge is not.
 *
 * Note what is *not* here: a `Query` variant. It was in the sketch, and cutting
 * queries removed it — which is the second-order reason they went. An externally
 * sent message has no origin the runtime can name, so the one variant that could
 * not be filled in was also the only one crossing a boundary inbound.
 */
export interface DevtoolsEvent {
  readonly name: string;
  /** Which mount. */
  readonly instance: string;
  readonly action: unknown;
  readonly previous: unknown;
  readonly next: unknown;
  /** What caused this action, when the runtime knows. */
  readonly cause?:
    | { readonly _tag: "Dispatch" }
    | { readonly _tag: "Command"; readonly action: string }
    | { readonly _tag: "Output"; readonly from: string; readonly output: string };
}

export interface RuntimeOptions {
  readonly onEvent?: (event: DevtoolsEvent) => void;
}

/**
 * The runtime is a root provider, in the shape everyone knows from Redux and
 * Apollo — one `ManagedRuntime`, layers memoised once, services shared across
 * every feature. One line in `main.tsx`, so incremental adoption survives.
 *
 * The catch a bare `<Provider>` would hit: React context is untyped with
 * respect to what it holds, so `useContext` would throw away the compile-time
 * DI guarantee that was the point of tracking `R` at all. Hence a factory —
 * `component` is closed over the root's `R`, so building a feature that needs
 * a service the root does not provide is a compile error.
 *
 * Two gaps stay, both irreducible: a missing Provider is a *runtime* error,
 * because React cannot check ancestry statically; and StrictMode will build and
 * dispose the runtime twice in development.
 */
export declare const createRuntime: <RootR, RootE>(
  layer: Layer.Layer<RootR, RootE>,
  options?: RuntimeOptions,
) => {
  readonly Provider: FC<{ readonly children?: ReactNode }>;

  /**
   * The `on<Tag>` handlers are added by the runtime rather than declared in the
   * props schema, because their types are derived from `output` and repeating
   * them per feature would let the two drift.
   *
   * They have to be stripped before the props schema runs. The check uses
   * `onExcessProperty: "error"`, so leaving them in would make every feature
   * with an output fail validation on its own mount. Stripping is by derived
   * name and not by an `on*` prefix rule: a declared prop may legitimately be
   * called `onScroll`, and `NoPropCollision` is what guarantees the two sets are
   * disjoint so the runtime can strip exactly `outputs.map(o => "on" + tag)` and
   * leave everything else for the schema to check.
   */
  readonly component: {
    <
      Props,
      State,
      Action,
      Output extends { readonly _tag: string },
      H extends AnyHooks,
      R extends RootR,
    >(
      blueprint: Blueprint<Props, State, Action, Output, H, R>,
      options?: { readonly name?: string },
    ): FC<Simplify<Props & OutputProps<Output>>>;

    /** A feature may bring its own layer; the root must cover the residue. */
    <
      Props,
      State,
      Action,
      Output extends { readonly _tag: string },
      H extends AnyHooks,
      R,
      LayerError,
    >(
      blueprint: Blueprint<Props, State, Action, Output, H, R>,
      options: {
        readonly layer: Layer.Layer<Exclude<R, RootR>, LayerError, RootR>;
        readonly name?: string;
      },
    ): FC<Simplify<Props & OutputProps<Output>>>;
  };

  /**
   * Escape hatch for ordinary React components that are not blueprints. Keeps
   * incremental adoption honest: plain components can still reach the same
   * services without being rewritten.
   */
  readonly useRuntime: () => ManagedRuntime.ManagedRuntime<RootR, RootE>;
};
