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
} from "effect";
import {
  Devtools,
  noopDevtools,
  summarizeCommand,
  summarizeDefect,
  type DevtoolsCause,
  type DevtoolsEvent,
  type DevtoolsSink,
} from "./devtools";

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Collapse a type to a flat object literal, for hovers.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The tags the runtime raises, reserved so a declared action cannot take one.
 */
export type LifecycleTag = "Mounted" | "PropsChanged" | "Error" | "Unmounted" | "HookChanged";

/** Guard for one tag, at `Action`. */
export type NotLifecycleTag<Tag extends string> = Tag extends LifecycleTag ? never : unknown;

/**
 * The runtime counterpart of `LifecycleTag`, kept exhaustive by the compiler:
 * a `Record` literal missing (or misspelling) a key fails to satisfy the
 * `Record<LifecycleTag, true>` annotation.
 */
const LifecycleTags: Record<LifecycleTag, true> = {
  Mounted: true,
  PropsChanged: true,
  Error: true,
  Unmounted: true,
  HookChanged: true,
};

/**
 * Checks if a tag is a lifecycle tag.
 */
const isLifecycleTag = (tag: string): tag is LifecycleTag => Object.hasOwn(LifecycleTags, tag);

const handlerFor = <Handler>(handlers: Record<string, Handler>, tag: string): Handler | undefined =>
  Object.hasOwn(handlers, tag) ? handlers[tag] : undefined;

const channel: unique symbol = Symbol("@tea/channel");
export type Channel = "internal" | "outbound";

export type Message<
  Tag extends Capitalize<string>,
  Fields extends Schema.Struct.Fields,
  Ch extends Channel,
> = Schema.TaggedStruct<Tag, Fields> & { readonly [channel]: Ch };

export type AnyMessage<Ch extends Channel> = Schema.Codec<any, any> & {
  readonly Type: { readonly _tag: string };
  readonly [channel]: Ch;
};

/**
 * Tagged union, branded with channel.
 */
export type Vocabulary<
  Members extends ReadonlyArray<AnyMessage<Channel>>,
  Ch extends Channel,
> = Schema.toTaggedUnion<"_tag", Members> & { readonly [channel]: Ch };

/**
 * The channel a member list belongs to, read off the members' own brand.
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
 */
export type SameChannel<Members extends ReadonlyArray<AnyMessage<Channel>>> =
  Members extends ReadonlyArray<AnyMessage<"internal">>
    ? unknown
    : Members extends ReadonlyArray<AnyMessage<"outbound">>
      ? unknown
      : never;

/**
 * The constraint everything downstream is written against.
 */
export type AnyVocabulary<Ch extends Channel> = {
  readonly [channel]: Ch;
  readonly cases: Record<string, { readonly Type: { readonly _tag: string } }>;
  readonly Type: { readonly _tag: string };
};

export type TagsOf<V extends AnyVocabulary<Channel>> = keyof V["cases"] & string;

export type MemberOf<V extends AnyVocabulary<Channel>> = V["Type"];

export interface MessageConstructor<Ch extends Channel> {
  <const Tag extends Capitalize<string>, const Fields extends Schema.Struct.Fields>(
    tag: Tag & NotLifecycleTag<Tag>,
    fields: Fields,
  ): Message<Tag, Fields, Ch>;
}

