import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FC,
  type ReactNode,
} from "react";
import {
  Cause,
  Context,
  Effect,
  Equivalence,
  Exit,
  Fiber,
  identity,
  Layer,
  ManagedRuntime,
  Option,
  Pipeable,
  Queue,
  Ref,
  Schema,
  SchemaParser,
  Stream,
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
     *
     * Under an outer policy the members are one group — one `Cancel` target,
     * one `"queue"` serialisation queue — without being one another's
     * predecessors: `"ignore"` runs every member rather than dropping all but
     * the first, and `"restart"` interrupts the previous dispatch's members
     * rather than the siblings it was forked alongside.
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
 *
 * This is the *address*, and only the address. Whether a command supersedes
 * another is a separate question the runtime answers internally — the two would
 * otherwise disagree over `Command.batch`, whose members must be one target for
 * `Cancel` and one queue for `"queue"` while still not superseding each other
 * under `"ignore"` and `"restart"`. Nothing here has to change for that to
 * work, which is the point.
 */
export interface Group {
  readonly tag: string;
  readonly key?: string;
}

/**
 * What a new dispatch does about the ones already running in its group.
 *
 * `"restart"` interrupts them, `"ignore"` stands down, `"queue"` waits for all
 * of them to settle, `"parallel"` (the default, meaning no `Guarded` wrapper at
 * all) neither looks nor waits. `"queue"` is the one that counts a command's
 * own `Command.batch` siblings as things to wait for; the other two are about
 * earlier dispatches only.
 */
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
 * Which *interpretation* forked a fiber — the concurrency identity, as opposed
 * to the cancellation identity a `Group` carries.
 *
 * One is minted per policy-bearing command per dispatch and shared by every
 * fiber that interpretation forks, so every member of a `Command.batch` gets
 * the same one. That is the whole point: `ignore` and `restart` are about
 * superseding *an earlier dispatch*, and a group key cannot tell an earlier
 * dispatch apart from a sibling forked three lines ago. Indexing the members
 * into `key#0`/`key#1` was the alternative, and it answered this question by
 * destroying the other one — an indexed key is not the key `Command.cancel`
 * was given, and it is not the key the serialisation queue is per.
 *
 * A bare `Symbol` because nothing may read it except by identity: it is never
 * addressed, never serialised, and never appears in the public surface.
 */
type Occurrence = symbol;

/** A forked command fiber together with the interpretation that forked it. */
type GroupEntry = {
  readonly fiber: Fiber.Fiber<void>;
  readonly occurrence: Occurrence;
};

/**
 * The group a command's fibers belong to, plus the policy governing them.
 * `tag` is the issuing action's, filled by the runtime; see `Group`.
 */
type CommandContext = {
  readonly tag: string;
  readonly key?: string;
  readonly policy?: Policy;
  /** Set when a `Guarded` node adopts a policy; see `Occurrence`. */
  readonly occurrence?: Occurrence;
};

/**
 * The command interpreter, shared by `Blueprint.run` and `createFeatureStore`.
 *
 * This is the headless core `Blueprint.run`'s JSDoc names — the thing that has
 * to exist exactly once, because it is where concurrency policy, grouping and
 * cancellation are decided. Two copies would have to agree forever about what
 * `"restart"` interrupts and when a group is empty, and the one that is not
 * under test drifts. `run`'s suite is what guards this.
 *
 * Parameterised only by its two sinks, which is the entire difference between
 * the two callers. `run` points `emit` at its own queue and terminates at
 * quiescence; the store points `emit` at a synchronous fold and never
 * terminates. Everything below — the fiber bookkeeping — is identical.
 */
const commandInterpreter = (deps: {
  /** Where a command's emissions go: back to the reducer, or out as an output. */
  readonly emit: (message: { readonly _tag: string }) => Effect.Effect<void>;
  /**
   * Run after a command's fiber settles, however it settled. `run` needs it to
   * wake a `Queue.take` that quiescence would otherwise never unblock; the
   * store has nothing to wake and passes `Effect.void`.
   */
  readonly settled: Effect.Effect<void>;
  /**
   * How a command's fiber ended.
   *
   * `runGuarded` forks and returns, so a command that *dies* dies on a fiber
   * nobody is awaiting — an enclosing `catchCause` around `interpret` sees
   * nothing, because `interpret` has already returned by the time the command
   * runs. Without this hook the store's whole documented error contract is
   * unreachable: every defect from a command is discarded silently.
   *
   * Interruption is normal here (that is what `restart` and unmount do), so a
   * caller filters on it rather than treating every non-success as a defect.
   */
  readonly onExit?: (exit: Exit.Exit<void>, ctx: CommandContext) => Effect.Effect<void>;
  readonly inFlight: Ref.Ref<number>;
  readonly groups: Ref.Ref<Map<string, ReadonlyArray<GroupEntry>>>;
}) => {
  const groupId = (target: Group): string => `${target.tag}::${target.key ?? ""}`;

  const cancelGroup = (target: Group) =>
    Effect.gen(function* () {
      const map = yield* Ref.get(deps.groups);
      const ids =
        target.key !== undefined
          ? [groupId(target)]
          : Array.from(map.keys()).filter((id) => id.startsWith(`${target.tag}::`));

      // Every occurrence in the group, deliberately: `Cancel` addresses the
      // group, and a batch's members are all of them at that address.
      for (const id of ids) {
        for (const entry of map.get(id) ?? []) yield* Fiber.interrupt(entry.fiber);
      }
    });

  const runGuarded = (ctx: CommandContext, run: Effect.Effect<void, never, any>) =>
    Effect.gen(function* () {
      const policy = ctx.policy ?? "parallel";
      const id = groupId(ctx);
      // Unguarded commands never read it back — `"parallel"` neither waits nor
      // interrupts — but every entry carries one so the map has a single shape.
      const occurrence: Occurrence = ctx.occurrence ?? Symbol();
      const running = (yield* Ref.get(deps.groups)).get(id) ?? [];
      const superseded = running.filter((entry) => entry.occurrence !== occurrence);

      // `superseded`, not `running`: both policies mean "an earlier dispatch is
      // already here", and a batch member forked microseconds ago by the same
      // interpretation is not that. Filtering on the group alone made `ignore`
      // drop every member after the first and `restart` have members interrupt
      // each other.
      if (policy === "ignore" && superseded.length > 0) return;
      if (policy === "restart") for (const entry of superseded) yield* Fiber.interrupt(entry.fiber);

      // `running`, not `superseded`: the serialisation queue is per *group*, so
      // a `queue`-wrapped batch runs its members one at a time. This is the one
      // place the two identities deliberately disagree.
      //
      // `Fiber.await` each rather than `Fiber.joinAll`, which re-raises the
      // first failing fiber's cause and stops joining there — killing the
      // follower before its own body ran, and (once the cause is caught)
      // releasing it on a predecessor's *death* while that predecessor's
      // siblings still hold the queue. `queue` means "wait your turn", not
      // "share their fate" and not "leave when one of them trips".
      const awaitPrior =
        policy === "queue" && running.length > 0
          ? Effect.forEach(running, (entry) => Fiber.await(entry.fiber), { discard: true })
          : Effect.void;

      yield* Ref.update(deps.inFlight, (n) => n + 1);

      // A fiber `Fiber.interrupt`ed before the scheduler has started it never
      // runs its own body — including an `Effect.ensuring` baked into that
      // body — so cleanup can't live there. A separate watcher, waiting on
      // `Fiber.await`, observes the Exit regardless of whether the fiber ever
      // got to start.
      const fiber: Fiber.Fiber<void> = yield* awaitPrior.pipe(
        Effect.andThen(run),
        Effect.forkChild,
      );

      // `restart` removes exactly the fibers it just interrupted rather than
      // replacing the whole entry: a `[fiber]` reset also erased the siblings
      // of this interpretation, after which a member that forked earlier in the
      // same batch was no longer reachable from `Cancel` or from unmount.
      //
      // By fiber identity and not by occurrence, because `Fiber.interrupt`
      // above is a yield point: an entry that arrived after this call's
      // snapshot was never interrupted, so dropping it would leave a live fiber
      // nothing can reach. `interpret` happens to be serialised on one fiber
      // today, but nothing enforces that and this does not need it to hold.
      const interrupted =
        policy === "restart" ? new Set(superseded.map((entry) => entry.fiber)) : undefined;

      yield* Ref.update(deps.groups, (m) => {
        const existing = m.get(id) ?? [];
        const kept =
          interrupted === undefined
            ? existing
            : existing.filter((entry) => !interrupted.has(entry.fiber));
        return new Map(m).set(id, [...kept, { fiber, occurrence }]);
      });

      const cleanup = Effect.gen(function* () {
        yield* Ref.update(deps.inFlight, (n) => n - 1);
        yield* Ref.update(deps.groups, (m) => {
          const next = new Map(m);
          const remaining = (next.get(id) ?? []).filter((entry) => entry.fiber !== fiber);
          if (remaining.length > 0) next.set(id, remaining);
          else next.delete(id);
          return next;
        });
        yield* deps.settled;
      });

      // `ensuring`, not `andThen`: chaining `cleanup` behind `onExit` meant an
      // `onExit` that died skipped the `inFlight` decrement and the `groups`
      // removal, leaving a settled fiber in its group forever — after which
      // every command under an `ignore` policy for that group is silently
      // dropped for the rest of the mount. The bookkeeping has to survive a
      // reporting failure.
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit) =>
          deps.onExit === undefined ? Effect.void : deps.onExit(exit, ctx),
        ),
        Effect.ensuring(cleanup),
        Effect.forkChild,
      );
    });

  const interpret = (
    command: Command<any, any>,
    ctx: CommandContext,
  ): Effect.Effect<void, never, any> =>
    Effect.gen(function* () {
      switch (command._tag) {
        case "None":
          return;
        case "Effect":
          return yield* runGuarded(ctx, Effect.asVoid(command.effect));
        case "Stream":
          return yield* runGuarded(ctx, Stream.runForEach(command.stream, deps.emit));
        case "Batch":
          // One `ctx`, so every member shares both the issuing action's group
          // *and*, when a policy is in force, its occurrence. The group is what
          // `Cancel` addresses and what `queue` serialises per; the occurrence
          // is what tells these members apart from an earlier dispatch's. See
          // `Occurrence` for why indexing members into `key#0`/`key#1` — the
          // obvious fix, tried and reverted — cannot work.
          for (const member of command.commands) yield* interpret(member, ctx);
          return;
        case "Cancel":
          return yield* cancelGroup(command.target);
        case "Guarded": {
          // The occurrence is minted here and only here: one interpretation of
          // one policy-bearing command, however many fibers it goes on to fork.
          // An inner `Guarded` under an outer one keeps `ctx` whole, so
          // "outermost wins" covers the occurrence as well as the policy.
          const next: CommandContext =
            ctx.policy === undefined
              ? { tag: ctx.tag, key: command.key, policy: command.policy, occurrence: Symbol() }
              : ctx;
          return yield* interpret(command.command, next);
        }
      }
    });

  return { interpret } as const;
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
 * The pieces `component` needs and a *test* never should.
 *
 * `reduce` and `run` are the whole public surface of a blueprint, and that is
 * deliberate — they are the two things a test drives. But mounting needs four
 * more: the initial state, the render function, the hook spec, and the two
 * schemas (props to validate against, outputs to strip `on<Tag>` props by and
 * to route emissions through). All four are `define`'s inputs, and none of them
 * survives into `Blueprint` today, which is why `component` has nothing to work
 * with.
 *
 * Behind a `unique symbol` rather than a named property: it keeps them off
 * hovers, off `Object.keys`, and unreachable by name from userland, so the
 * public surface stays exactly the two methods above. `component` is in this
 * module, so it can read the symbol; nobody else can spell it.
 *
 * Every member is contravariant in `Props`, which is what keeps `in Props` on
 * `Blueprint` true.
 */
