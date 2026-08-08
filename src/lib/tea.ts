/**
 * `useReducer`, grown up: state, actions, a pure reducer, a pure render — with
 * every side effect moved into a *value* the reducer returns.
 *
 * TYPE SURFACE ONLY — every value here is `declare`d. Nothing runs.
 *
 * The shape, in one breath:
 *
 *   - A blueprint is a `State`, a list of `Action`s, a pure `reducer`, and a
 *     pure `render`. It mounts as a plain `FC<Props>`, so it drops into any
 *     React tree and can be adopted one component at a time.
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
 */

import type { FC, ReactNode } from "react";
import {
  Schema,
  type Cause,
  type Effect,
  type Layer,
  type ManagedRuntime,
  type Stream,
} from "effect";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Actions are declared as an *array* of tagged schemas.
 *
 * This is load-bearing, not decoration. `reducer` is a mapped type keyed by
 * `Action["_tag"]`, and a mapped type is not an inference site — so `Action`
 * can never be recovered from `reducer`. It collapses to `{_tag: string}` and
 * every handler parameter becomes `never`. Declaring the list restores full
 * inference, and `define` then needs no explicit type arguments at all.
 *
 * Schemas rather than plain unions because it costs nothing here and buys
 * encode/decode for free — which is what makes the devtools action stream in
 * `createRuntime` serialisable.
 */
export type AnyActionSchema = Schema.TaggedStruct<Capitalize<string>, any>;

export type ActionOf<Actions extends ReadonlyArray<AnyActionSchema>> = Actions[number]["Type"];

export type ActionSchema<
  Tag extends Capitalize<string>,
  Fields extends Schema.Struct.Fields,
> = Schema.TaggedStruct<Tag, Fields>;

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

/** Guard for one tag, at `action`. See `define` for why it is an intersection. */
export type NotLifecycleTag<Tag extends string> = Tag extends LifecycleTag ? never : unknown;

/** The same guard over a declared list, for schemas that bypass `action`. */
export type NoLifecycleTags<Actions extends ReadonlyArray<AnyActionSchema>> = [
  Extract<ActionOf<Actions>["_tag"], LifecycleTag>,
] extends [never]
  ? unknown
  : never;

export const action = <
  const Tag extends Capitalize<string>,
  const Fields extends Schema.Struct.Fields,
>(
  tag: Tag & NotLifecycleTag<Tag>,
  fields: Fields,
): ActionSchema<Tag, Fields> => Schema.TaggedStruct(tag as Tag, fields);

/**
 * State is a schema too, for the same reasons as the actions: it is the other
 * half of what a devtools transport, a replay log, or session hydration needs
 * to encode. It also means `State` arrives from a *value*, so nothing about it
 * has to be inferred out of `initialState`'s return type.
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
 * per-field optionality, nested schemas and `callback` fields survive as before,
 * and so does a `.check(…)` refinement on the whole props object — `check`
 * rebuilds to `Struct`.
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
 * during a render that is happening anyway. Transformation belongs in `hooks`,
 * on both counts.
 */
export type NoTransform<P extends AnyPropsSchema> = [P["Encoded"]] extends [P["Type"]]
  ? [P["Type"]] extends [P["Encoded"]]
    ? unknown
    : never
  : never;

/**
 * The annotation both helpers below attach, and the only thing that makes a
 * props object serialisable after the fact.
 *
 * Encoding a props schema is *identity* — `Schema.declare` has `Encoded =
 * Type`, and it must, because the validation pass is a decode. So a function
 * prop survives encoding as a live reference, and what happens next depends
 * entirely on the transport: `JSON.stringify` drops the key with no error,
 * which reads as "the parent never passed it"; `structuredClone` — and so
 * `postMessage` to any devtools panel, iframe or worker — throws outright.
 *
 * Neither failure is recoverable from the value alone: given a props object,
 * nothing tells you which fields were *meant* to be opaque. The annotation is
 * that record. A serialiser walks `PropsSchema.fields`, finds the entries whose
 * `ast._tag` is `"Declaration"`, and substitutes a placeholder.
 *
 * The placeholder can say more than the type ever could, because `name` on a
 * function reaching a prop is inferred from the *call site*: `onCheckout={fn}`
 * reports `"fn"` — which handler, not merely that there was one. Pair it with
 * the first line of `toString()` to identify inline arrows, truncated, and
 * behind a dev flag since it exposes source text.
 *
 * Not `length`: it counts leading parameters up to the first default or rest,
 * so `(...args) => {}` reports 0 and `(a, b = 1) => {}` reports 1. Beside a
 * prop declared `(orderId: string) => void` that reads as a mismatch when
 * nothing is wrong. A signature cannot be checked at runtime — which is the
 * whole reason `callback` exists — and a number that looks like it might be
 * checking one is worse than no number.
 *
 * Optional fields need unwrapping: `Schema.optional(callback<F>())` is a
 * `Union` of `[Declaration, Undefined]`, so the annotation sits on the member,
 * not on the field.
 */