export interface Vocabularies extends MessageConstructor<"internal"> {
  /**
   * Announced, never handled here. An output has no reducer handler. Its tag is
   * not in the reducer's key set, and it is not in `dispatch`'s union, so it
   * cannot be sent by hand.
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
export const Action = Object.assign(messages("internal"), {
  output: messages("outbound"),
  of: (members: ReadonlyArray<AnyMessage<Channel>>) =>
    Object.assign(Schema.Union(members).pipe(Schema.toTaggedUnion("_tag")), {
      [channel]: members[0]?.[channel],
    }),
}) as Vocabularies;

/** The empty vocabulary, so a leaf feature declares nothing. `Type` is `never`. */
export type NoOutputs = Vocabulary<readonly [], "outbound">;

export type Disjoint<A extends AnyVocabulary<"internal">, O extends AnyVocabulary<"outbound">> = [
  Extract<TagsOf<A>, TagsOf<O>>,
] extends [never]
  ? unknown
  : never;

/**
 * What a command may emit.
 */
export type Emit<A extends AnyVocabulary<"internal">, O extends AnyVocabulary<"outbound">> =
  | MemberOf<A>
  | MemberOf<O>;

export type AnyStateSchema = Schema.Struct<any>;

export type StateOf<S extends AnyStateSchema> = S["Type"];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type AnyPropsSchema = Schema.Struct<Schema.Struct.Fields>;

export type PropsOf<P extends AnyPropsSchema> = P["Type"];

/**
 * Props are **validated, never decoded**: `Encoded` must equal `Type`, so
 * `props.x` is always exactly what the parent passed. A transforming props
 * schema is a compile error.
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
 * `_tag` is stripped from the payload, since the prop name already carries it —
 * `onOrderPlaced={({ orderId }) => …}` rather than destructuring around a
 * discriminant nobody needs to read.
 *
 * Degrades to `{}` when a feature declares no outputs.
 */
export type OutputProps<Output extends { readonly _tag: string }> = {
  readonly [K in Output["_tag"] as `on${K}`]: (
    payload: Simplify<Omit<Extract<Output, { readonly _tag: K }>, "_tag">>,
  ) => void;
};

export type NoPropCollision<
  PropsSchema extends AnyPropsSchema,
  O extends AnyVocabulary<"outbound">,
> = [Extract<keyof PropsOf<PropsSchema>, `on${TagsOf<O>}`>] extends [never] ? unknown : never;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

type ServiceOf<T> = T extends readonly [any, Command<any, infer R>] ? R : never;

export type ServicesOf<U> = {
  [K in keyof U]: ServiceOf<ReturnType<Extract<U[K], (...args: any) => any>>>;
}[keyof U];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Where a command's emissions go.
 */
export type Dispatcher<A> = (action: A) => Effect.Effect<void>;

/**
 * The async work a state change kicks off.
 */
export type Command<A, R = never> = Pipeable.Pipeable &
  /** Explicit no-op, for when a bare `state` return reads worse. */
  (
    | { readonly _tag: "None" }

    /**
     * The leaf. Runs for effects, and emits by calling `dispatch` — zero times,
     * once, or forever. A command that emits nothing simply ignores the
     * parameter, which is why there is no separate "effect that cannot emit"
     * variant: it is this one with an unused argument.
     */
    | {
        readonly _tag: "Effect";
        readonly effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>;
      }

    /**
     * Names the fiber this command forks, so `Cancel` can address it. Nothing
     * else: it does not interrupt, defer, or serialise anything. Nesting
     * resolves outermost-first, matching the wrapper it replaced.
     */
    | { readonly _tag: "Keyed"; readonly key: string; readonly command: Command<A, R> }

    /**
     * Several commands, interpreted in order under one group.
     */
    | { readonly _tag: "Batch"; readonly commands: ReadonlyArray<Command<A, R>> }

    /**
     * Interrupt running work by name. A command in its own right, so a handler
     * can invalidate work *another* action started — the cross-tag case no
     * combinator inside a single handler's effect can reach.
     */
    | { readonly _tag: "Cancel"; readonly target: Group }
  );

/**
 * What `Cancel` addresses.
 */
export interface Group {
  readonly tag: string;
  readonly key?: string;
}

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

/**
 * The constructors, and the whole vocabulary a reducer has for describing work.
 */
export const Command: {
  readonly none: Command<never>;

  /**
   * The leaf. `dispatch` is how the command emits.
   */
  readonly effect: <A = never, R = never>(
    effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>,
  ) => Command<A, R>;

  /**
   * Names the fiber a command forks so `Cancel` can find it.
   */
  readonly keyed: {
    (key: string): <A, R>(command: Command<A, R>) => Command<A, R>;
    <A, R>(key: string, command: Command<A, R>): Command<A, R>;
  };

  /**
   * Commands in order, under one group. For composing *effects*, reach for
   * `Effect.all` inside a single `Command.effect` instead.
   */
  readonly batch: <A, R>(...commands: ReadonlyArray<Command<A, R>>) => Command<A, R>;

  /**
   * A bare string targets every group under that action tag.
   */
  readonly cancel: <A = never>(target: Group | string) => Command<A, never>;

  /**
   * Outbound announcement.
   */
  readonly output: <Tag extends Capitalize<string>, Fields extends Schema.Struct.Fields>(
    message: Message<Tag, Fields, "outbound">,
    payload: Simplify<Omit<Schema.Struct<Fields>["Type"], "_tag">>,
  ) => Command<{ readonly _tag: Tag } & Schema.Struct<Fields>["Type"]>;
} = {
  none: pipeable({ _tag: "None" }),

  effect: (effect) => pipeable({ _tag: "Effect", effect }),

  keyed: ((key: string, command?: Command<any, any>) =>
    command === undefined
      ? (inner: Command<any, any>) => pipeable({ _tag: "Keyed", key, command: inner })
      : pipeable({ _tag: "Keyed", key, command })) as (typeof Command)["keyed"],

  batch: (...commands) => pipeable({ _tag: "Batch", commands }),

  cancel: (target) =>
    pipeable({
      _tag: "Cancel",
      target: typeof target === "string" ? { tag: target } : target,
    }),

  output: (message, payload) =>
    Command.effect<{ readonly _tag: string }>((dispatch) =>
      dispatch((message as any).make(payload)),
    ) as any,
};

type GroupEntry = {
  readonly fiber: Fiber.Fiber<void>;
};

/**
 * The group a command's fibers belong to. `tag` is the issuing action's, filled
 * by the runtime; `key` is whatever a `Keyed` node named it. See `Group`.
 */
type CommandContext = {
  readonly tag: string;
  readonly key?: string;
};

/**
 * The command interpreter, shared by `Blueprint.run` and `createFeatureStore`.
 */
const commandInterpreter = (deps: {
  /**
   * Where a command's emissions go: back to the reducer, or out as an output.
   *
   * The `ctx` is the emitting command's group — the address a `Cancel` would
   * name. It is passed so the store can attribute what it folds to the command
   * that caused it; `run` ignores it, and a one-parameter function is still
   * assignable here, which is why `run`'s sink needed no change.
   */
  readonly emit: (message: { readonly _tag: string }, ctx: CommandContext) => Effect.Effect<void>;
  /**
   * Run after a command's fiber settles, however it settled. `run` needs it to
   * wake a `Queue.take` that quiescence would otherwise never unblock; the
   * store has nothing to wake and passes `Effect.void`.
   */
  readonly settled: Effect.Effect<void>;
  /**
   * How a command's fiber ended.
   *
   * `forkLeaf` forks and returns, so a command that *dies* dies on a fiber
   * nobody is awaiting — an enclosing `catchCause` around `interpret` sees
   * nothing, because `interpret` has already returned by the time the command
   * runs. Without this hook the store's whole documented error contract is
   * unreachable: every defect from a command is discarded silently.
   *
   * Interruption is normal here (that is what `Cancel` and unmount do), so a
   * caller filters on it rather than treating every non-success as a defect.
   */
  readonly onExit?: (exit: Exit.Exit<void>, ctx: CommandContext) => Effect.Effect<void>;
  readonly inFlight: Ref.Ref<number>;
  readonly groups: Ref.Ref<Map<string, ReadonlyArray<GroupEntry>>>;
}): {
  /**
   * Walk a command, forking its leaves into the mount scope.
   *
   * `None` returns. `Effect` forks the leaf, handing it a `dispatch` bound to
   * `deps.emit`, and registers the fiber under the context's group. `Keyed`
   * sets the key for everything below it, outermost winning. `Batch`
   * interprets its members in order under one context. `Cancel` interrupts
   * every fiber at the address it names.
   */
  readonly interpret: (
    command: Command<any, any>,
    ctx: CommandContext,
  ) => Effect.Effect<void, never, any>;
} => {
  const groupId = (target: Group): string => `${target.tag}::${target.key ?? ""}`;

  const cancelGroup = (target: Group) =>
    Effect.gen(function* () {
      const map = yield* Ref.get(deps.groups);
      const ids =
        target.key !== undefined
          ? [groupId(target)]
          : Array.from(map.keys()).filter((id) => id.startsWith(`${target.tag}::`));

      // Every fiber at the address, deliberately: `Cancel` addresses a group,
      // and a batch's members are all of them at that address.
      for (const id of ids) {
        for (const entry of map.get(id) ?? []) yield* Fiber.interrupt(entry.fiber);
      }
    });

  /**
   * Fork one leaf, register it under `ctx`'s group, and arrange for it to be
   * unregistered however it ends.
   *
   * What is *not* here is the whole point of the redesign: no policy, no
   * supersession rule, no per-interpretation occurrence to tell an earlier
   * dispatch from a sibling forked three lines ago. A leaf forks, and the map
   * is a plain address book.
   */
  const forkLeaf = (ctx: CommandContext, run: Effect.Effect<void, never, any>) =>
    Effect.gen(function* () {
      const id = groupId(ctx);

      yield* Ref.update(deps.inFlight, (n) => n + 1);

      const fiber: Fiber.Fiber<void> = yield* Effect.forkChild(run);

      yield* Ref.update(deps.groups, (m) => new Map(m).set(id, [...(m.get(id) ?? []), { fiber }]));

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

      // A fiber interrupted before the scheduler has started it never runs its
      // own body — including an `Effect.ensuring` baked into that body — so
      // cleanup cannot live there. A separate watcher on `Fiber.await` observes
      // the Exit whether or not the fiber ever got to start.
      //
      // `ensuring`, not `andThen`: chaining `cleanup` behind `onExit` meant an
      // `onExit` that died skipped the `inFlight` decrement and the `groups`
      // removal, leaving a settled fiber in its group forever. The bookkeeping
      // has to survive a reporting failure.
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit) =>
          deps.onExit === undefined ? Effect.void : deps.onExit(exit, ctx),
        ),
        Effect.ensuring(cleanup),
        Effect.forkChild,
      );
    });

  /**
   * What a leaf emits with. Bound to `deps.emit`, which is the whole difference
   * between the two callers — `run`'s queue, or the store's synchronous fold.
   *
   * Returns an `Effect`, so it composes with the effect that called it. That is
   * what lets a long-lived source be `Stream.runForEach(source, dispatch)` and
   * a one-shot be `Effect.flatMap(load, dispatch)`, with no separate variant
   * for either.
   *
   * Built per leaf rather than once for the interpreter, because the ctx it
   * closes over is what tells the store which command emitted. A single shared
   * closure cannot carry it: `Keyed` refines the ctx on the way down, so by the
   * time a leaf runs, its ctx is not the one the interpreter was constructed
   * with. One extra closure per forked leaf, which is nothing beside forking
   * the fiber it belongs to.
   */
  const dispatchFor =
    (ctx: CommandContext): Dispatcher<any> =>
    (action) =>
      deps.emit(action, ctx);

  const interpret = (
    command: Command<any, any>,
    ctx: CommandContext,
  ): Effect.Effect<void, never, any> =>
    Effect.gen(function* () {
      switch (command._tag) {
        case "None":
          return;
        case "Effect":
          // `suspend`, so a leaf builder that throws synchronously dies on the
          // command's own fiber and is reported through `onExit`, rather than
          // escaping into whoever called `interpret` — which is the fold, and
          // has no business catching it.
          return yield* forkLeaf(
            ctx,
            Effect.asVoid(Effect.suspend(() => command.effect(dispatchFor(ctx)))),
          );
        case "Keyed":
          // Outermost wins: an inner `Keyed` under an outer one keeps `ctx`
          // whole. Nesting is answerable rather than an error because a keyed
          // command composes into a batch that is itself keyed.
          return yield* interpret(
            command.command,
            ctx.key === undefined ? { tag: ctx.tag, key: command.key } : ctx,
          );
        case "Batch":
          // One `ctx`, so every member shares the issuing action's group — the
          // address `Cancel` names. In order, because the one thing this node
          // can do that `Effect.all` cannot is put a `Cancel` before the
          // command replacing it.
          for (const member of command.commands) yield* interpret(member, ctx);
          return;
        case "Cancel":
          return yield* cancelGroup(command.target);
      }
    });

  return { interpret } as const;
};

