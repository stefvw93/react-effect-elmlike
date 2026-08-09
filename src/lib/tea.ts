/**
 * `useReducer`, grown up: state, actions, a pure reducer, a pure render — with
 * every side effect moved into a *value* the reducer returns, and a declared
 * boundary around the whole thing.
 *
 * TYPE SURFACE ONLY — every value here is `declare`d. Nothing runs.
 *
 * The shape, in one breath:
 *
 *   - A blueprint is a `State`, a *vocabulary* of `Action`s, a pure `reducer`,
 *     and a pure `render`. It mounts as a plain `FC<Props>`, so it drops into
 *     any React tree and can be adopted one component at a time.
 *   - State changes are synchronous. Every effect lives in a command.
 *   - Commands are `Stream<Action, never, R>` — they produce *actions, never
 *     state*, and they *cannot fail*. Converting an `E` into an action is
 *     userland work, done with Effect's own combinators.
 *   - Props and React hooks are *ambient inputs*: readable everywhere, never
 *     mirrored into state. They reach state only as actions, through the same
 *     `reducer` as everything else.
 *   - Props are a schema as well, and are **validated at the boundary**. A
 *     missing, mistyped or *excess* prop is a defect and throws. TypeScript
 *     cannot check excess properties through `{...spread}`, so this is the only
 *     layer that can.
 *   - `R` is declared per blueprint and discharged by a Layer at the root, so
 *     dependency injection is checked at compile time.
 *
 * The architecture is Elm's; the vocabulary is React's. `_tag` rather than
 * `type` is the one concession in the other direction — it is what Effect's
 * `Schema` and every `catchTag`-shaped combinator already speak, and you are
 * using Effect here anyway.
 *
 * ---------------------------------------------------------------------------
 *
 * **Two vocabularies, not one**, and that is the other half of the design.
 *
 * One list of actions does two unrelated jobs. `CheckoutAdvanced` is a thing a
 * command observed. `CheckoutCompleted` is a thing the *parent* needs to know
 * about. Only the second is anyone else's business, and if nothing distinguishes
 * them then the moment a store or a `useDispatch` exists the whole vocabulary is
 * public and ownership is gone. That is `useSelector` erosion, and it arrives
 * through the action list rather than through the state.
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
 * purpose, and the reason is that React's is empty too: there is no parent →
 * child discrete channel in React outside of refs, and reaching for one is how
 * you get the `pendingCommand`-prop anti-pattern. What a ref-with-methods
 * actually bought was worse than it looked:
 *
 *   - `ref.current?.send(…)` makes "not mounted yet" a silent no-op;
 *   - nothing typed says a query may not be sent during render;
 *   - ordering against `Mounted` was undefined;
 *   - and worst, a query had no traceable origin, so `cause` — the whole point
 *     of the devtools story in `DevtoolsEvent` — would have had nothing to
 *     record but "outside".
 *
 * Halogen does not have those problems because a parent there never holds a
 * handle: it renders a child into a labelled *slot* and queries it by address
 * from inside its own reducer, so issuance is a returned value like everything
 * else. Porting that needs the runtime to track child slots, which is a real
 * build and not a type-level sketch. Until it exists, a parent that must trigger
 * a feature should own the trigger: move the button inside the feature's
 * `render`, and portal it if the DOM layout demands it.
 *
 * What is left is one sentence: **React, with callback props turned into
 * values.** That is the same move commands already make for effects, applied to
 * the outbound direction — and it is what removed the last escape hatch from the
 * props schema, so a devtools event no longer lies about its props.
 *
 * The rest of what the split buys:
 *
 *   - **A bus is unnecessary for the hierarchical case.** Two features under a
 *     common parent talk through outputs and props, which is React's own answer
 *     and stays visible in the tree. A shared service is then only for coupling
 *     that genuinely is not hierarchical — and needing one constantly becomes
 *     evidence the boundaries are wrong rather than a fact of life.
 *   - **Cross-feature causality becomes typed and loggable.** Outputs are
 *     schemas, so a transport sees `cart#3/OrderPlaced → presence#1/RosterSynced`
 *     as an edge. Bus traffic is opaque by construction.
 *   - **A store, if one is ever added, is no longer a boundary hole.** The
 *     subtree gets `dispatch` over the internal vocabulary — which it is
 *     entitled to, being inside the feature — and the outside world gets nothing
 *     but props in and outputs back.
 */