const internals: unique symbol = Symbol("@tea/internals");

export interface BlueprintInternals<Props, State, Action, H extends AnyHooks> {
  readonly initialState: (props: Props) => State;
  readonly render: Render<Props, State, Action, H>;
  readonly useHooks: HookSpec<Props, State, H> | undefined;
  /** Validated on mount and on every props-identity change. See `define`. */
  readonly props: AnyPropsSchema;
  /**
   * The declared output tags, as strings. Two uses, both in `component`: strip
   * exactly `on${tag}` from incoming props before the schema runs, and decide
   * whether an emitted message re-enters the reducer or leaves through a prop.
   * `NoPropCollision` is what makes stripping by derived name safe.
   */
  readonly outputTags: ReadonlyArray<string>;

  /**
   * Whether the feature declared a handler for this tag.
   *
   * `reduce` deliberately cannot answer this: it no-ops for an undeclared
   * *lifecycle* handler, so "handled and returned the same state" and "nobody
   * declared one" come back identical. The store has to tell them apart for
   * exactly one tag — a defect with an `Error` handler is handled, and one
   * without has to reach React's error boundary instead of vanishing.
   */
  readonly handles: (tag: string) => boolean;
}

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
  /** @internal Not part of the surface — see `BlueprintInternals`. */
  readonly [internals]: BlueprintInternals<Props, State, Action, H>;

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
      /**
       * The declared output tags, derived **once** and shared by everything
       * that needs to know what an output is.
       *
       * `create` used to compute this for the internals slot while `run`
       * separately asked `Object.hasOwn(spec.output.cases, tag)` — one rule,
       * two spellings, inside one closure, and nothing keeping them agreed. A
       * change to how outputs are enumerated (nested vocabularies, aliasing)
       * had two places to land and no failure if it only landed in one.
       *
       * Own keys only, for the reason given on `isLifecycleTag`: `cases`
       * inherits from `Object.prototype`, so an `in` test would report
       * `"constructor"` and `"toString"` as declared outputs — and routing an
       * unknown tag outbound is worse than the lifecycle case, since it leaves
       * the feature through an `on<Tag>` prop instead of reaching the throw.
       */
      const outputTags = spec.output ? Object.keys(spec.output.cases) : [];
      const outputTagSet = new Set(outputTags);

      return {
        [internals]: {
          initialState: parts.initialState,
          render: parts.render,
          useHooks: spec.useHooks,
          props: spec.props,
          outputTags,
          handles: (tag) => handlerFor(parts.reducer, tag) !== undefined,
        },

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

              const queue = yield* Queue.unbounded<Entry>();
              const inFlight = yield* Ref.make(0);
              const groups = yield* Ref.make(new Map<string, ReadonlyArray<GroupEntry>>());
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

              // The same set `component` routes against — see `outputTags`.
              const isOutput = (action: { _tag: string }): boolean => outputTagSet.has(action._tag);

              // The interpreter is `commandInterpreter`'s, not a local copy —
              // see it for why there is exactly one. `run` points `emit` at its
              // own queue (so emissions re-enter this fold) and supplies the
              // settled-marker its quiescence check depends on.
              const { interpret } = commandInterpreter({
                inFlight,
                groups,
                emit: (msg) => Queue.offer(queue, { msg, origin: "command" }).pipe(Effect.asVoid),
                // A command that settles without ever emitting (a `Command.effect`,
                // an interrupted/cancelled group) still has to wake the drain loop's
                // `Queue.take` — otherwise quiescence is reached but nothing is left
                // to unblock it. A no-op entry does that uniformly.
                settled: Queue.offer(queue, {
                  msg: { _tag: "__settled__" },
                  origin: "settled",
                }).pipe(Effect.asVoid),
              });

              const step = ({ msg: action, origin }: Entry) =>
                Effect.gen(function* () {
                  if (origin === "settled") return;

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

              // drain until quiescent: nothing queued and nothing running.
              //
              // `inFlight` first, then the queue: a fiber offers its follow-up
              // work *before* `cleanup` decrements, so reading in that order
              // means a fiber that slips between the two reads can only make
              // the check more conservative. The other order has a real hole —
              // see the teardown drain, which had the same one.
              while (true) {
                const inFlightCount = yield* Ref.get(inFlight);
                const queueSize = yield* Queue.size(queue);
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

// ---------------------------------------------------------------------------
// Mounting a blueprint
// ---------------------------------------------------------------------------

/**
 * The live half of `run`, and the seam the React binding is written against.
 *
 * `run` is already the fold — queue, groups, policies, quiescence — with a
 * synchronous drain and an array of seed actions. Mounting is the same fold with
 * React's clock: actions arrive from `dispatch` and from lifecycle effects
 * rather than from an iterable, there is no quiescence to reach because the
 * component is alive, and every state change has to reach React instead of a
 * local `let`.
 *
 * Naming that seam is what stops there being two implementations of the drain
 * loop. The docs on `Blueprint.run` already call this out as the honest
 * factoring: a headless core plus a React binding, where `run` is the core with
 * a synchronous clock. Everything below the line in `FeatureStore` is that core;
 * everything above it is React.
 *
 * **Two lifetimes, and the split is forced by StrictMode.** The store *object*
 * — state cell, subscribers, pending queue — is created in `useState`'s
 * initialiser and lives as long as the component instance. Its Effect *scope*
 * is opened by `start` and closed by `stop`, once per mount.
 *
 * Collapsing the two was the obvious first shape and is wrong: React's
 * simulated unmount → remount reuses the same store object, so a single
 * `dispose` in the cleanup leaves the remounted component holding a closed
 * scope, and every command after that point forks into nothing and silently
 * does not run. That is not the cosmetic double-build already documented for
 * the root runtime — it breaks development outright. Split, a remount re-arms
 * the store and state survives it, which is what React means by remounting the
 * same instance.
 *
 * `OwnershipRule` still holds and is what the split preserves: a real unmount
 * discards the `useState` cell along with the scope, so state is still born at
 * mount and gone at unmount, with no registry and no retain.
 */
export interface FeatureStore<Props, State, Action, H extends AnyHooks> {
  /** The `useSyncExternalStore` pair. `getSnapshot` must be reference-stable
   *  between changes, or React re-renders forever. */
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => State;

  /** The declared vocabulary, from `render`. Stable identity — it lands in props. */
  readonly dispatch: Dispatch<Action>;

  /**
   * The snapshot's ambient half, pushed from the render body — and, because it
   * is the only thing that sees both the old and new values, the place
   * `PropsChanged` and `HookChanged` are detected and raised.
   *
   * **Called during render, and it returns the state to render.** That is what
   * makes the ambient lifecycle actions cost zero extra render cycles: props
   * arrive on a render, the comparison happens on that same render, and the
   * state the handler produced is what gets drawn. Detecting in an effect
   * instead means the first render always paints the pre-change state and a
   * second one corrects it — a visible tear for anything derived from props.
   *
   * `component` calls this **before** subscribing, so `useSyncExternalStore`
   * reads `getSnapshot` after the fold and both of React's reads — the one
   * during render and the one it takes when the render finishes — see the same
   * state. Subscribing first meant the fold moved the snapshot underneath
   * React's consistency check, which is the extra render this whole path
   * exists to avoid.
   *
   * The returned state is therefore redundant at that call site and kept for
   * direct drivers (and the tests): it is the same value `getSnapshot` returns
   * from this point on.
   *
   * **Must be idempotent, and the equivalences are what make it so.** A render
   * can be thrown away — StrictMode double-renders, Suspense retries,
   * concurrent restarts — and this mutates a store, so it will be called twice
   * with the same values. The second call compares equal and does nothing.
   * That property is the whole licence for mutating during render, so a change
   * detected by identity rather than by value would forfeit it.
   *
   * The first call **seeds the baseline** rather than raising: the store is
   * built from `initialState(props)` before any hook has run, so there is no
   * previous `H` to compare against and nothing has changed yet.
   *
   * `props` and `hooks` are still reads, per `Snapshot` — the store keeps the
   * latest values only to hand to a handler when a command-emitted action lands
   * between renders, never accumulating them into state.
   */
  readonly sync: (props: Props, hooks: H) => State;

  /**
   * Open the mount scope, build the feature layer inside it, raise `Mounted`.
   *
   * Idempotent while already started, so React's effect running twice cannot
   * open two scopes. Calling it after `stop` re-arms the store — the dev
   * remount path — reusing the existing state rather than reprojecting
   * `initialState`.
   */
  readonly start: () => void;

  /**
   * Raise `Unmounted`, fork its command into the **root** scope, and close the
   * mount scope once that command settles.
   *
   * The ordering is the whole point, and it is what keeps
   * `LifecycleHandlers.Unmounted`'s promise honest now that a mount scope
   * exists. Forking teardown into the mount scope would have `stop` interrupt
   * the command it just issued; closing the mount scope immediately would
   * release the feature's own layer out from under a teardown command that
   * needs it — which is exactly the feature that had a reason to bring a layer.
   *
   * Returns synchronously, because React's cleanup is synchronous. The drain
   * happens on a fiber, so a `start` that follows must not have its new scope
   * torn down by the previous `stop` completing late.
   */
  readonly stop: () => void;
}

/**
 * The live fold: the headless half of the runtime, exported so it is testable
 * without a DOM. `component` is the only intended caller.
 *
 * **The fold is synchronous and only commands are Effects.** A fold cannot
 * round-trip through the queue — the value would arrive a render late, which is
 * the extra cycle the design exists to avoid. Every action therefore folds in a
 * plain call: read state, run the handler, write state, notify, fork the
 * command, and `component` reads the result through `getSnapshot` on the same
 * render. (`sync` still returns the folded state; its one caller stopped using
 * the return value when the `useSyncExternalStore` read moved below it.)
 *
 * A re-entrancy guard serialises them. Without it a command emitting on the
 * forking stack — `Stream.succeed`, which is what `Command.output` is today —
 * re-enters the fold mid-write and the outer fold writes stale state on the way
 * out. Actions arriving while a fold is on the stack queue behind it.
 *
 * What has to be true, and what `run` already answers for the synchronous case:
 *
 *   - `interpret` and the fiber bookkeeping under it are the same code, lifted
 *     out of `run` rather than written twice. Two implementations of
 *     policy, group and cancellation semantics would have to agree forever,
 *     which is the replica problem `run`'s own docs cite. The existing `run`
 *     suite is the gate on that extraction.
 *   - The drain loop loses its exit condition. `run` stops at quiescence; this
 *     one runs until the mount scope closes, so it is a forked `Queue.take`.
 *   - `getSnapshot` returns the *same reference* until the next write, or
 *     `useSyncExternalStore` re-renders forever.
 *   - Routing is `outputTags`: a message whose tag is in it leaves through
 *     `emit`, everything else re-enters the reducer. Own-keys only.
 *   - `Unmounted` discards the returned state and keeps only the command —
 *     matching `reduce` and `run`, both of which document why.
 *   - A defect reaches the `Error` handler; with none declared it reaches
 *     `defect`, which `component` rethrows during render.
 *   - The feature `layer` builds once per `start`, inside the mount scope, so
 *     its finalizers run on `stop`.
 */
export const createFeatureStore = <Props, State, Action, H extends AnyHooks>(args: {
  readonly blueprint: Blueprint<Props, State, Action, any, H, any>;
  readonly props: Props;
  /**
   * Derived once per blueprint and passed in, not derived here: `sync` runs on
   * every render of every mount, and `Schema.toEquivalence` walks the whole AST.
   */
  readonly equivalence: {
    readonly props: Equivalence.Equivalence<Props>;
    readonly hooks: Equivalence.Equivalence<H>;
  };
  readonly runtime: ManagedRuntime.ManagedRuntime<any, any>;
  readonly layer: Layer.Layer<any, any, any> | undefined;
  /**
   * Where a routed output goes. `component` points this at the `on<Tag>` props.
   * Throws when no handler exists for the tag, and that throw is **not** the
   * feature's to catch — see `emitOutput` below.
   */
  readonly emit: (output: { readonly _tag: string }) => void;
  /** A defect no `Error` handler took. `component` rethrows it during render. */
  readonly defect: (error: unknown) => void;
}): FeatureStore<Props, State, Action, H> => {
  const { blueprint, equivalence, runtime, layer, emit, defect } = args;
  const { initialState, outputTags, handles } = blueprint[internals];

  // Own-keys semantics without the prototype hazard: `outputTags` is already a
  // plain array of own keys taken from `cases`, so membership is a lookup in a
  // Set rather than an `in` against an object that inherits `Object.prototype`.
  const outputs = new Set(outputTags);

  /**
   * A unit of work for the mount fiber.
   *
   * `Teardown` is a queue entry rather than an interrupt from outside, and that
   * is what makes `LifecycleHandlers.Unmounted`'s promise keepable. Forking
   * teardown externally and then interrupting the mount fiber raced two ways —
   * the teardown could run before `Layer.build` had produced the context it
   * needed, and the interrupt could land on the *next* mount's work. Delivered
   * in-band it runs on the fiber that owns the scope, with the feature's own
   * services still alive, and the loop then returns so `Effect.scoped` releases
   * them.
   */
  type Work =
    | { readonly _tag: "Run"; readonly command: Command<any, any>; readonly ctx: CommandContext }
    | { readonly _tag: "Teardown"; readonly command: Command<any, any> | undefined }
    /**
     * A command's fiber settled. Carries nothing — its only job is to wake a
     * blocked `Queue.take` so the teardown drain can re-test quiescence.
     *
     * This is `run`'s trick, and not having it is why the first teardown drain
     * had to poll: with no wake-up, a command that finishes without emitting
     * leaves the drain asleep on a queue that will never receive anything, so
     * the only way to notice was to wake up periodically and look. `run` has
     * offered this marker all along; the store passed `Effect.void` and then
     * reinvented the wait badly.
     */
    | { readonly _tag: "Settled" };

  /**
   * Per *mount*, not per store — the second half of the split lifetime.
   *
   * These were per store, and it was wrong in a way only a remount showed: the
   * fiber draining the queue is per mount, so after `stop` the previous fiber
   * was still parked on `Queue.take` when the next `start` offered its
   * `Mounted` command. The queue handed it to the longest-waiting taker, which
   * was the *dying* fiber, and the interrupt that followed killed it. A feature
   * whose `Mounted` command loads its data never loaded it in development.
   *
   * A fresh set per mount means a stale fiber can only ever take from a queue
   * nobody offers to again.
   */
  type Mount = {
    readonly queue: Queue.Queue<Work>;
    readonly groups: Ref.Ref<Map<string, ReadonlyArray<GroupEntry>>>;
    readonly inFlight: Ref.Ref<number>;
  };

  let mount: Mount | undefined;

  /**
   * Whether `start` has been called and `stop` has not.
   *
   * Tracked apart from `mount` because the two spans differ at both ends.
   * `mount` stays set through teardown — a teardown command that emits an
   * action whose handler returns another command has to reach the fiber that
   * is still draining, and clearing `mount` in `stop` dropped exactly that
   * second hop. And it stays clear until `start`, so this is what makes
   * `start` idempotent rather than the presence of cells.
   */
  let active = false;

  /**
   * Whether a mount has ever been armed.
   *
   * This, not "has been stopped", is what gates buffering. Keying it on
   * `stopped` meant a mount fiber that *died* — a feature layer that failed to
   * build — left `stopped` false forever, so every later command piled into
   * `buffered` and nothing ever drained it: the Retry button the `Error`
   * handler rendered did nothing, silently, while the array grew without
   * bound. Buffering exists for exactly one window — before the first `start`,
   * where a child's layout effect can dispatch — and outside it a command with
   * no fiber to run it is dropped.
   */
  let everStarted = false;

  /**
   * Commands issued while no mount is draining.
   *
   * `dispatch` reaches the subtree during render, and React runs every
   * descendant's layout effects before this component's own passive effect —
   * so a child dispatching from `useLayoutEffect` folds before `start` has
   * armed anything. Dropping those was silent: the state moved and the command
   * vanished. Buffered here and flushed by `start`.
   */
  const buffered: Array<Work> = [];

  let state = initialState(args.props);
  let props = args.props;
  // `undefined` until the first `sync`, which is what makes that call seed the
  // baseline instead of raising: there is no previous `H` to compare against.
  let hooks: H | undefined;

  const subscribers = new Set<() => void>();

  // The re-entrancy guard. A command emitting on the forking stack —
  // `Stream.succeed`, which is what `Command.output` is — would otherwise
  // re-enter mid-write and have the outer fold overwrite it on the way out.
  let folding = false;
  const pending: Array<{ readonly _tag: string }> = [];

  /**
   * Set while `sync` is folding, which is to say: while React is rendering.
   *
   * A fold that moves state normally notifies subscribers, and the only
   * subscriber is `useSyncExternalStore`. Doing that from the render body is a
   * setState during render — React says so out loud ("Cannot update a component
   * while rendering a different component") — and it is redundant besides:
   * `component` subscribes *after* calling `sync`, so the render that asked for
   * the fold reads the folded state and the paint is already happening.
   * Notifying would schedule a second one.
   *
   * Only ambient changes take this path. A `dispatch` or a command emission
   * arrives outside render and must still notify.
   */
  let syncing = false;

  const snapshot = (): Snapshot<Props, State, H> => ({
    state,
    props,
    hooks: hooks ?? ({} as H),
  });

  /**
   * The mount a fold currently belongs to, when it belongs to one.
   *
   * A command emits, `fold` runs it through the reducer, and whatever the
   * handler returns has to go back to *the mount whose command emitted it* —
   * not to whichever mount happens to be installed. Those are the same thing
   * right up until a remount: `stop` deliberately leaves the dying cells in
   * place, so StrictMode's `start; stop; start` had a teardown chain's second
   * hop queued into the new mount and run against the new mount's services,
   * while the dying drain saw an empty queue, declared quiescence and closed
   * the scope out from under it.
   *
   * Set around the synchronous fold and restored after, which is sound because
   * `fold` drains `pending` on one stack: a nested `fold` re-enters while the
   * scope is still standing, and nothing else can interleave with it.
   */
  let routing: Mount | undefined;

  const withRouting = <T>(target: Mount, body: () => T): T => {
    const previous = routing;
    routing = target;
    try {
      return body();
    } finally {
      routing = previous;
    }
  };

  const offer = (work: Work): void => {
    const target = routing ?? mount;
    if (target !== undefined) Queue.offerUnsafe(target.queue, work);
    else if (!everStarted) buffered.push(work);
    // No fiber to run it: either the component is gone, or its mount died.
    // Dropping is correct — buffering here is what grew without bound.
    //
    // Silently, and that was checked rather than assumed. Reporting the drop
    // was tried and reverted: `component`'s `defect` sink throws to the nearest
    // error boundary, so any feature whose `Error` handler returns a command —
    // log it, clear a lock, schedule a retry — had its recovery UI replaced by
    // a boundary crash on the very failure the handler exists to handle. A
    // silent drop is a worse diagnostic and a much better outcome. Making the
    // dropped work *run* is the open design question; see `tea.specs.md`.
  };

  /**
   * An output leaving through `emit`, and the one throw the feature must not be
   * able to catch.
   *
   * A missing `on<Tag>` prop is the *parent's* bug — `OutputProps` makes every
   * one required, so an absent handler means a cast or a spread bypassed the
   * type. Letting it fall into the generic `catch` below routed it into this
   * feature's own `Error` handler, so a feature with error handling quietly
   * swallowed its caller's mistake and transitioned into an error state instead
   * of anybody finding out. It goes straight to the boundary, like a bad prop.
   */
  const emitOutput = (action: { readonly _tag: string }): void => {
    try {
      emit(action);
    } catch (error) {
      defect(error);
    }
  };

  /**
   * One action, folded. Returns whether the state reference moved, so the
   * caller can notify exactly once for a run of them.
   */
  const foldOne = (action: { readonly _tag: string }): boolean => {
    if (outputs.has(action._tag)) {
      emitOutput(action);
      return false;
    }

    const next = blueprint.reduce(action as never, snapshot());
    const command = Next.command(next);
    const nextState = Next.state(next);

    // `reduce` already discards `Unmounted`'s state for us — it returns
    // `snapshot.state` — so there is no special case here, and the runtime
    // cannot disagree with a test that folds `Unmounted` through `reduce`.
    const moved = nextState !== state;
    if (moved) state = nextState;
    if (command) offer({ _tag: "Run", command, ctx: { tag: action._tag } });
    return moved;
  };

  const fold = (action: { readonly _tag: string }): void => {
    pending.push(action);
    if (folding) return;

    folding = true;
    let moved = false;
    try {
      while (pending.length > 0) {
        const next = pending.shift()!;
        try {
          if (foldOne(next)) moved = true;
        } catch (error) {
          raiseDefect(error, next._tag);
        }
      }
    } finally {
      folding = false;
      // After the guard is released, so a subscriber that dispatches
      // re-entrantly starts a fresh fold rather than queueing behind a dead one.
      if (moved && !syncing) for (const subscriber of subscribers) subscriber();
    }
  };

  /**
   * A defect, routed the way `LifecycleHandlers.Error` documents: to the
   * `Error` handler when one is declared, and to React's nearest error boundary
   * when one is not.
   *
   * Goes through `fold` rather than pushing onto `pending` directly. Pushing
   * was a silent drop for every defect raised *outside* an in-progress fold —
   * a dying command, a failing layer — because nothing then started a drain:
   * the `Error` action sat in the array until some unrelated dispatch happened
   * to arrive, at which point it fired late and looked caused by that dispatch.
   * Called from inside a fold, `fold` still just queues behind the current one.
   *
   * A defect raised *by* the `Error` handler goes straight out, or the two
   * would feed each other forever.
   */
  function raiseDefect(error: unknown, from: string): void {
    if (from === "Error" || !handles("Error")) {
      defect(error);
      return;
    }
    fold({ _tag: "Error", error, cause: Cause.die(error) } as never);
  }

  const run = (cells: Mount) => {
    /**
     * This mount's services, once built. Local to the fiber rather than a cell
     * on the store, which is what makes it impossible for `stop` to clear it
     * out from under the teardown command that still needs it, or for a second
     * mount to see the first one's already-released context.
     */
    let context: Context.Context<never> | undefined;

    /**
     * This fiber is no longer draining anything.
     *
     * Guarded on identity so a mount that has already been replaced is not
     * clobbered, and idempotent so the failure path can run it early — see the
     * `catchCause` below for why it has to.
     *
     * Clears `active` as well as `mount`. Clearing only `mount` left the store
     * in a state no call could leave: `start` is guarded by `if (active)
     * return`, and only `stop` clears `active` — so after a mount fiber died (a
     * failed feature layer) nothing could re-arm it at all. Clearing both means
     * a `start` that follows *can* build fresh cells and work.
     *
     * "Can", not "does": through `component` nothing calls `start` again. The
     * arming effect is `useEffect(…, [store])` and `store` never changes, so a
     * driver holding the store directly recovers and a React subtree does not —
     * its commands are dropped for the life of the component. Re-arming from
     * the binding is an open design question (auto-retry loops on a permanently
     * failing layer; demand-driven re-arm re-enters `fold`) recorded in
     * `tea.specs.md`. This clear is a precondition for whichever answer wins,
     * not the answer.
     */
    const release = (): void => {
      if (mount !== cells) return;
      mount = undefined;
      active = false;
    };

    // `emit` folds straight onto the command fiber's stack rather than going
    // through a queue: the guard already serialises it, and a queue here would
    // put a scheduler hop between a command emitting and the state moving.
    const { interpret } = commandInterpreter({
      inFlight: cells.inFlight,
      groups: cells.groups,
      // Routed to `cells`, not to whichever mount is installed: a command
      // forked by *this* mount emitting must have its follow-up work run on
      // *this* mount's fiber, with this mount's services, inside this mount's
      // scope. See `routing`.
      emit: (message) => Effect.sync(() => withRouting(cells, () => fold(message))),
      // Teardown waits for quiescence exactly as `run` does, so it needs the
      // same wake-up. Ignored by the main loop; load-bearing during the drain.
      //
      // Straight onto `cells.queue`, never through `offer`: `offer` targets
      // whichever mount is *current*, and `stop` deliberately leaves the dying
      // mount's fibers running while a following `start` — StrictMode's dev
      // remount is exactly `start; stop; start` — installs new cells. The
      // marker then woke the new mount's queue while this drain sat blocked on
      // `Queue.take` of the old one, so every remount held the scope and the
      // feature layer open for the full 5s bound and reported a spurious
      // "did not settle" defect into the `Error` handler.
      settled: Effect.sync(() => Queue.offerUnsafe(cells.queue, { _tag: "Settled" })),
      // The store's whole error contract hangs off this. Interruption is the
      // normal way a command ends here — `restart` and unmount both cause it —
      // so only a genuine failure is a defect.
      // `ctx.tag`, never a constant: it is the tag of the action that issued
      // the command, so a command forked *by the `Error` handler* reports with
      // `from === "Error"` and `raiseDefect` sends it straight to the boundary.
      // Hard-coding `"Command"` here defeated that guard entirely and made
      // Error → command → defect → Error an unbounded loop.
      onExit: (exit, ctx) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            // Routed like `emit`, and for the same reason: the `Error`
            // handler's compensating command belongs to the mount whose
            // command died, not to its successor.
            withRouting(cells, () => raiseDefect(Cause.squash(exit.cause), ctx.tag));
          }
        }),
    });

    const provided = (effect: Effect.Effect<void, never, any>) =>
      context === undefined ? effect : Effect.provide(effect, context);

    /**
     * Teardown, drained to quiescence — `run`'s loop, not a second one.
     *
     * Four review rounds landed here. The bespoke versions (join the fibers a
     * command just forked; poll the queue with a step budget; bound each hop)
     * each fixed one case and broke another, because they were all
     * approximations of a question `run` already answers exactly: *is anything
     * queued, and is anything running?* `inFlight` is decremented in
     * `runGuarded`'s `cleanup`, which runs after `onExit` — so waiting on it
     * waits for the error-reporting watcher too, which is the thing every
     * hand-rolled variant kept missing.
     *
     * Blocking on `Queue.take` rather than polling is what the `Settled`
     * marker buys: a command that finishes without emitting still wakes this.
     *
     * **In-flight work is interrupted first**, and that is what makes
     * quiescence reachable at all. `run` cannot terminate while a
     * never-completing command is running — a known limitation recorded in
     * this file's spec — and a feature with a `Mounted` subscription is
     * exactly that. Unmount cancels outstanding work and *then* runs teardown,
     * which is the reason this loop terminates where `run`'s would not.
     *
     * It is also a **behaviour change** and not only a fix: the sweep is
     * unconditional, so a command dispatched in the same tick as unmount is
     * now interrupted where the previous polling drain let it finish. A
     * "flush on the way out" pattern has to live in the `Unmounted` handler,
     * which runs after the sweep. What unmount owes work already in flight is
     * an open question in this file's spec, not a settled one.
     */
    const teardown = (command: Command<any, any> | undefined) =>
      Effect.gen(function* () {
        const running = yield* Ref.get(cells.groups);
        for (const entries of running.values()) {
          for (const entry of entries) yield* Fiber.interrupt(entry.fiber);
        }

        if (command !== undefined) {
          yield* provided(interpret(command, { tag: "Unmounted" }));
        }

        while (true) {
          // `inFlight` before the queue, and the order is load-bearing. A
          // settling fiber offers follow-up work — `onExit` → `raiseDefect` →
          // `fold` → `offer` — *before* `cleanup` decrements `inFlight`.
          // Reading the queue first let a preemption between the two reads
          // return a size taken before the offer and a count taken after the
          // decrement, so the drain closed the scope with the `Error`
          // handler's compensating command still sitting in the queue. This
          // order can only ever be conservative.
          const inFlight = yield* Ref.get(cells.inFlight);
          const queued = yield* Queue.size(cells.queue);
          if (queued === 0 && inFlight === 0) return;

          const work = yield* Queue.take(cells.queue);
          if (work._tag === "Run") yield* provided(interpret(work.command, work.ctx));
        }
      });

    return Effect.gen(function* () {
      if (layer !== undefined) {
        // `orDie` rather than a type assertion: a Layer that fails while
        // building the services a command asked for is exactly what
        // `LifecycleHandlers.Error` documents as arriving reified as a defect.
        context = (yield* Effect.orDie(Layer.build(layer))) as Context.Context<never>;
      }

      while (true) {
        const work = yield* Queue.take(cells.queue);

        if (work._tag === "Teardown") {
          // Bounded as a whole, so a teardown that will never settle cannot
          // hold the scope — and with it the feature layer — open for the life
          // of the page. Reported rather than silent: an abandoned teardown is
          // a defect the feature should hear about.
          //
          // A command the `Error` handler returns *on this path* is queued and
          // then dropped, because the next statement closes the scope. That is
          // the bound doing its job, not an oversight: teardown has already had
          // five seconds and is being abandoned, so inviting more work into a
          // scope that is closing would make the bound unbounded. The handler
          // is told; it does not get to keep the page alive.
          //
          // `withRouting`, so that stays true after a remount. Unrouted, this
          // was the one `raiseDefect` on a mount fiber that fell through to
          // whichever mount is installed — queueing the dying mount's
          // compensating command into its *successor*, to run against the
          // successor's scope and services. Dropped is the contract here;
          // resurrected somewhere else is not.
          yield* teardown(work.command).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap((finished) =>
              Option.isNone(finished)
                ? Effect.sync(() =>
                    withRouting(cells, () =>
                      raiseDefect(
                        new Error("Unmounted did not settle within 5s; scope closed anyway"),
                        "Unmounted",
                      ),
                    ),
                  )
                : Effect.void,
            ),
          );
          return;
        }

        if (work._tag === "Settled") continue;

        yield* provided(interpret(work.command, work.ctx));
      }
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return;
          // Released *before* the defect is raised, and the order is the whole
          // point. Raising first left `mount` pointing at this fiber's queue
          // while the fiber was terminating, so the `Error` handler's own
          // compensating command was enqueued to a reader that would never
          // take again: not run, and not caught by `offer`'s dropped-work
          // branch either — swallowed with no report at all. Released first,
          // the same command takes the documented drop path.
          release();
          raiseDefect(Cause.squash(cause), "Mounted");
        }),
      ),
      // Whatever happened, this fiber is no longer draining anything. Leaving
      // `mount` pointing at its queue left the store deaf: a layer that failed
      // to build killed the fiber, and every later dispatch — including the
      // Retry the `Error` handler rendered — queued into the void. Idempotent,
      // since the failure path above has usually run it already.
      Effect.ensuring(Effect.sync(release)),
    );
  };

  return {
    subscribe: (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => void subscribers.delete(onStoreChange);
    },

    getSnapshot: () => state,

    dispatch: (action) => fold(action as { readonly _tag: string }),

    sync: (nextProps, nextHooks) => {
      const previousProps = props;
      const previousHooks = hooks;

      if (previousHooks === undefined) {
        props = nextProps;
        hooks = nextHooks;
        return state;
      }

      const propsMoved = !equivalence.props(previousProps, nextProps);
      const hooksMoved = !equivalence.hooks(previousHooks, nextHooks);

      // Only advanced when something actually moved. Assigning unconditionally
      // meant a render React discarded still advanced the baseline, so the
      // committed render compared new against new and never raised the change
      // at all — losing it rather than merely repeating it. Equal-by-value
      // objects are interchangeable, so keeping the older reference costs
      // nothing.
      if (propsMoved) props = nextProps;
      if (hooksMoved) hooks = nextHooks;
      if (!propsMoved && !hooksMoved) return state;

      syncing = true;
      try {
        if (propsMoved) fold({ _tag: "PropsChanged", previous: previousProps } as never);
        if (hooksMoved) fold({ _tag: "HookChanged", previous: previousHooks } as never);
      } finally {
        syncing = false;
      }

      return state;
    },

    start: () => {
      if (active) return;
      active = true;
      everStarted = true;

      // `Effect.runSync` on the default runtime, not `runtime.runSync`: all
      // three are context-free, and going through the root `ManagedRuntime`
      // forced its layer to build synchronously — which an async root layer
      // cannot do, so the first mount of any feature would block or throw.
      const cells: Mount = {
        queue: Effect.runSync(Queue.unbounded<Work>()),
        groups: Effect.runSync(Ref.make(new Map<string, ReadonlyArray<GroupEntry>>())),
        inFlight: Effect.runSync(Ref.make(0)),
      };

      mount = cells;
      // Anything a layout effect dispatched before this ran.
      for (const work of buffered.splice(0)) Queue.offerUnsafe(cells.queue, work);
      runtime.runFork(run(cells));
      fold({ _tag: "Mounted" });
    },

    stop: () => {
      const cells = mount;
      if (!active) return;
      active = false;

      // Narrowing, and a backstop — not the dead-mount case, which the `active`
      // guard above already took: `start` and `release` set and clear the two
      // together, so the only window where `active` is true without cells is a
      // throw out of `start`'s three `runSync` constructions.
      //
      // It sits before the fold rather than after because that ordering is what
      // the dead-mount decision needs if the window ever widens. Folding
      // `Unmounted` with no fiber left was tried and reverted: `reduce`
      // discards its state and nothing can run its command, so the only
      // observable effect was raising `Error` and notifying
      // `useSyncExternalStore` subscribers on a component React is in the
      // middle of unmounting.
      if (cells === undefined) return;

      // Folded before the queue is detached, because the handler's command has
      // to reach the fiber that still owns the scope. `reduce` discards the
      // returned state, so nothing else of this fold survives.
      let teardown: Command<any, any> | undefined;
      let thrown: { readonly error: unknown } | undefined;
      try {
        teardown = Next.command(blueprint.reduce({ _tag: "Unmounted" } as never, snapshot()));
      } catch (error) {
        thrown = { error };
      }

      Queue.offerUnsafe(cells.queue, { _tag: "Teardown", command: teardown });

      // Reported *after* the marker is queued, so the `Error` handler's own
      // compensating command lands behind `Teardown` rather than in front of
      // it. Raised first, that command was interpreted by the main loop and
      // then killed seconds later by teardown's interrupt sweep — while the
      // identical command reached through a *dying teardown command* survived,
      // because that one is queued after the sweep. Same recovery path, two
      // outcomes, decided by which way the handler was reached.
      if (thrown !== undefined) raiseDefect(thrown.error, "Unmounted");

      // `mount` deliberately stays pointed at these cells. The teardown chain
      // is not necessarily one hop — a teardown command may emit an action
      // whose handler returns another command — and all of it has to reach the
      // fiber that still owns the scope. The fiber clears `mount` itself when
      // it returns. A `start` before then (StrictMode does exactly that)
      // replaces it, and the old fiber's guarded clear then leaves the new one
      // alone.
    },
  };
};