/**
 * What a reducer returns: the next state, optionally with a command.
 */
export type Next<State, Action, R = never> = State | readonly [State, Command<Action, R>];

/**
 * Accessors, so a test can fold a sequence of actions without pattern matching
 * on the tuple at every step.
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

export type AnyHooks = Record<string, unknown>;

/**
 * How hooks are written: React-ecosystem hooks — `useQuery`, `useMediaQuery`,
 * anything — called by the runtime in render position with the current props,
 * so the rules of hooks hold and `useThing(id)`-shaped hooks still work.
 */
export type HookSpec<Props, State, H extends AnyHooks> = (props: Props, state: State) => H;

/**
 * Everything readable at a moment: accumulated state plus ambient inputs.
 */
export interface Snapshot<Props, State, H extends AnyHooks> {
  readonly state: State;
  readonly props: Props;
  readonly hooks: H;
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
 * Actions the runtime raises. All optional.
 */
export interface LifecycleHandlers<Props, State, Action, H extends AnyHooks, R = never> {
  /** Fires once, after the initial state exists. Where startup commands live. */
  readonly Mounted?: LifecycleHandler<"Mounted", Props, State, Action, H, R>;

  /**
   * Props are a fresh object every render, so this fires constantly. That is
   * fine: returning the *same state reference* is the no-op. It puts the "did
   * anything I care about change" decision in `reducer`, where it can see the
   * state.
   */
  readonly PropsChanged?: LifecycleHandler<"PropsChanged", Props, State, Action, H, R>;