export type OpaqueAnnotation = { readonly tea: "callback" | "opaque" };

/**
 * A function prop. Checked as `typeof === "function"` — the only thing any
 * runtime can check about a function — while the type argument carries the
 * full signature.
 */
export declare const callback: <F extends (...args: never[]) => unknown>() => Schema.declare<F>;

/**
 * A React value with no runtime contract worth stating: `ReactNode`, an
 * element, a ref, a foreign store's handle. Type-only; the guard always passes.
 *
 * Serialisation matters here for the opposite reason to `callback`: a React
 * element is a live object graph whose `$$typeof` symbol `JSON.stringify`
 * silently drops, so what survives is a plausible object that is not the
 * element. Failing loudly would be better; the annotation is what lets a
 * serialiser do that.
 */
export declare const opaque: <T>() => Schema.declare<T>;

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
 * `Unmounted` is absent on purpose. Its command is forked on the root scope and
 * deliberately *not* tracked in the group map — the component that would own the
 * group is already gone — so a policy here would be a lie rather than a setting.
 */
export type Concurrency<Actions extends ReadonlyArray<AnyActionSchema>, H extends AnyHooks> = {
  readonly [K in
    | ActionOf<Actions>["_tag"]
    | "Mounted"
    | "PropsChanged"
    | "Error"
    | `HookChanged_${keyof H & string}`]?: Policy;
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
 *     hooks: function useCartHooks(props, state) {
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

  /**
   * What `initialState` produced for the current props, computed once and
   * reused.
   *
   * Here so that "reset to empty" is `({ initialState }) => initialState`
   * rather than a module-level constant shared between `initialState` and half
   * the handlers — which is both a second source of truth and eagerly built at
   * import time.
   */
  readonly initialState: State;
}

export type Dispatch<Action> = (action: Action) => void;

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
    readonly next: H[K];
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
      readonly next: Props;
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
   * scope: an unmount command takes the same path as any other command and
   * differs only in not being tracked in the concurrency group map. It therefore
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
 * They stay inbound-only: they are not in the declared action list, so
 * `dispatch` will not accept them and nobody can synthesise a prop change. What
 * used to be a sigil keeping them out of your namespace is now `LifecycleTag`
 * keeping you out of theirs — the same guarantee, checked rather than dodged.
 *
 * Every entry being optional means a mistyped key is a handler that silently
 * never fires. `noImplicitAny` covers this in practice rather than by design:
 * an unrecognised key gets no contextual type, so `HookChanged_online: (action,
 * {state}) => …` fails on both parameters. Excess-property checking is *not*
 * what catches it — that does not fire through `U extends Reducer<…>` — so the
 * one spelling that stays silent is a handler which ignores both parameters:
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
 * the constraint is enough to type `action` and `state`, and not enough to reject
 * a key that is not in the state. Annotating each handler restores it, but that
 * is discipline rather than enforcement, and the annotation is the thing `define`
 * exists to avoid writing.
 *
 * What does survive is the key itself: `lmao` is in `U`'s inferred handler return
 * type, so the excess is recoverable from `U` once the argument has been
 * inferred. This maps over the handlers and lands a string-literal type on the
 * offending key, so the error names both the handler and the property.
 *
 * Intersected onto the parameter like every other guard in this codebase — bare
 * `U` is the inference site and the intersection reduces afterwards, so the error
 * lands on the argument rather than on the result.
 */
export type StatePart<N> = N extends readonly [infer S, unknown] ? S : N;

export type Excess<N, State> = N extends unknown ? Exclude<keyof StatePart<N>, keyof State> : never;

export type Exhaustive<U, State> = {
  readonly [K in keyof U]: U[K] extends (...args: never) => infer N
    ? [Excess<N, State>] extends [never]
      ? unknown
      : `Next<State> with excess property '${Excess<N, State> & string}'`
    : unknown;
};

/** Exhaustive over the declared actions; lifecycle handlers are optional. */
export type Reducer<
  Props,
  State,
  Actions extends ReadonlyArray<AnyActionSchema>,
  H extends AnyHooks,
  R = never,
> = {
  readonly [K in ActionOf<Actions>["_tag"]]: (
    action: Extract<ActionOf<Actions>, { readonly _tag: K }>,
    snapshot: Snapshot<Props, State, H>,
  ) => Next<State, ActionOf<Actions>, R>;
} & LifecycleHandlers<Props, State, ActionOf<Actions>, H, R>;

/**
 * A component's behaviour, before it is wired to a runtime. `component` turns
 * one into an `FC<Props>`; until then it is an inert value you can unit-test.
 */
export interface Blueprint<in Props, State, Action, H extends AnyHooks = {}, out R = never> {
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
  ) => Next<State, Action, R>;
}