/**
 * The props check, and the reason `AnyPropsSchema` is a `Struct`.
 *
 * `onExcessProperty: "error"` is the whole point: TypeScript's excess-property
 * check **does not fire through a spread**, so `<Cart {...config} />` with extra
 * keys compiles by design, and this is the only layer that can see it.
 * `errors: "all"` reports every problem at once rather than one per debugging
 * round.
 *
 * It **throws**, per `define`: a malformed prop is the parent's defect, so it
 * belongs in the nearest React error boundary. Reporting it to the `Error`
 * handler would let the feature swallow its own caller's bug.
 *
 * Validated, never decoded — `NoTransform` guarantees `Encoded` equals `Type`,
 * so this only ever checks and the returned value is discarded.
 *
 * Memoised per schema: building a parser walks the AST, and this runs on every
 * props-identity change of every mount. The key is the schema object, so a
 * blueprint's parser is built once for the life of the module.
 */
const propsValidators = new WeakMap<AnyPropsSchema, (props: unknown) => unknown>();

const validateProps = (schema: AnyPropsSchema, props: unknown): void => {
  let validate = propsValidators.get(schema);
  if (validate === undefined) {
    validate = SchemaParser.decodeUnknownSync(
      // `AnyPropsSchema` is `Struct<Struct.Fields>`, and a generic field record
      // widens `DecodingServices` to `unknown`. A props schema cannot have
      // decoding services — `NoTransform` forces `Encoded` to equal `Type`, so
      // there is nothing to decode and nothing to require — but the constraint
      // has no way to see that from the erased field type.
      schema as AnyPropsSchema & { readonly DecodingServices: never },
      { onExcessProperty: "error", errors: "all" },
    );
    propsValidators.set(schema, validate);
  }
  validate(props);
};