  /**
   * Fires whenever any hook's value changes, whole-object like `PropsChanged`.
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
   */
  readonly Unmounted?: LifecycleHandler<"Unmounted", Props, State, Action, H, R>;
}

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

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
 * error.
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

const internals: unique symbol = Symbol("@tea/internals");

export interface BlueprintInternals<Props, State, Action, H extends AnyHooks> {
  readonly initialState: (props: Props) => State;
  readonly render: Render<Props, State, Action, H>;
  readonly useHooks: HookSpec<Props, State, H> | undefined;
  readonly props: AnyPropsSchema;
  readonly outputTags: ReadonlyArray<string>;

  /**
   * Whether the feature declared a handler for this tag.
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
   * The reducer as one pure function,
   * with the snapshot standing in for the state.
   */
  readonly reduce: (
    action: Action | LifecycleAction<Props, H>,
    snapshot: Snapshot<Props, State, H>,
  ) => Next<State, Action | Output, R>;

  /**
   * Fold a sequence, run each command against `layer`, feed what it emits back
   * in, and report what left.
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
 * writable on its own.
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
 */
export const define: <
  PropsSchema extends AnyPropsSchema,
  StateSchema extends AnyStateSchema,
  A extends AnyVocabulary<"internal">,
  O extends AnyVocabulary<"outbound"> = NoOutputs,
  H extends AnyHooks = {},
>(spec: {
  readonly props: PropsSchema & NoTransform<PropsSchema>;
  readonly state: StateSchema;
  readonly action: A;
  readonly output?: O & Disjoint<A, O> & NoPropCollision<PropsSchema, O>;

  readonly useHooks?: HookSpec<PropsOf<PropsSchema>, StateOf<StateSchema>, H>;
}) => Definition<PropsOf<PropsSchema>, StateOf<StateSchema>, A, O, H> = (spec) => {
  return {
    initialState: (initialState) => (props) => initialState(props),
    reducer: identity,
    render: identity,
    create: (parts) => {
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
         * the action arrived without going through the typed surface.
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
              const snapshot = { props: options.props, hooks: options.hooks };
              let state = parts.initialState(options.props);

              for (const action of actions) {
                yield* Queue.offer(queue, { msg: action, origin: "seed" });
              }

              const isOutput = (action: { _tag: string }): boolean => outputTagSet.has(action._tag);

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

              // drain until empty: nothing queued and nothing running.
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
          ),
      };
    },
  };
};