// ---------------------------------------------------------------------------
// Defining a component
// ---------------------------------------------------------------------------

/**
 * What `define` hands back: the four pieces of a blueprint, each already bound
 * to this component's `Props`, `State`, actions and hooks.
 *
 * `initialState`, `reducer` and `render` are identity functions at runtime.
 * They exist only to *supply* those types, which is what makes a piece
 * writable on its own — in its own file, with no annotation and no
 * `satisfies SomethingComplex`. Passing the pieces inline to `create` works
 * exactly as well; use whichever suits the component's size.
 */
export interface Definition<
  Props,
  State,
  Actions extends ReadonlyArray<AnyActionSchema>,
  H extends AnyHooks,
> {
  readonly initialState: (initialState: (props: Props) => State) => (props: Props) => State;

  readonly reducer: <U extends Reducer<Props, State, Actions, H, any>>(
    reducer: U & Exhaustive<U, State>,
  ) => U;

  readonly render: (
    render: Render<Props, State, ActionOf<Actions>, H>,
  ) => Render<Props, State, ActionOf<Actions>, H>;

  readonly create: <U extends Reducer<Props, State, Actions, H, any>>(parts: {
    /** A pure projection of props, evaluated lazily on mount. Startup
     *  *commands* belong to `Mounted`; this is only the value. */
    readonly initialState: (props: Props) => State;

    /** Only the exceptions; anything unlisted is `"parallel"`. */
    readonly concurrency?: Concurrency<Actions, H>;

    readonly reducer: U & Exhaustive<U, State>;
    readonly render: Render<Props, State, ActionOf<Actions>, H>;
  }) => Blueprint<Props, State, ActionOf<Actions>, H, ServicesOf<U>>;
}

/**
 * Declare what a component is made of, then build it.
 *
 * Every piece arrives from a *value*, so there are no explicit type arguments
 * at all — `Props`, `State`, the actions and the hooks are inferred from one
 * object literal.
 *
 *     const Cart = define({ props: Props, state: State, actions: [...], hooks: {...} })
 *
 *     export const cart = Cart.create({ initialState, reducer, render })
 *
 * `props` is validated on mount and whenever the props object identity changes
 * — which is every render driven by an ancestor, and no render driven by this
 * component's own state, because React hands back the identical props object
 * then. A failure throws into the nearest React error boundary rather than
 * being reported: a malformed prop is the *parent's* defect, and a handler here
 * could only swallow it.
 *
 * The check runs with `onExcessProperty: "error"` and `errors: "all"`, so one
 * bad spread reports every problem at once instead of one per debugging round.
 * It costs single-digit microseconds for a typical component. Two things make
 * it more expensive, neither of which matters at component granularity and both
 * of which matter if you make a blueprint out of a list row: array-valued props
 * scale linearly with length, and optional fields cost roughly 2.5× required
 * ones. Prefer `Schema.optional` anyway — `Schema.optionalKey` is the cheap one
 * but rejects `prop={undefined}`, which ordinary React produces constantly.
 */
