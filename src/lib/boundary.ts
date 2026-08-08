/**
 * A feature's *interface*, separated from its implementation.
 *
 * TYPE SURFACE ONLY, and a **delta on `tea.ts`** — the declarations here replace
 * `define`, `Definition` and `component`; everything else is imported unchanged.
 *
 * The problem this solves: `tea.ts` has one list of actions, and that list is
 * doing two unrelated jobs. `CheckoutAdvanced` is a thing a command observed.
 * `CheckoutCompleted` is a thing the *parent* needs to know about. Only the
 * second is anyone else's business, and nothing distinguishes it — so the moment
 * a store or a `useDispatch` exists, the whole vocabulary is public and ownership
 * is gone. That is `useSelector` erosion, and it arrives through the action list
 * rather than through the state.
 *
 * The split is Halogen's, minus half of it. Halogen gives a component four
 * channels in four types: `input` (parent → child, resent every parent render),
 * `query` (parent commands child), `output` (child announces to parent), and
 * `action` (internal only, never crosses). Mapped onto React:
 *
 *              inbound              outbound
 *   continuous  props                render
 *   discrete    —                    outputs
 *
 * **`queries` were sketched and cut.** The inbound-discrete cell is empty on
 * purpose, and the reason is that React's is empty too: there is no parent → child
 * discrete channel in React outside of refs, and reaching for one is how you get
 * the `pendingCommand`-prop anti-pattern. What a ref-with-methods actually bought
 * was worse than it looked:
 *
 *   - `ref.current?.send(…)` makes "not mounted yet" a silent no-op;
 *   - nothing typed says a query may not be sent during render;
 *   - ordering against `Mounted` was undefined;
 *   - and worst, a query had no traceable origin, so `cause` — the whole point of
 *     the devtools story below — would have had nothing to record but "outside".
 *
 * Halogen does not have those problems because a parent there never holds a
 * handle: it renders a child into a labelled *slot* and queries it by address from
 * inside its own reducer, so issuance is a returned value like everything else.
 * Porting that needs the runtime to track child slots, which is a real build and
 * not a type-level sketch. Until it exists, a parent that must trigger a feature
 * should own the trigger: move the button inside the feature's `render`, and
 * portal it if the DOM layout demands it.
 *
 * What is left is one sentence: **React, with callback props turned into values.**
 * That is the same move commands already make for effects, applied to the outbound
 * direction — and it is what lets `callback`, `OpaqueAnnotation` and the
 * schema-aware props serialiser come out of `tea.ts` entirely.
 *
 * The rest of what the split buys:
 *
 *   - **A bus is unnecessary for the hierarchical case.** Two features under a
 *     common parent talk through outputs and props, which is React's own answer
 *     and stays visible in the tree. A shared service is then only for coupling
 *     that genuinely is not hierarchical — and needing one constantly becomes
 *     evidence the boundaries are wrong rather than a fact of life.
 *   - **Cross-feature causality becomes typed and loggable.** Outputs are schemas,
 *     so a transport sees `cart#3/OrderPlaced → presence#1/RosterSynced` as an
 *     edge. Bus traffic is opaque by construction.
 *   - **A store, if one is ever added, is no longer a boundary hole.** The subtree
 *     gets `dispatch` over the internal vocabulary — which it is entitled to,
 *     being inside the feature — and the outside world gets nothing but props in
 *     and outputs back.
 */

import type { FC, ReactNode } from "react";
import { Schema, type Effect, type Layer, type ManagedRuntime, type Stream } from "effect";
import type {
  AnyHooks,
  AnyPropsSchema,
  AnyStateSchema,
  Command,
  Dispatch,
  DevtoolsEvent,
  Exhaustive,
  HookSpec,
  LifecycleAction,
  LifecycleHandlers,
  Next,
  NotLifecycleTag,
  NoTransform,
  Policy,
  PropsOf,
  ServicesOf,
  Snapshot,
  StateOf,
} from "./tea";

// ---------------------------------------------------------------------------
// The two vocabularies
// ---------------------------------------------------------------------------