/**
 * Split the incoming object into the props the schema will see and the output
 * handlers the runtime installed.
 *
 * By derived name, never by an `on*` prefix rule: a declared prop may legitimately
 * be called `onScroll`, and `NoPropCollision` is what guarantees the two sets are
 * disjoint so this can strip exactly the handler names and nothing else.
 *
 * `names` is that set, built once by the caller from `outputTags` rather than
 * per render — the whole reason it arrives as a `ReadonlySet` and not a list.
 */
const splitOutputProps = (
  all: Record<string, unknown>,
  names: ReadonlySet<string>,
): { props: Record<string, unknown>; handlers: Record<string, (payload: unknown) => void> } => {
  if (names.size === 0) return { props: all, handlers: {} };
  const props: Record<string, unknown> = {};
  const handlers: Record<string, (payload: unknown) => void> = {};
  for (const key of Object.keys(all)) {
    if (names.has(key)) handlers[key] = all[key] as (payload: unknown) => void;
    else props[key] = all[key];
  }
  return { props, handlers };
};

/**
 * Whole-record, one level deep, own keys only — the shape `HookChanged`
 * documents, and `Equivalence.Record` is already exactly it: it compares key
 * counts, then `Object.hasOwn` plus the value equivalence per key.
 *
 * Reference equality *per hook value* rather than structural, and that is the
 * right depth: a hook value is whatever the ecosystem hook returned — a query
 * result, a subscription handle, a DOM node — with no schema and no guarantee
 * it is even walkable. Deep-comparing one is unbounded work on a value the
 * library does not own. A hook returning a fresh object every render is the
 * caller's problem, and the same one a bad dependency array is.
 *
 * One instance for the whole module: it closes over nothing.
 */