// ---------------------------------------------------------------------------
// Mounting a blueprint
// ---------------------------------------------------------------------------

/**
 * The live half of `run`, and the seam the React binding is written against.
 */
export interface FeatureStore<Props, State, Action, H extends AnyHooks> {
  /** The `useSyncExternalStore` pair. `getSnapshot` must be reference-stable
   *  between changes, or React re-renders forever. */
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => State;

  /** The declared vocabulary, from `render`. Stable identity — it lands in props. */
  readonly dispatch: Dispatch<Action>;

  /**
   * The snapshot's ambient half, and — because it is the only thing that sees
   * both the old and new values — the place `PropsChanged` and `HookChanged`
   * are detected and raised.
   */
  readonly sync: (props: Props, hooks: H) => void;

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
   */
  readonly stop: () => void;
}

const instanceCounts = new Map<string, number>();

const nextInstance = (name: string): string => {
  const next = (instanceCounts.get(name) ?? 0) + 1;
  instanceCounts.set(name, next);
  return String(next);
};

const DISPATCH: DevtoolsCause = Object.freeze({ _tag: "Dispatch" as const });
const LIFECYCLE: DevtoolsCause = Object.freeze({ _tag: "Lifecycle" as const });
const ERROR_ACTION = Object.freeze({ _tag: "Error" as const });
const HOOK_CHANGED_ACTION = Object.freeze({ _tag: "HookChanged" as const });

const reportableAction = (action: { readonly _tag: string }): { readonly _tag: string } => {
  if (action._tag === "Error") return ERROR_ACTION;
  if (action._tag === "HookChanged") return HOOK_CHANGED_ACTION;
  return action;
};