/**
 * A message is a tagged struct and nothing more, in both directions. The
 * difference between the two vocabularies is *where a message may go*, which is a
 * fact about the boundary and not about the payload — so they are one type
 * carrying a phantom channel, and moving one across is a rename of its
 * constructor plus a move between two lists.
 *
 * **The phantom is what the first sketch was missing.** `action` and `output`
 * both returned `Schema.TaggedStruct<Tag, Fields>`, so with the same tag they were
 * *mutually assignable*: `actions: [OrderPlaced]` compiled, `outputs:
 * [CheckoutRequested]` compiled, and the two names were documentation the
 * compiler could not check. Nothing enforced the boundary except which array a
 * value happened to be typed into. Verified, not assumed.
 *
 * The brand is on the **vocabulary as well as the message**, and both halves
 * catch a different mistake: the message brand stops `Action.of([…, OrderPlaced])`,
 * the vocabulary brand stops `define({ actions: CartOutputs })`. Neither error can
 * be reached by the other, so a half-finished move fails rather than compiling
 * into the wrong channel.
 *
 * It also subsumes the old `NoLifecycleTags` backstop, which existed only because
 * a bare `Schema.TaggedStruct` could bypass `action` and land in the list
 * unchecked. There is now no unbranded way in, so the guard on the literal in
 * `make` is the only gate that has to exist.
 */