const hooksEquivalence = Equivalence.Record(
  Equivalence.strictEqual<unknown>(),
) as Equivalence.Equivalence<AnyHooks>;

/** Frozen, so an absent `useHooks` still has a stable `hooks` identity. */
const noHooks: AnyHooks = Object.freeze({});

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
export const createRuntime: <RootR, RootE>(
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
  // `_options` is deliberate: `RuntimeOptions.onEvent` is declared and
  // deliberately unwired for now, so no `DevtoolsEvent` is emitted. Deferred
  // rather than half-built — the `cause: "Output"` variant needs a parent↔child
  // channel that does not exist, and the obvious substitute (blaming whatever
  // the parent dispatches next) invents causality it cannot verify. Recorded in
  // specs.md so the gap is visible rather than looking like an oversight.
} = (layer, _options) => {
  const runtime = ManagedRuntime.make(layer);
  const context = createContext(runtime);

  /**
   * Written once, loosely typed, and cast at the assignment.
   *
   * The declared surface above is two overloads, and an arrow function assigned
   * into an overloaded slot is checked against only the last signature — so
   * annotating the implementation would either lose the no-layer overload or
   * force a third signature nobody calls. The types callers see are the two
   * above; this body is the single implementation behind them, and the cast is
   * the standard one for that shape.
   */
  const component = (
    blueprint: Blueprint<any, any, any, any, any, any>,
    componentOptions: { readonly layer?: Layer.Layer<any, any, any>; readonly name?: string } = {},
  ): FC<any> => {
    // `initialState` is not read here — the store owns it, and reads it off the
    // same slot. It stays on `BlueprintInternals` because the store needs it.
    const { render, useHooks, props: propsSchema, outputTags } = blueprint[internals];
    const name = componentOptions.name ?? "TeaFeature";

    // Defaulted here rather than branched at the call site below: a conditional
    // `useHooks?.(…)` is a conditionally-called hook as far as the lint is
    // concerned, and the lint is the thing enforcing the invariant the slot
    // depends on. Resolved once per blueprint, so the call is unconditional.
    const useFeatureHooks: HookSpec<any, any, AnyHooks> = useHooks ?? (() => noHooks);

    // Derived once per blueprint, not per render: the names are constant, and
    // rebuilding the Set inside `splitOutputProps` cost one throwaway array
    // plus Set on every parent-driven render of every mount — per row, for a
    // feature used in a list.
    const outputPropNames = new Set(outputTags.map((tag) => `on${tag}`));

    // Once per blueprint. `toEquivalence` walks the AST, and `sync` runs on
    // every render of every mount.
    const equivalence = {
      props: Schema.toEquivalence(propsSchema) as Equivalence.Equivalence<Record<string, unknown>>,
      hooks: hooksEquivalence,
    };

    const Feature: FC<Record<string, unknown>> = (incoming) => {
      const rootRuntime = useContext(context);

      // Props identity is the only trigger, per `define`: a render driven by
      // this feature's own state hands back the identical object, so neither
      // the split nor the schema check runs on it.
      const { props, handlers } = useMemo(
        () => splitOutputProps(incoming, outputPropNames),
        [incoming],
      );
      useMemo(() => validateProps(propsSchema, props), [props]);

      // The store outlives any one render and the parent's callbacks do not, so
      // it reads them through a ref rather than closing over the first ones.
      //
      // Written in an effect, not in the render body. A bare render-phase write
      // has no commit-phase counterpart, so a render React discards still
      // overwrites the ref — and an output emitted before the real render
      // commits would then call a callback from a tree that never existed.
      // Outputs arrive on command fibers, i.e. after commit, so the effect is
      // early enough.
      const handlersRef = useRef(handlers);
      useEffect(() => {
        handlersRef.current = handlers;
      }, [handlers]);

      // A defect with no `Error` handler is rethrown *during render*, which is
      // the only place React's nearest error boundary can catch it — throwing
      // from inside a fiber would reach nothing.
      const [defect, setDefect] = useState<{ readonly error: unknown } | undefined>(undefined);
      if (defect) throw defect.error;

      // One store per mount. The initialiser runs once — StrictMode runs it
      // twice in development, which is the second of the two documented gaps.
      const [store] = useState(() =>
        createFeatureStore({
          blueprint,
          props,
          equivalence,
          runtime: rootRuntime,
          layer: componentOptions.layer,
          emit: (output) => {
            const handler = handlerFor(handlersRef.current, `on${output._tag}`);
            if (!handler) {
              throw new TypeError(`No "on${output._tag}" prop for output "${output._tag}"`);
            }
            const { _tag, ...payload } = output as Record<string, unknown> & { _tag: string };
            handler(payload);
          },
          defect: (error) => setDefect({ error }),
        }),
      );

      // Everything a command changed since the last render. Read directly
      // rather than through `useSyncExternalStore`, because the subscription
      // has to come *after* `sync` — see below.
      const committed = store.getSnapshot();

      // Render position, unconditionally, in declaration order — the invariant
      // `HookSpec` describes and the reason the slot is one `use…` function.
      //
      // Reads `committed`, not the post-`sync` state, and that is the documented
      // cycle rather than a bug: a hook whose own value drives a state change
      // sees that change on the next render. Feeding it the post-fold state
      // would need a second hook call to be consistent, which is a second
      // subscription — the exact thing `HookSpec` refuses.
      const hooks = useFeatureHooks(props, committed);

      // In the body, not an effect. `sync` compares props and hooks by value,
      // raises `PropsChanged` / `HookChanged`, and folds them — so a
      // props-driven change paints on the render that carried the props
      // instead of on the one after it. It mutates a store during render,
      // which a discarded render would repeat; the value comparison is what
      // makes the repeat a no-op. See `FeatureStore.sync`.
      store.sync(props, hooks);

      // **After `sync`, and that ordering is the whole point.**
      //
      // `useSyncExternalStore` re-reads `getSnapshot` when the render finishes
      // and schedules another render if the value moved. Subscribing first and
      // folding second is exactly the shape that trips it, and the render-body
      // `sync` exists to avoid a second render, so the two were working against
      // each other on paper. Folding first means both reads see the same state.
      //
      // **On paper**, and stated that way deliberately: the extra render was
      // never reproduced. `getSnapshot` is a stable method and the pre-fold
      // read equalled the previous render's snapshot, so React had nothing to
      // compare unfavourably, and the browser test counts one render either
      // way. This ordering is defensive, not a measured fix, and it ships
      // without a test that would catch a revert — see `tea.specs.md`.
      //
      // Hook order is still stable: this is called unconditionally on every
      // render, just later in the body.
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

      // `Mounted` stays in an effect: it is the one lifecycle action that must
      // not fire for a render React throws away, since its command has side
      // effects. `start`/`stop` rather than a single `dispose` is what lets the
      // StrictMode remount re-arm the store instead of inheriting a closed
      // scope — see `FeatureStore` for the full argument.
      useEffect(() => {
        store.start();
        return () => store.stop();
      }, [store]);

      return render({ state, props, hooks, dispatch: store.dispatch });
    };

    Feature.displayName = name;
    return Feature;
  };

  return {
    // oxlint-disable-next-line react/no-children-prop
    Provider: ({ children }) => createElement(context.Provider, { value: runtime, children }),

    useRuntime: () => runtime,

    component: component as never,
  };
};