import type { FC, ReactNode } from "react";
import type { Cause, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";

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
// The two vocabularies
// ---------------------------------------------------------------------------

/**
 * The tags the runtime raises, reserved so a declared action cannot take one.
 *
 * This is what pays for the lifecycle actions having no sigil. They live in the
 * same namespace as yours now, so the namespace is policed rather than dodged —
 * and policing it is also what keeps them *inbound-only*, since `dispatch`
 * accepts only declared actions and `Mounted` can never be one.
 *
 * The hook variant is a prefix rather than a list, so the check needs to know
 * nothing about `H`: it reserves `HookChanged_*` whatever the hooks turn out to
 * be, which is a stronger guarantee than enumerating today's keys.
 */
export type LifecycleTag =
  | "Mounted"
  | "PropsChanged"
  | "Error"
  | "Unmounted"
  | `HookChanged_${string}`;

/** Guard for one tag, at `Action`. See `define` for why it is an intersection. */
export type NotLifecycleTag<Tag extends string> = Tag extends LifecycleTag ? never : unknown;

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
 * What comes with it, and none of which an array of schemas had: `cases` keyed
 * by tag (the reducer's key set, flattened through nesting), `guards`, `match`,
 * `mapMembers`, a `make` constructor per case that fills `_tag`, and an
 * encodable schema for the whole vocabulary — which is the missing half of the
 * devtools transport.
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
 * One primitive, two channels — written once and instantiated twice, so the
 * claim that an output is *an action with an external destination* is a line of
 * code rather than a comment.
 *
 * The call signature is the thin wrapper on `Schema.TaggedStruct` that
 * everything else in this file is built from; its only addition is the
 * reserved-tag guard, which lands on the string literal where the error reads
 * best. `of` is `Schema.Union(members).pipe(Schema.toTaggedUnion("_tag"))`,
 * which takes messages and vocabularies interchangeably and flattens the nested
 * ones:
 *
 *     const Async = Action.of([Started, Failed])            // shared, its own module
 *     const CartActions = Action.of([Async, CheckoutRequested, CheckoutCompleted])
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
 * not in the reducer's key set — and it is not in `dispatch`'s union, so it
 * cannot be sent by hand: the structural trick `LifecycleTag` uses for
 * inbound-only lifecycle actions, run in the other direction.
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
type ServiceOf<T> = T extends readonly [any, Stream.Stream<any, any, infer R>] ? R : never;

export type ServicesOf<U> = {
  [K in keyof U]: ServiceOf<ReturnType<Extract<U[K], (...args: any) => any>>>;
}[keyof U];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * A command: the async work a state change kicks off.
 *
 * Like the body of a `useEffect`, except you *return* it instead of running it
 * — so there is no dependency array, no cleanup function to keep in sync, and
 * the runtime owns its lifetime. Note the `never`: **commands cannot fail.**
 *
 * What is excluded here is *renames*. There is deliberately no
 * `attempt`/`perform`, because Effect already has them under better names:
 *
 *   - `Effect.match`  — two branches, two specific actions. (Elm's `attempt`.)
 *   - `Effect.result` — one action carrying a `Result<A, E>`.
 *   - `Stream.catchTag` — for a *stream* command, where collapsing to a
 *     `Result` would destroy the progressive emission that is the point.
 *
 * Batching is `Stream.merge`. Progressive emission over one scope is
 * `Stream.callback`. Neither needs wrapping either.
 *
 * *Compositions* are a different matter, and `effect` below is one: it names a
 * two-combinator idiom that every fire-and-forget command would otherwise spell
 * out by hand.
 */
export type Command<Action, R = never> = Stream.Stream<Action, never, R>;

export declare const Command: {
  /** An explicit no-op, for when a bare `state` return reads worse. */
  readonly none: Command<never>;

  /**
   * Run an effect for its effects; emit no action. `Stream.drain` of a
   * `Stream.fromEffect`.
   *
   * `unknown` rather than `void` in the success channel, so an effect that
   * happens to return something needs no `Effect.asVoid` at the call site;
   * `never` in the error channel because commands cannot fail. The result is
   * assignable wherever a `Command<Action, R>` is wanted — `Stream` is
   * covariant in what it emits, and this one emits nothing.
   */
  readonly effect: <R>(effect: Effect.Effect<unknown, never, R>) => Command<never, R>;
};

/**
 * What happens when an action issues a command while an earlier command from
 * *the same action* is still running.
 *
 * Commands are grouped by the tag of the action that issued them, so there is
 * no key to invent and nothing to wrap — a command stays a plain `Stream`. If
 * an action is absent here it is `"parallel"`, which is Elm's only behaviour.
 *
 * To share a group, have one handler dispatch the other's action rather than
 * duplicating its command. That is usually what you meant anyway.
 */
export type Policy =
  /** Interrupt the one in flight and start this one. Typeahead. */
  | "restart"
  /** Keep the one in flight and discard this one. Submit buttons. */
  | "ignore"
  /** Start when the one in flight finishes. */
  | "queue"
  /** Let them race. The default. */
  | "parallel";

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
export declare const Next: {
  readonly state: <State>(next: Next<State, any, any>) => State;
  readonly command: <State, Action, R>(
    next: Next<State, Action, R>,
  ) => Command<Action, R> | undefined;
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
 * `HookChanged_…`, which can change state again. That is the same footgun as a
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
 * One variant per hook key, and the tag *names* the hook.
 *
 * So a hook change is handled by its own entry in `reducer` rather than by one
 * handler switching over every hook: narrowing becomes ordinary per-handler
 * typing, and a hook you do not react to is a key you leave out instead of a
 * `return state` branch written to satisfy exhaustiveness.
 *
 * `& string` because a template literal needs one — and it is also what makes
 * this correctly produce nothing when a component declares no hooks at all.
 */
export type HookChanged<H extends AnyHooks> = {
  [K in keyof H & string]: {
    readonly _tag: `HookChanged_${K}`;
    readonly previous: H[K];
  };
}[keyof H & string];

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
 * The fixed lifecycle keys. `HookChanged_*` is generated per hook and lives in
 * `LifecycleHandlers` below.
 */
interface FixedLifecycleHandlers<Props, State, Action, H extends AnyHooks, R = never> {
  /** Fires once, after the initial state exists. Where startup commands live. */
  readonly Mounted?: LifecycleHandler<"Mounted", Props, State, Action, H, R>;

  /**
   * Props are a fresh object every render, so this fires constantly. That is
   * fine: returning the *same state reference* is the no-op. It puts the "did
   * anything I care about change" decision in `reducer`, where it can see the
   * state.
   *
   * Whole-object, deliberately, where a hook change is per key: hooks are a
   * short hand-written record of independently tracked values, while props are
   * one object behind a schema that can be wide — and a handler per prop field
   * would multiply reducer runs to say what one comparison already says.
   */
  readonly PropsChanged?: LifecycleHandler<"PropsChanged", Props, State, Action, H, R>;

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
 *
 * Every entry being optional means a mistyped key is a handler that silently
 * never fires. `noImplicitAny` covers this in practice rather than by design:
 * an unrecognised key gets no contextual type, so `HookChanged_online: (action,
 * {state}) => …` fails on both parameters. Excess-property checking is *not*
 * what catches it — that does not fire through `U extends Reducer<…>`, which is
 * also why `Exhaustive` has to exist — so the one spelling that stays silent is
 * a handler which ignores both parameters:
 *
 *     HookChanged_online: () => ({ ...someState })   // accepted, never called
 *
 * Verified, not assumed. Worth knowing because the hook keys are spelled from
 * whatever you named the hook, so they are the ones a rename can strand.
 */
export type LifecycleHandlers<
  Props,
  State,
  Action,
  H extends AnyHooks,
  R = never,
> = FixedLifecycleHandlers<Props, State, Action, H, R> & {
  readonly [K in keyof H & string as `HookChanged_${K}`]?: LifecycleHandler<
    `HookChanged_${K}`,
    Props,
    State,
    Action,
    H,
    R
  >;
};

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
   * mounted component. Unhandled lifecycle actions return the state unchanged.
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
 *       output: Output.of([OrderPlaced]),
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
export declare const define: <
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
}) => Definition<PropsOf<PropsSchema>, StateOf<StateSchema>, A, O, H>;

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