declare const channel: unique symbol;

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
 * What comes with it, and none of which the array of schemas had: `cases` keyed
 * by tag (the reducer's key set, flattened through nesting), `guards`, `match`,
 * `mapMembers`, a `make` constructor per case that fills `_tag`, and an encodable
 * schema for the whole vocabulary — which is the missing half of the devtools
 * transport.
 */
export type Vocabulary<
  Members extends ReadonlyArray<AnyMessage<Ch>>,
  Ch extends Channel,
> = Schema.toTaggedUnion<"_tag", Members> & { readonly [channel]: Ch };

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
 * One primitive, two channels — written once and instantiated twice, so the claim
 * that an output is *an action with an external destination* is a line of code
 * rather than a comment.
 *
 * `make` is the thin wrapper on `Schema.TaggedStruct` that everything else in
 * this file is built from; its only addition is the reserved-tag guard, which
 * lands on the string literal where the error reads best. `of` is
 * `Schema.Union(members).pipe(Schema.toTaggedUnion("_tag"))`, which takes messages
 * and vocabularies interchangeably and flattens the nested ones:
 *
 *     const Async = Action.of([Started, Failed])            // shared, its own module
 *     const CartActions = Action.of([Async, CheckoutRequested, CheckoutCompleted])
 *
 * The reducer for `CartActions` then requires all four keys. A record-of-fields
 * constructor was tried first and dropped here: it reads well and composes only
 * by object spread, which fakes reuse rather than expressing it — and a member
 * that needs `.check(…)`, or that is an existing schema, cannot be spelled at all.
 */
export interface Vocabularies<Ch extends Channel> {
  <const Tag extends Capitalize<string>, const Fields extends Schema.Struct.Fields>(
    tag: Tag & NotLifecycleTag<Tag>,
    fields: Fields,
  ): Message<Tag, Fields, Ch>;

  readonly of: <const Members extends ReadonlyArray<AnyMessage<Ch>>>(
    members: Members,
  ) => Vocabulary<Members, Ch>;
}

/** Handled here, never seen outside. */
export declare const Action: Vocabularies<"internal">;

/**
 * Announced, never handled here. An output has no reducer handler — its tag is
 * not in the reducer's key set — and it is not in `dispatch`'s union, so it cannot
 * be sent by hand: the structural trick `LifecycleTag` uses for inbound-only
 * lifecycle actions, run in the other direction.
 *
 * Delivered as one `on<Tag>` prop per output — see `OutputProps`.
 */
export declare const Output: Vocabularies<"outbound">;

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
 * reduces afterwards so the error lands on the argument rather than on the result.
 * Cross-property references are safe in this direction only — `Actions` is
 * inferred from its own property before this is checked — which is why `actions`
 * carries no disjointness guard and `outputs` carries it.
 *
 * Within one vocabulary the same check is Effect's and it is a runtime throw:
 * `toTaggedUnion` refuses a duplicate discriminant while walking members, which is
 * what keeps two nested vocabularies from quietly shadowing each other.
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
 * running since `Mounted`. Commands are already the channel for "things that leave
 * and come back at their own pace"; an announcement is one of those.
 */
export type Emit<A extends AnyVocabulary<"internal">, O extends AnyVocabulary<"outbound">> =
  | MemberOf<A>
  | MemberOf<O>;

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * **There is no lifetime option, and that is the design.**
 *
 * A blueprint's state is born at mount and discarded at unmount. Always. No
 * `retain`, no `key`, no registry of live machines — because every one of those is
 * a place state outlives the thing that owns it, and a place state outlives its
 * owner is a store with extra steps.
 *
 * NgRx ComponentStore states the rule this replaces, and it is a good one: *state
 * that must survive a URL change belongs to the app; state that must be cleaned up
 * on a URL change belongs to the component.* The version here is the same rule
 * with the escape hatch removed, so the answer to "but this needs to survive" is
 * forced to be structural rather than a flag:
 *
 *   - **Survives navigation** → it is a service's state, in `R`, with a Layer
 *     controlling its lifetime. The feature reads it in `Mounted` and writes to it
 *     in a command. This is also TCA's answer, arrived at from the other
 *     direction: shared data goes in the dependency graph, never in the state
 *     tree.
 *   - **Should reset** → change the React `key`. React already owns remounting; a
 *     second mechanism here could only disagree with it.
 *   - **Comes from the server** → it is a prop, and `initialState` projects it.
 *     Nothing async: an initial *fetch* is a `Mounted` command like any other.
 *
 * The cost is real and worth naming: a feature that unmounts loses in-flight work,
 * because closing the scope interrupts its fibers. That is the correct default —
 * it is the leak this design exists to prevent — but it means "keep uploading
 * after the user navigates away" is a service, not a feature.
 *
 * Someone hit this exact wall in XState production and wrote it down: *"when a
 * machine's primary responsibility is to manage the UI of a screen with lifecycle
 * tied to that of the UI, it needs to access an API cache that predates it and
 * lives on after it stops."* The answer above is better than XState's, but the
 * friction is documented and real.
 */
export type OwnershipRule = never;

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
 * only if the parent bothered to write an exhaustive one. With required per-output
 * props it is caught at the JSX call site, in every parent, whether or not anyone
 * was being careful — a missing prop is a missing prop. That is a strictly
 * stronger guarantee, and it is why these are **required rather than optional**:
 * an output is part of the interface, so a parent that does not care about one
 * should have to write `onThing={() => {}}` and be visibly ignoring it. Optional
 * would make announcing into the void the default, and a dropped output is
 * indistinguishable from a feature that never announced.
 *
 * `_tag` is stripped from the payload, since the prop name already carries it —
 * `onOrderPlaced={({ orderId }) => …}` rather than destructuring around a
 * discriminant nobody needs to read.
 *
 * Degrades to `{}` when a feature declares no outputs, so the split stays free for
 * leaf features.
 */
export type OutputProps<Output extends { readonly _tag: string }> = {
  readonly [K in Output["_tag"] as `on${K}`]: (
    payload: Omit<Extract<Output, { readonly _tag: K }>, "_tag">,
  ) => void;
};

/**
 * Derived prop names live in the same namespace as declared ones, so an output
 * called `Checkout` and a prop called `onCheckout` would collide — and the
 * collision would resolve to an intersection rather than an error, which is the
 * silent kind.
 *
 * Checked as an intersection at the declaration site, like every other guard here.
 * The error lands on `outputs`, which is the side that should move: a prop is the
 * parent's vocabulary and an output is this feature's, and renaming the one still
 * being designed is cheaper.
 */
export type NoPropCollision<
  PropsSchema extends AnyPropsSchema,
  O extends AnyVocabulary<"outbound">,
> = [Extract<keyof PropsOf<PropsSchema>, `on${TagsOf<O>}`>] extends [never] ? unknown : never;

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

/**
 * Exhaustive over the declared actions; lifecycle handlers stay optional; output
 * tags are absent from the key set, so writing a handler for one is a compile
 * error rather than a handler that silently never fires.
 *
 * Keyed off `cases` rather than off the union, which is a straight lookup where
 * the array form needed a distributive `Extract` per key — and which is also what
 * flattens a nested vocabulary into the key set for free.
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
 * `tea.ts`'s version, re-keyed. It has to be redefined here after all — not
 * because of a second list, which is what the query sketch would have cost, but
 * because the key set now comes from `cases` rather than from an array of
 * schemas. Same policies, same lifecycle keys, same `Unmounted` omission and the
 * same reason for it.
 */
export type Concurrency<A extends AnyVocabulary<"internal">, H extends AnyHooks> = {
  readonly [K in
    | TagsOf<A>
    | "Mounted"
    | "PropsChanged"
    | "Error"
    | `HookChanged_${keyof H & string}`]?: Policy;
};

export interface Blueprint<
  in Props,
  State,
  Action,
  Output,
  H extends AnyHooks = {},
  out R = never,
> {
  /** Unchanged from `tea.ts`, except that a command may now emit an output. */
  readonly reduce: (
    action: Action | LifecycleAction<Props, H>,
    snapshot: Snapshot<Props, State, H>,
  ) => Next<State, Action | Output, R>;

  /**
   * Fold a sequence, run each command against `layer`, feed what it emits back in,
   * and report what left.
   *
   * Here rather than in userland because it has to agree with the runtime about
   * `initialState`, concurrency policies, `Unmounted` discarding state, and which
   * tags re-enter versus leave. Hand-written in a test file it is a replica, and a
   * replica drifts — a test that passes against a divergent replica is worse than
   * no test. The honest way to ship it is to factor the runtime as a headless core
   * plus a React binding, at which point this is the core with a synchronous clock
   * rather than a second implementation.
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

export type Render<Props, State, Action, H extends AnyHooks> = (snapshot: {
  readonly state: State;
  readonly props: Props;
  readonly hooks: H;
  readonly initialState: State;
  /** The internal vocabulary. Outputs are not in here. */
  readonly dispatch: Dispatch<Action>;
}) => ReactNode;

