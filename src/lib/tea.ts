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

/**
 * Marks a prop the devtools must not print. The annotation's value is the
 * placeholder printed in its stead.
 */
const OPAQUE = "@tea/opaque";

/** One declaration, at whatever type the feature calls its children. */
const children = <T>(): Schema.declare<T> =>
  Schema.declare<T>((_u): _u is T => true, {
    identifier: "Children",
    [OPAQUE]: "<children>",
    toEquivalence: () => () => true,
  });

/**
 * Whatever a feature accepts as `children` — a node, a render prop, a tuple of
 * slots. **The type argument is the contract**; the schema carries no
 * structure at all.
 *
 *     children: Children                                    // ReactNode
 *     children: Children.as<(row: Row) => ReactNode>()      // a render prop
 *     children: Schema.optionalKey(Children)                // optional
 *
 * Three deliberate properties: it **validates anything** (React owns what it
 * can render; the type argument holds callers to the contract); it is
 * **invisible to change detection** (equivalence constantly `true`, so a fresh
 * node per parent render never raises `PropsChanged` — the corollary is that a
 * reducer's `snapshot.props.children` can be stale; `render` always sees the
 * current one); and it is **redacted in devtools** to `"<children>"`, keeping
 * every event JSON round-trippable.
 *
 * Declared plainly the key is **required** — JSX passing no children omits the
 * key rather than passing `undefined`, so the optional form is
 * `Schema.optionalKey`.
 */
export const Children: Schema.declare<ReactNode> & {
  /** The same declaration at another children type — a render prop, say. */
  readonly as: <T>() => Schema.declare<T>;
} = Object.assign(children<ReactNode>(), { as: children });

/**
 * The props carrying an `OPAQUE` annotation, paired with their placeholder.
 *
 * Read off the field's own AST, and — because `Schema.optional(x)` is
 * `optionalKey(UndefinedOr(x))` — off a union's members. `Schema.optionalKey`
 * needs no unwrapping: it marks the key, leaving the declaration's AST intact.
 */
const opaqueProps = (schema: AnyPropsSchema): ReadonlyArray<readonly [string, unknown]> => {
  const found: Array<readonly [string, unknown]> = [];

  for (const [key, field] of Object.entries(schema.fields)) {
    const ast = field.ast;
    const placeholder =
      ast.annotations?.[OPAQUE] ??
      ("types" in ast && Array.isArray(ast.types)
        ? ast.types.find((member: { annotations?: Record<string, unknown> }) =>
            Object.hasOwn(member.annotations ?? {}, OPAQUE),
          )?.annotations?.[OPAQUE]
        : undefined);

    if (placeholder !== undefined) found.push([key, placeholder]);
  }

  return found;
};

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

/**
 * The group a command's fibers belong to. `tag` is the issuing action's, filled
 * by the runtime; `key` is whatever a `Keyed` node named it. See `Group`.
 */
type CommandContext = {
  readonly tag: string;
  readonly key?: string;
};

/**
 * Mutable bookkeeping for the fibers an interpreter has in flight. Every
 * mutation is synchronous and JS is single-threaded, so plain fields suffice —
 * fibers only interleave at yield points.
 *
 * Nested by tag then key (`undefined` = unkeyed) rather than a `${tag}:${key}`
 * string, so a tag or key containing the would-be delimiter cannot collide
 * with another group's address.
 */
type FiberBook = {
  readonly groups: Map<string, Map<string | undefined, Set<Fiber.Fiber<void>>>>;
  inFlight: number;
};

const fiberBook = (): FiberBook => ({ groups: new Map(), inFlight: 0 });

const allFibers = (book: FiberBook): Array<Fiber.Fiber<void>> =>
  [...book.groups.values()].flatMap((byKey) => [...byKey.values()].flatMap((set) => [...set]));

/**
 * The command interpreter, shared by `Blueprint.run` and `createFeatureStore`.
 *
 * `interpret` walks a command, forking its leaves: `None` returns, `Effect`
 * forks the leaf with a `dispatch` bound to `deps.emit`, `Keyed` sets the key
 * for everything below it (outermost wins), `Batch` interprets members in
 * order under one context, `Cancel` interrupts every fiber at the address it
 * names.
 */