const commandCause = (ctx: CommandContext): DevtoolsCause =>
  ctx.key === undefined
    ? { _tag: "Command", action: ctx.tag }
    : { _tag: "Command", action: ctx.tag, key: ctx.key };

export const createFeatureStore = <Props, State, Action, H extends AnyHooks>(args: {
  readonly blueprint: Blueprint<Props, State, Action, any, H, any>;
  readonly props: Props;
  readonly equivalence: {
    readonly props: Equivalence.Equivalence<Props>;
    readonly hooks: Equivalence.Equivalence<H>;
  };
  readonly runtime: ManagedRuntime.ManagedRuntime<any, any>;
  readonly layer: Layer.Layer<any, any, any> | undefined;
  readonly emit: (output: { readonly _tag: string }) => void;
  readonly defect: (error: unknown) => void;
  readonly name?: string;
  readonly instance?: string;
}): FeatureStore<Props, State, Action, H> => {
  const { blueprint, equivalence, runtime, layer, emit, defect } = args;
  const { initialState, outputTags, handles } = blueprint[internals];

  const name = args.name ?? "TeaFeature";
  const instance = args.instance ?? nextInstance(name);

  let resolved = false;
  let sink: DevtoolsSink | undefined;

  const devtools = (): DevtoolsSink | undefined => {
    if (!resolved) {
      const context = runtime.cachedContext;
      if (context === undefined) return undefined;
      const installed = Context.getReferenceUnsafe(context, Devtools);
      sink = installed === noopDevtools ? undefined : installed;
      resolved = true;
    }
    return sink;
  };

  /**
   * Hand one event to the sink, and disable the sink if it throws.
   */
  const report = (event: DevtoolsEvent): void => {
    // Re-read rather than trusting the caller's handle. A single fold reports
    // twice — a transition, then the command it issued — and a sink that threw
    // on the first must not be called for the second. The call sites still
    // guard on `devtools()` before building an event, which is what keeps the
    // no-sink path free of allocation; this is only about staying disabled.
    const target = sink;
    if (target === undefined) return;
    try {
      target.onEvent(event);
    } catch {
      sink = undefined;
    }
  };

  const outputs = new Set(outputTags);

  /**
   * A unit of work for the mount fiber.
   */
  type Work =
    | { readonly _tag: "Run"; readonly command: Command<any, any>; readonly ctx: CommandContext }
    | { readonly _tag: "Teardown"; readonly command: Command<any, any> | undefined }
    | { readonly _tag: "Settled" };

  type Mount = {
    readonly queue: Queue.Queue<Work>;
    readonly groups: Ref.Ref<Map<string, ReadonlyArray<GroupEntry>>>;
    readonly inFlight: Ref.Ref<number>;
  };

  let mount: Mount | undefined;

  const buffered: Array<Work> = [];
  const subscribers = new Set<() => void>();
  const pending: Array<{
    readonly action: { readonly _tag: string };
    readonly cause: DevtoolsCause;
  }> = [];

  let active = false;
  let everStarted = false;
  let state = initialState(args.props);
  let props = args.props;
  let hooks: H | undefined;
  let folding = false;
  let syncing = false;
  let routing: Mount | undefined;

  const snapshot = (): Snapshot<Props, State, H> => ({
    state,
    props,
    hooks: hooks ?? ({} as H),
  });

  const withRouting = <T>(target: Mount, body: () => T): T => {
    const previous = routing;
    routing = target;
    try {
      return body();
    } finally {
      routing = previous;
    }
  };

  const offer = (work: Work): boolean => {
    const target = routing ?? mount;
    if (target !== undefined) {
      Queue.offerUnsafe(target.queue, work);
      return true;
    }
    if (!everStarted) {
      buffered.push(work);
      return true;
    }
    return false;
  };

  const emitOutput = (action: { readonly _tag: string }, cause: DevtoolsCause): void => {
    const target = devtools();
    if (target !== undefined) {
      report({ _tag: "Output", name, instance, cause, output: action });
    }

    try {
      emit(action);
    } catch (error) {
      const onThrow = devtools();
      if (onThrow !== undefined) {
        report({
          _tag: "Defect",
          name,
          instance,
          cause,
          from: action._tag,
          defect: summarizeDefect(error),
          handled: false,
        });
      }
      defect(error);
    }
  };

  const foldOne = (action: { readonly _tag: string }, cause: DevtoolsCause): boolean => {
    if (outputs.has(action._tag)) {
      emitOutput(action, cause);
      return false;
    }

    const previous = state;
    const next = blueprint.reduce(action as never, snapshot());
    const command = Next.command(next);
    const nextState = Next.state(next);
    const moved = nextState !== state;

    if (moved) state = nextState;

    const target = devtools();

    if (target !== undefined) {
      report({
        _tag: "Transition",
        name,
        instance,
        cause,
        action: reportableAction(action),
        previous,
        next: nextState,
      });
    }

    if (command) {
      const ctx = { tag: action._tag };
      const accepted = offer({ _tag: "Run", command, ctx });
      if (target !== undefined) {
        report({
          _tag: "Command",
          name,
          instance,
          cause,
          group: ctx,
          command: summarizeCommand(command),
          dropped: !accepted,
        });
      }
    }
    return moved;
  };

  const fold = (action: { readonly _tag: string }, cause: DevtoolsCause): void => {
    pending.push({ action, cause });
    if (folding) return;

    folding = true;
    let moved = false;
    try {
      while (pending.length > 0) {
        const next = pending.shift()!;
        try {
          if (foldOne(next.action, next.cause)) moved = true;
        } catch (error) {
          raiseDefect(error, next.action._tag, next.cause);
        }
      }
    } finally {
      folding = false;
      if (moved && !syncing) for (const subscriber of subscribers) subscriber();
    }
  };

  function raiseDefect(error: unknown, from: string, cause: DevtoolsCause): void {
    const handled = from !== "Error" && handles("Error");
    const target = devtools();

    if (target !== undefined) {
      report({
        _tag: "Defect",
        name,
        instance,
        cause,
        from,
        defect: summarizeDefect(error),
        handled,
      });
    }

    if (!handled) {
      defect(error);
      return;
    }

    fold({ _tag: "Error", error, cause: Cause.die(error) } as never, { _tag: "Defect", from });
  }

  const run = (cells: Mount) => {
    let context: Context.Context<never> | undefined;

    const release = (): void => {
      if (mount !== cells) return;
      mount = undefined;
      active = false;
    };

    const { interpret } = commandInterpreter({
      inFlight: cells.inFlight,
      groups: cells.groups,
      emit: (message, ctx) =>
        Effect.sync(() => withRouting(cells, () => fold(message, commandCause(ctx)))),
      settled: Effect.sync(() => Queue.offerUnsafe(cells.queue, { _tag: "Settled" })),
      onExit: (exit, ctx) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            withRouting(cells, () =>
              raiseDefect(Cause.squash(exit.cause), ctx.tag, commandCause(ctx)),
            );
          }
        }),
    });

    const provided = (effect: Effect.Effect<void, never, any>) =>
      context === undefined ? effect : Effect.provide(effect, context);

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
          const inFlight = yield* Ref.get(cells.inFlight);
          const queued = yield* Queue.size(cells.queue);
          if (queued === 0 && inFlight === 0) return;

          const work = yield* Queue.take(cells.queue);
          if (work._tag === "Run") yield* provided(interpret(work.command, work.ctx));
        }
      });

    return Effect.gen(function* () {
      if (layer !== undefined) {
        context = (yield* Effect.orDie(Layer.build(layer))) as Context.Context<never>;
      }

      while (true) {
        const work = yield* Queue.take(cells.queue);

        if (work._tag === "Teardown") {
          yield* teardown(work.command).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap((finished) =>
              Option.isNone(finished)
                ? Effect.sync(() =>
                    withRouting(cells, () =>
                      raiseDefect(
                        new Error("Unmounted did not settle within 5s; scope closed anyway"),
                        "Unmounted",
                        LIFECYCLE,
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
          release();
          raiseDefect(Cause.squash(cause), "Mounted", LIFECYCLE);
        }),
      ),

      Effect.ensuring(Effect.sync(release)),
    );
  };

  return {
    subscribe: (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => void subscribers.delete(onStoreChange);
    },

    getSnapshot: () => state,

    dispatch: (action) => fold(action as { readonly _tag: string }, DISPATCH),

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

      if (propsMoved) props = nextProps;
      if (hooksMoved) hooks = nextHooks;
      if (!propsMoved && !hooksMoved) return state;

      syncing = true;

      try {
        if (propsMoved) fold({ _tag: "PropsChanged", previous: previousProps } as never, LIFECYCLE);
        if (hooksMoved) fold({ _tag: "HookChanged", previous: previousHooks } as never, LIFECYCLE);
      } finally {
        syncing = false;
      }

      return state;
    },

    start: () => {
      if (active) return;
      active = true;
      everStarted = true;

      const cells: Mount = {
        queue: Effect.runSync(Queue.unbounded<Work>()),
        groups: Effect.runSync(Ref.make(new Map<string, ReadonlyArray<GroupEntry>>())),
        inFlight: Effect.runSync(Ref.make(0)),
      };

      mount = cells;

      for (const work of buffered.splice(0)) Queue.offerUnsafe(cells.queue, work);
      runtime.runFork(run(cells));
      fold({ _tag: "Mounted" }, LIFECYCLE);
    },

    stop: () => {
      const cells = mount;
      if (!active) return;
      active = false;

      if (cells === undefined) return;

      let teardown: Command<any, any> | undefined;
      let thrown: { readonly error: unknown } | undefined;

      try {
        teardown = Next.command(blueprint.reduce({ _tag: "Unmounted" } as never, snapshot()));
      } catch (error) {
        thrown = { error };
      }

      Queue.offerUnsafe(cells.queue, { _tag: "Teardown", command: teardown });

      const target = devtools();

      if (target !== undefined) {
        report({
          _tag: "Transition",
          name,
          instance,
          cause: LIFECYCLE,
          action: { _tag: "Unmounted" },
          previous: state,
          next: state,
        });
        if (teardown !== undefined) {
          report({
            _tag: "Command",
            name,
            instance,
            cause: LIFECYCLE,
            group: { tag: "Unmounted" },
            command: summarizeCommand(teardown),
            dropped: false,
          });
        }
      }

      if (thrown !== undefined) raiseDefect(thrown.error, "Unmounted", LIFECYCLE);
    },
  };
};

const propsValidators = new WeakMap<AnyPropsSchema, (props: unknown) => unknown>();

const validateProps = (schema: AnyPropsSchema, props: unknown): void => {
  let validate = propsValidators.get(schema);
  if (validate === undefined) {
    validate = SchemaParser.decodeUnknownSync(
      schema as AnyPropsSchema & { readonly DecodingServices: never },
      { onExcessProperty: "error", errors: "all" },
    );
    propsValidators.set(schema, validate);
  }
  validate(props);
};

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

const hooksEquivalence = Equivalence.Record(
  Equivalence.strictEqual<unknown>(),
) as Equivalence.Equivalence<AnyHooks>;

const noHooks: AnyHooks = Object.freeze({});

/**
 * The runtime is a root provider.
 */
export const createRuntime: <RootR, RootE>(
  layer: Layer.Layer<RootR, RootE>,
) => {
  readonly Provider: FC<{ readonly children?: ReactNode }>;

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
   * Escape hatch for ordinary React components that are not blueprints.
   */
  readonly useRuntime: () => ManagedRuntime.ManagedRuntime<RootR, RootE>;
} = (layer) => {
  const runtime = ManagedRuntime.make(layer);
  const context = createContext(runtime);

  const component = (
    blueprint: Blueprint<any, any, any, any, any, any>,
    componentOptions: { readonly layer?: Layer.Layer<any, any, any>; readonly name?: string } = {},
  ): FC<any> => {
    const { render, useHooks, props: propsSchema, outputTags } = blueprint[internals];
    const name = componentOptions.name ?? "TeaFeature";
    const useFeatureHooks: HookSpec<any, any, AnyHooks> = useHooks ?? (() => noHooks);
    const outputPropNames = new Set(outputTags.map((tag) => `on${tag}`));

    const equivalence = {
      props: Schema.toEquivalence(propsSchema) as Equivalence.Equivalence<Record<string, unknown>>,
      hooks: hooksEquivalence,
    };

    const Feature: FC<Record<string, unknown>> = (incoming) => {
      const rootRuntime = useContext(context);

      const { props, handlers } = useMemo(
        () => splitOutputProps(incoming, outputPropNames),
        [incoming],
      );

      useMemo(() => validateProps(propsSchema, props), [props]);

      const handlersRef = useRef(handlers);

      useEffect(() => {
        handlersRef.current = handlers;
      }, [handlers]);

      const [defect, setDefect] = useState<{ readonly error: unknown } | undefined>(undefined);
      if (defect) throw defect.error;

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
          name,
        }),
      );

      const committed = store.getSnapshot();
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