export interface Definition<
  Props,
  State,
  A extends AnyVocabulary<"internal">,
  O extends AnyVocabulary<"outbound">,
  H extends AnyHooks,
> {
  readonly initialState: (initialState: (props: Props) => State) => (props: Props) => State;

  /**
   * `Exhaustive` is `tea.ts`'s and unchanged — the hole it closes is in the
   * handler return type, which the split does not touch. See it there for why the
   * compiler's own excess-property check cannot do this job.
   */
  readonly reducer: <U extends Reducer<Props, State, A, O, H, any>>(
    reducer: U & Exhaustive<U, State>,
  ) => U;

  readonly render: (
    render: Render<Props, State, MemberOf<A>, H>,
  ) => Render<Props, State, MemberOf<A>, H>;

  readonly create: <U extends Reducer<Props, State, A, O, H, any>>(parts: {
    readonly initialState: (props: Props) => State;

    /** Only the exceptions; anything unlisted is `"parallel"`. */
    readonly concurrency?: Concurrency<A, H>;

    readonly reducer: U & Exhaustive<U, State>;
    readonly render: Render<Props, State, MemberOf<A>, H>;
  }) => Blueprint<Props, State, MemberOf<A>, MemberOf<O>, H, ServicesOf<U>>;
}

/**
 * `outputs` defaults to the empty vocabulary, so a leaf feature declares nothing
 * and the surface is exactly `tea.ts`'s. That default matters more than it looks:
 * the split has to cost nothing until you need it, or every component grows an
 * empty declaration and the distinction stops carrying information.
 *
 * The two properties no longer carry a lifecycle-tag guard. They cannot receive an
 * unbranded value, so the only way in is `Action.make` / `Output.make`, and the
 * check is already spent on the literal there.
 */