const commandInterpreter = (deps: {
  /**
   * Where a command's emissions go: back to the reducer, or out as an output.
   * `ctx` is the emitting command's group, so the store can attribute what it
   * folds; `run` ignores it.
   */
  readonly emit: (message: { readonly _tag: string }, ctx: CommandContext) => Effect.Effect<void>;
  /**
   * Runs after a command's fiber settles, however it settled — `run` needs it
   * to wake a `Queue.take` that quiescence would otherwise never unblock.
   */
  readonly settled: Effect.Effect<void>;
  /**
   * How a command's fiber ended. `forkLeaf` forks and returns, so a dying
   * command dies on a fiber nobody awaits — without this hook every defect
   * from a command is discarded silently. Interruption is normal here
   * (`Cancel`, unmount), so callers filter on it.
   */
  readonly onExit?: (exit: Exit.Exit<void>, ctx: CommandContext) => Effect.Effect<void>;
  readonly book: FiberBook;
}): {
  readonly interpret: (
    command: Command<any, any>,
    ctx: CommandContext,
  ) => Effect.Effect<void, never, any>;
} => {
  const { book } = deps;

  // Every fiber at the address: a bare tag addresses every key under it.
  const fibersAt = (target: Group): Array<Fiber.Fiber<void>> => {
    const byKey = book.groups.get(target.tag);
    if (byKey === undefined) return [];
    if (target.key !== undefined) return [...(byKey.get(target.key) ?? [])];
    return [...byKey.values()].flatMap((set) => [...set]);
  };

  /** Fork one leaf, register it under `ctx`'s group, unregister however it ends. */
  const forkLeaf = (ctx: CommandContext, run: Effect.Effect<void, never, any>) =>
    Effect.gen(function* () {
      book.inFlight += 1;

      const fiber: Fiber.Fiber<void> = yield* Effect.forkChild(run);
      const byKey =
        book.groups.get(ctx.tag) ?? new Map<string | undefined, Set<Fiber.Fiber<void>>>();
      book.groups.set(ctx.tag, byKey);
      const group = byKey.get(ctx.key) ?? new Set<Fiber.Fiber<void>>();
      byKey.set(ctx.key, group);
      group.add(fiber);

      // No identity guards on the deletes: a Set or key-map level is deleted
      // only when empty, by the cleanup that emptied it, and cleanups run
      // exactly once — so a registered instance can never be a stale one.
      const cleanup = Effect.sync(() => {
        book.inFlight -= 1;
        group.delete(fiber);
        if (group.size === 0) {
          byKey.delete(ctx.key);
          if (byKey.size === 0) book.groups.delete(ctx.tag);
        }
      });

      // A fiber interrupted before the scheduler has started it never runs its
      // own body — including an `Effect.ensuring` baked into that body —
      // verified against the installed effect version. So cleanup cannot live
      // in the leaf; a separate watcher on `Fiber.await` observes the Exit
      // whether or not the fiber ever got to start. `ensuring`, not `andThen`:
      // the bookkeeping has to survive an `onExit` that dies.
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit) =>
          deps.onExit === undefined ? Effect.void : deps.onExit(exit, ctx),
        ),
        Effect.ensuring(Effect.andThen(cleanup, deps.settled)),
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
          // `suspend`, so a leaf builder that throws synchronously dies on the
          // command's own fiber and is reported through `onExit` rather than
          // escaping into the fold that called `interpret`.
          return yield* forkLeaf(
            ctx,
            Effect.asVoid(Effect.suspend(() => command.effect((action) => deps.emit(action, ctx)))),
          );
        case "Keyed":
          // Outermost wins: an inner `Keyed` under an outer one keeps `ctx` whole.
          return yield* interpret(
            command.command,
            ctx.key === undefined ? { tag: ctx.tag, key: command.key } : ctx,
          );
        case "Batch":
          // One `ctx`, so every member shares the issuing action's group. In
          // order, because the one thing this node can do that `Effect.all`
          // cannot is put a `Cancel` before the command replacing it.
          for (const member of command.commands) yield* interpret(member, ctx);
          return;
        case "Cancel":
          return yield* Fiber.interruptAll(fibersAt(command.target));
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
   * Fires when props change **by value** (`Schema.toEquivalence`), so an
   * unchanged parent re-render folds nothing. Returning the same state
   * reference is the no-op.
   */
  readonly PropsChanged?: LifecycleHandler<"PropsChanged", Props, State, Action, H, R>;

  /**
   * Fires whenever any hook's value changes, whole-object like `PropsChanged`.
   */
  readonly HookChanged?: LifecycleHandler<"HookChanged", Props, State, Action, H, R>;

  /**
   * Commands cannot fail, but they can still *die* — and a feature layer can
   * fail to build. Both arrive here as defects. Left unhandled, the defect is
   * rethrown into the nearest React error boundary. `error` is the squashed
   * cause; `cause` is there for handlers that want the real one.
   */
  readonly Error?: LifecycleHandler<"Error", Props, State, Action, H, R>;

  /**
   * The component is gone, so the runtime reads `Next.command(…)` and
   * discards the rest — return `snapshot.state` and put the work in the
   * command. `blueprint.reduce` discards identically, so a teardown test
   * folded through `reduce` cannot disagree with the runtime.
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
   * The props that must not reach a devtools sink, with what stands in for
   * them. Empty for a feature whose props are all schema values.
   */
  readonly opaqueProps: ReadonlyArray<readonly [string, unknown]>;

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
  // Opaque declarations (`Children`) are redacted only in `PropsChanged`
  // events; state reaches devtools transitions verbatim. Refusing them here
  // keeps the "every event is encodable" contract honest.
  const opaqueState = opaqueProps(spec.state as AnyPropsSchema);
  if (opaqueState.length > 0) {
    throw new TypeError(
      `Opaque field "${opaqueState[0]![0]}" declared in the state schema; ` +
        "opaque declarations like Children belong in props",
    );
  }

  return {
    initialState: (initialState) => (props) => initialState(props),
    reducer: identity,
    render: identity,
    create: (parts) => {
      const outputTags = spec.output ? Object.keys(spec.output.cases) : [];
      const outputTagSet = new Set(outputTags);

      /**
       * A missing handler is the documented no-op only for a *lifecycle* tag —
       * every `LifecycleHandlers` entry is optional by design. A missing
       * handler for anything else is a defect: `Reducer` requires one for
       * every declared action tag, so reaching that branch means the action
       * arrived without going through the typed surface.
       *
       * `Unmounted`'s returned state is discarded: the component is gone, so
       * the state has nowhere to go. Only the command survives — `run` and the
       * store both fold through here, so they cannot disagree.
       */
      const reduce = (
        action: { readonly _tag: string },
        snapshot: Snapshot<any, any, any>,
      ): Next<any, any, any> => {
        const handler = handlerFor(parts.reducer, action._tag);
        if (handler) {
          const next = handler(action as never, snapshot);
          if (action._tag !== "Unmounted") return next;
          const command = Next.command(next);
          return command === undefined ? snapshot.state : [snapshot.state, command];
        }
        if (isLifecycleTag(action._tag)) return snapshot.state;
        throw new TypeError(`No reducer handler for action "${action._tag}"`);
      };

      return {
        [internals]: {
          initialState: parts.initialState,
          render: parts.render,
          useHooks: spec.useHooks,
          props: spec.props,
          outputTags,
          opaqueProps: opaqueProps(spec.props),
          handles: (tag) => handlerFor(parts.reducer, tag) !== undefined,
        },

        reduce,

        run: (actions, options) =>
          discharge(
            Effect.gen(function* () {
              type Entry = {
                readonly msg: { _tag: string };
                readonly origin: "seed" | "command" | "settled";
              };

              const queue = yield* Queue.unbounded<Entry>();
              const book = fiberBook();
              const emitted: { _tag: string }[] = [];
              const outputs: { _tag: string }[] = [];
              const snapshot = { props: options.props, hooks: options.hooks };
              let state = parts.initialState(options.props);

              for (const action of actions) {
                yield* Queue.offer(queue, { msg: action, origin: "seed" });
              }

              const isOutput = (action: { _tag: string }): boolean => outputTagSet.has(action._tag);

              const { interpret } = commandInterpreter({
                book,
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

              // Drain until quiescent: nothing queued and nothing running. The
              // two reads are synchronous back to back, so no fiber can settle
              // or emit between them.
              while (book.inFlight > 0 || Queue.sizeUnsafe(queue) > 0) {
                const entry = yield* Queue.take(queue);
                if (entry.origin === "settled") continue;
                if (isOutput(entry.msg)) {
                  outputs.push(entry.msg);
                  continue;
                }
                if (entry.origin === "command") emitted.push(entry.msg);

                const next = reduce(entry.msg, { ...snapshot, state });
                const command = Next.command(next);
                state = Next.state(next);
                if (command) yield* interpret(command, { tag: entry.msg._tag });
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
   * are detected and raised. Returns the post-fold state, so a caller driving
   * the store by hand sees the change the sync just caused.
   */
  readonly sync: (props: Props, hooks: H) => State;

  /**
   * Open the mount, build the feature layer inside it, raise `Mounted`.
   * Idempotent while started; calling it after `stop` re-arms the store (the
   * StrictMode remount path), reusing the existing state.
   */
  readonly start: () => void;

  /**
   * Raise `Unmounted`, run its command with the feature's services still
   * alive, and close the mount once that command settles.
   */
  readonly stop: () => void;
}

/** Devtools instance ids: unique per page, not gapless, not per-name. */
let instanceCount = 0;

const DISPATCH: DevtoolsCause = Object.freeze({ _tag: "Dispatch" as const });
const LIFECYCLE: DevtoolsCause = Object.freeze({ _tag: "Lifecycle" as const });
const ERROR_ACTION = Object.freeze({ _tag: "Error" as const });
const HOOK_CHANGED_ACTION = Object.freeze({ _tag: "HookChanged" as const });

/**
 * What a devtools sink is allowed to see of an action.
 *
 * `Error` and `HookChanged` are scrubbed to their tag: one holds a live `Error`
 * and a `Cause`, the other a record that routinely holds functions.
 * `PropsChanged` keeps its `previous` props — they are schema values and they
 * encode — except for the ones declared opaque, which are replaced by their
 * placeholder. That is what keeps every event JSON round-trippable once a
 * feature declares `children`.
 */
const reportableAction = (
  action: { readonly _tag: string },
  opaqueFields: ReadonlyArray<readonly [string, unknown]>,
): { readonly _tag: string } => {
  if (action._tag === "Error") return ERROR_ACTION;
  if (action._tag === "HookChanged") return HOOK_CHANGED_ACTION;
  if (action._tag !== "PropsChanged" || opaqueFields.length === 0) return action;

  const { previous } = action as { readonly previous?: Record<string, unknown> };
  if (previous === null || typeof previous !== "object") return action;

  let redacted: Record<string, unknown> | undefined;
  for (const [key, placeholder] of opaqueFields) {
    if (!Object.hasOwn(previous, key)) continue;
    redacted ??= { ...previous };
    redacted[key] = placeholder;
  }

  if (redacted === undefined) return action;
  return { ...action, previous: redacted } as { readonly _tag: string };
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
  const { initialState, outputTags, opaqueProps: opaqueFields, handles } = blueprint[internals];

  const name = args.name ?? "TeaFeature";
  const instance = args.instance ?? String(++instanceCount);

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
    // Re-read `sink` rather than trusting the caller's handle: a single fold
    // reports twice, and a sink that threw on the first event must not be
    // called for the second. Call sites still guard on `devtools()` before
    // building an event, which keeps the no-sink path free of allocation.
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
    readonly book: FiberBook;
  };

  let mount: Mount | undefined;

  const buffered: Array<Work> = [];
  const subscribers = new Set<() => void>();

  /**
   * Actions waiting to fold, each carrying the mount its commands must go to.
   * `target` is set for actions a command emitted — they belong to the mount
   * whose command emitted them, which during a teardown drain is not the
   * currently installed one. A plain `dispatch` carries none and routes to
   * whatever mount is live when it folds.
   */
  const pending: Array<{
    readonly action: { readonly _tag: string };
    readonly cause: DevtoolsCause;
    readonly target: Mount | undefined;
  }> = [];

  let active = false;
  let everStarted = false;
  let state = initialState(args.props);
  let props = args.props;
  let hooks: H | undefined;
  let folding = false;
  let syncing = false;

  const snapshot = (): Snapshot<Props, State, H> => ({
    state,
    props,
    hooks: hooks ?? ({} as H),
  });

  const offer = (work: Work, target: Mount | undefined): boolean => {
    const to = target ?? mount;
    if (to !== undefined) {
      Queue.offerUnsafe(to.queue, work);
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

  const foldOne = (
    action: { readonly _tag: string },
    cause: DevtoolsCause,
    routeTo: Mount | undefined,
  ): boolean => {
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
        action: reportableAction(action, opaqueFields),
        previous,
        next: nextState,
      });
    }

    if (command) {
      const ctx = { tag: action._tag };
      const accepted = offer({ _tag: "Run", command, ctx }, routeTo);
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

  const fold = (action: { readonly _tag: string }, cause: DevtoolsCause, target?: Mount): void => {
    pending.push({ action, cause, target });
    if (folding) return;

    folding = true;
    let moved = false;
    try {
      while (pending.length > 0) {
        const next = pending.shift()!;
        try {
          if (foldOne(next.action, next.cause, next.target)) moved = true;
        } catch (error) {
          raiseDefect(error, next.action._tag, next.cause, next.target);
        }
      }
    } finally {
      folding = false;
      if (moved && !syncing) for (const subscriber of subscribers) subscriber();
    }
  };

  function raiseDefect(error: unknown, from: string, cause: DevtoolsCause, target?: Mount): void {
    const handled = from !== "Error" && handles("Error");
    const sink = devtools();

    if (sink !== undefined) {
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

    fold(
      { _tag: "Error", error, cause: Cause.die(error) } as never,
      { _tag: "Defect", from },
      target,
    );
  }

  const run = (cells: Mount) => {
    const release = (): void => {
      if (mount !== cells) return;
      mount = undefined;
      active = false;
    };

    const { interpret } = commandInterpreter({
      book: cells.book,
      emit: (message, ctx) => Effect.sync(() => fold(message, commandCause(ctx), cells)),
      settled: Effect.sync(() => Queue.offerUnsafe(cells.queue, { _tag: "Settled" })),
      onExit: (exit, ctx) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            raiseDefect(Cause.squash(exit.cause), ctx.tag, commandCause(ctx), cells);
          }
        }),
    });

    // Interrupt in-flight work, run the `Unmounted` command with services still
    // alive, then drain to quiescence so nothing that command started is lost.
    const teardown = (command: Command<any, any> | undefined) =>
      Effect.gen(function* () {
        yield* Fiber.interruptAll(allFibers(cells.book));

        if (command !== undefined) {
          yield* interpret(command, { tag: "Unmounted" });
        }

        while (cells.book.inFlight > 0 || Queue.sizeUnsafe(cells.queue) > 0) {
          const work = yield* Queue.take(cells.queue);
          if (work._tag === "Run") yield* interpret(work.command, work.ctx);
        }
      });

    const loop = Effect.gen(function* () {
      while (true) {
        const work = yield* Queue.take(cells.queue);

        if (work._tag === "Teardown") {
          yield* teardown(work.command).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap((finished) =>
              Option.isNone(finished)
                ? Effect.sync(() =>
                    raiseDefect(
                      new Error("Unmounted did not settle within 5s; scope closed anyway"),
                      "Unmounted",
                      LIFECYCLE,
                      cells,
                    ),
                  )
                : Effect.void,
            ),
          );
          return;
        }

        if (work._tag === "Settled") continue;

        yield* interpret(work.command, work.ctx);
      }
    });

    // `Effect.provide` builds the feature layer once for the mount and releases
    // it when the loop ends; commands forked inside inherit its services. A
    // layer that fails to build surfaces in `catchCause` below.
    return (layer === undefined ? loop : Effect.provide(loop, layer)).pipe(
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

      // `Queue.unbounded` captures the current fiber's dispatcher, so there is
      // no synchronous constructor to reach for; `runSync` of a sync effect is
      // exactly that constructor.
      const cells: Mount = {
        queue: Effect.runSync(Queue.unbounded<Work>()),
        book: fiberBook(),
      };

      mount = cells;

      for (const work of buffered.splice(0)) Queue.offerUnsafe(cells.queue, work);
      runtime.runFork(run(cells));
      fold({ _tag: "Mounted" }, LIFECYCLE);
    },

    stop: () => {
      if (!active) return;
      active = false;

      const cells = mount;
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

    const validateProps = SchemaParser.decodeUnknownSync(
      propsSchema as AnyPropsSchema & { readonly DecodingServices: never },
      { onExcessProperty: "error", errors: "all" },
    );

    const Feature: FC<Record<string, unknown>> = (incoming) => {
      const rootRuntime = useContext(context);

      const { props, handlers } = useMemo(
        () => splitOutputProps(incoming, outputPropNames),
        [incoming],
      );

      useMemo(() => void validateProps(props), [props]);

      // Latest-ref, assigned during render rather than in an effect: a
      // command fiber can emit an output on a microtask between the commit
      // and a passive effect's flush, and an effect-updated ref would hand
      // that emission the previous render's handler. Handlers derive purely
      // from props, so a discarded render's assignment is harmless.
      const handlersRef = useRef(handlers);
      handlersRef.current = handlers;

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

      // In the body, not an effect: `sync` compares props and hooks by value
      // and folds `PropsChanged`/`HookChanged`, so a props-driven change
      // paints on the render that carried the props. A discarded render
      // repeats the call; the value comparison makes the repeat a no-op.
      store.sync(props, hooks);

      // After `sync`, deliberately: `useSyncExternalStore` re-reads
      // `getSnapshot` when the render finishes and schedules another render if
      // it moved — folding first means both reads see the same state.
      // Defensive rather than a measured fix; see `tea.specs.md`. Hook order
      // stays stable: called unconditionally, just later in the body.
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

      // `Mounted` stays in an effect: it must not fire for a render React
      // throws away. `start`/`stop` rather than a single `dispose` lets the
      // StrictMode remount re-arm the store instead of inheriting a closed
      // scope.
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