export declare const define: <
  PropsSchema extends AnyPropsSchema,
  StateSchema extends AnyStateSchema,
  const Actions extends ReadonlyArray<AnyActionSchema>,
  H extends AnyHooks = {},
>(spec: {
  /**
   * The intersection is load-bearing, and both halves are doing different work.
   *
   * `PropsSchema` bare is the *inference site*. A conditional type is a
   * non-inferrable position, so `NoTransform<PropsSchema>` on its own would
   * leave nothing to infer from and `PropsSchema` would fall back to its
   * constraint — props would become an anonymous record of `unknown`
   * throughout `hooks`, `reducer` and `render`. The guard would go with it:
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
   * Same intersection, same two jobs, for the same reason — and here it is the
   * backstop rather than the main gate. `action` rejects a reserved tag at the
   * string literal itself, which is where the error reads best; this catches a
   * bare `Schema.TaggedStruct` that never went through `action`.
   *
   * `AnyActionSchema` cannot carry the constraint on its own: its tag parameter
   * is `Capitalize<string>`, and there is no literal there to exclude against.
   * The check has to sit wherever a tag is actually known, which is these two
   * places and nowhere else.
   */
  readonly actions: Actions & NoLifecycleTags<Actions>;
  readonly useHooks?: HookSpec<PropsOf<PropsSchema>, StateOf<StateSchema>, H>;
}) => Definition<PropsOf<PropsSchema>, StateOf<StateSchema>, Actions, H>;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Emitted for every state change in every mounted component. Loosely typed on
 * purpose — a root observer sees components it knows nothing about. Because
 * actions and state are schemas, they can be encoded from here for a devtools
 * transport or a replay log.
 *
 * **Props are the exception, and `JSON.stringify` on this event will lie about
 * them.** Encoding a props schema is identity, so a `callback` field arrives
 * here as a live function: JSON drops the key without complaint, and
 * `structuredClone` — every `postMessage` transport — throws. Anything shipping
 * these events off-thread needs a schema-aware serialiser that walks
 * `PropsSchema.fields` and substitutes a placeholder for the entries carrying
 * an `OpaqueAnnotation`. Only `PropsChanged` is affected; `action`, `previous`
 * and `next` encode cleanly.
 */
export interface DevtoolsEvent {
  readonly name: string;
  readonly action: unknown;
  readonly previous: unknown;
  readonly next: unknown;
}

export interface RuntimeOptions {
  readonly onAction?: (event: DevtoolsEvent) => void;
}

/**
 * The runtime is a root provider, in the shape everyone knows from Redux and
 * Apollo — one `ManagedRuntime`, layers memoised once, services shared across
 * every component. One line in `main.tsx`, so incremental adoption survives.
 *
 * The catch a bare `<Provider>` would hit: React context is untyped with
 * respect to what it holds, so `useContext` would throw away the compile-time
 * DI guarantee that was the point of tracking `R` at all. Hence a factory —
 * `component` is closed over the root's `R`, so building a component that needs
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

  readonly component: {
    <Props, State, Action, H extends AnyHooks, R extends RootR>(
      blueprint: Blueprint<Props, State, Action, H, R>,
      options?: { readonly name?: string },
    ): FC<Props>;

    /** A component may bring its own layer; the root must cover the residue. */
    <Props, State, Action, H extends AnyHooks, R, LayerError>(
      blueprint: Blueprint<Props, State, Action, H, R>,
      options: {
        readonly layer: Layer.Layer<Exclude<R, RootR>, LayerError, RootR>;
        readonly name?: string;
      },
    ): FC<Props>;
  };

  /**
   * Escape hatch for ordinary React components that are not blueprints. Keeps
   * incremental adoption honest: plain components can still reach the same
   * services without being rewritten.
   */
  readonly useRuntime: () => ManagedRuntime.ManagedRuntime<RootR, RootE>;
};