export declare const define: <
  PropsSchema extends AnyPropsSchema,
  StateSchema extends AnyStateSchema,
  A extends AnyVocabulary<"internal">,
  O extends AnyVocabulary<"outbound"> = NoOutputs,
  H extends AnyHooks = {},
>(spec: {
  readonly props: PropsSchema & NoTransform<PropsSchema>;
  readonly state: StateSchema;

  readonly action: A;

  /** What this feature announces. Never handled here. */
  readonly output?: O & Disjoint<A, O> & NoPropCollision<PropsSchema, O>;

  readonly useHooks?: HookSpec<PropsOf<PropsSchema>, StateOf<StateSchema>, H>;
}) => Definition<PropsOf<PropsSchema>, StateOf<StateSchema>, A, O, H>;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * `instance` and `cause` are what turn a flat log into something usable once there
 * are N independent machines instead of one.
 *
 * Without `instance`, two `<Presence roomId="…">` are indistinguishable in the
 * stream, because `name` is a *blueprint* name. Without `cause`, order is all you
 * have — and in a decentralised architecture order tells you almost nothing while
 * causality tells you everything. `cause` is what renders
 * `cart#3/OrderPlaced → presence#1/RosterSynced` as an edge rather than as two
 * unrelated lines that happened to be adjacent.
 *
 * This is also the argument for outputs over a shared bus, restated as a data
 * structure: an output has a declared tag, a schema, and a known recipient, so the
 * edge is derivable. Bus traffic is opaque and the edge is not.
 *
 * Note what is *not* here: a `Query` variant. It was in the sketch, and cutting
 * queries removed it — which is the second-order reason they went. An externally
 * sent message has no origin the runtime can name, so the one variant that could
 * not be filled in was also the only one crossing a boundary inbound.
 */
export interface Event extends DevtoolsEvent {
  /** Which mount. */
  readonly instance: string;
  /** What caused this action, when the runtime knows. */
  readonly cause?:
    | { readonly _tag: "Dispatch" }
    | { readonly _tag: "Command"; readonly action: string }
    | { readonly _tag: "Output"; readonly from: string; readonly output: string };
}

export declare const createRuntime: <RootR, RootE>(
  layer: Layer.Layer<RootR, RootE>,
  options?: { readonly onEvent?: (event: Event) => void },
) => {
  readonly Provider: FC<{ readonly children?: ReactNode }>;

  /**
   * The `on<Tag>` handlers are added by the runtime rather than declared in the
   * props schema, because their types are derived from `outputs` and repeating
   * them per feature would let the two drift.
   *
   * They have to be stripped before the props schema runs. The check uses
   * `onExcessProperty: "error"`, so leaving them in would make every feature with
   * an output fail validation on its own mount. Stripping is by derived name and
   * not by an `on*` prefix rule: a declared prop may legitimately be called
   * `onScroll`, and `NoPropCollision` is what guarantees the two sets are disjoint
   * so the runtime can strip exactly `outputs.map(o => "on" + tag)` and leave
   * everything else for the schema to check.
   */
  readonly component: {
    <Props, State, Action, Output, H extends AnyHooks, R extends RootR>(
      blueprint: Blueprint<Props, State, Action, Output, H, R>,
      options?: { readonly name?: string },
    ): FC<Props & OutputProps<Output & { readonly _tag: string }>>;

    /** A feature may bring its own layer; the root must cover the residue. */
    <Props, State, Action, Output, H extends AnyHooks, R, LayerError>(
      blueprint: Blueprint<Props, State, Action, Output, H, R>,
      options: {
        readonly layer: Layer.Layer<Exclude<R, RootR>, LayerError, RootR>;
        readonly name?: string;
      },
    ): FC<Props & OutputProps<Output & { readonly _tag: string }>>;
  };

  readonly useRuntime: () => ManagedRuntime.ManagedRuntime<RootR, RootE>;
};

// ---------------------------------------------------------------------------
// Unchanged
// ---------------------------------------------------------------------------

export type { Command, Snapshot, Next, LifecycleAction };
export type Unused = Stream.Stream<never>;
