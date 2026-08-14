import type { Context, Layer } from "effect";
import type { Command, Group } from "./tea";

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * Why the runtime folded the action it is reporting.
 *
 * Order is almost worthless in a log of N independent machines; causality is
 * what makes one readable. `cart#3` folding `Bump` right after `presence#1`
 * folded `RosterSynced` says nothing on its own — that a command issued by
 * `Bump` emitted it says everything.
 *
 * Four variants, and the count is deliberate. There is no `Output` cause,
 * although the earlier sketch had one. It would have claimed *"this action was
 * caused by a child's output"*, but an output leaves through a plain React
 * callback into arbitrary user code, and the runtime cannot observe what the
 * parent did with it — anything it asserted there would be a guess presented as
 * a fact. A devtools UI can still draw that edge from an adjacent
 * {@link DevtoolsOutput}; it just does so as its own inference. Deleting the
 * variant rather than leaving it optional is what lets `cause` be **required**:
 * every emission site inside the runtime knows its own cause.
 */
export type DevtoolsCause =
  /** A `dispatch` from React — an event handler, or a caller holding the store. */
  | { readonly _tag: "Dispatch" }

  /**
   * An action a running command emitted. `action` is the tag of the action
   * whose handler returned that command, and `key` is present when the command
   * was `Command.keyed` — the pair is exactly the {@link Group} address a
   * `Cancel` would have used to interrupt it.
   */
  | { readonly _tag: "Command"; readonly action: string; readonly key?: string }

  /** `Mounted`, `PropsChanged`, `HookChanged` or `Unmounted`. */
  | { readonly _tag: "Lifecycle" }

  /**
   * The `Error` action the runtime folded after a defect it could route.
   * `from` is the tag the defect was attributed to, so a reader can pair this
   * transition with the {@link DevtoolsDefect} that preceded it.
   */
  | { readonly _tag: "Defect"; readonly from: string };

/**
 * What every event carries, whatever its `_tag`.
 *
 * `name` is a *blueprint* name, so without `instance` two `<Presence roomId="…">`
 * are indistinguishable in the stream. `instance` is unique per mount and per
 * page, not gapless: StrictMode double-invokes the `useState` initialiser and
 * burns an id, and the counter is module-global rather than per runtime.
 */
export interface DevtoolsEnvelope {
  /** From `component(bp, { name })`; `"TeaFeature"` when the caller named nothing. */
  readonly name: string;
  /** Which mount. */
  readonly instance: string;
  readonly cause: DevtoolsCause;
}

/**
 * A reducer ran and state moved — or deliberately did not.
 *
 * `previous` and `next` are the real state references, not copies. A sink that
 * intends to keep them past the call has to copy them itself; the runtime will
 * not pay for a snapshot nobody may read.
 */
export interface DevtoolsTransition extends DevtoolsEnvelope {
  readonly _tag: "Transition";
  readonly action: { readonly _tag: string };
  readonly previous: unknown;
  readonly next: unknown;
}

/**
 * A reducer returned a command and the runtime took delivery of it.
 *
 * `dropped` is the honest half. A command offered when no mount is draining the
 * queue is discarded silently — deliberately, because reporting it through the
 * defect sink replaced a feature's recovery UI with a crash on exactly the
 * failure its `Error` handler existed to handle. Silent to the *feature* is not
 * the same as invisible to a *debugger*, so the flag is here: the log would
 * otherwise show work being issued that never ran, which is the single most
 * misleading thing a command log can do.
 */
export interface DevtoolsCommand extends DevtoolsEnvelope {
  readonly _tag: "Command";
  /** The address a `Cancel` would name to interrupt this work. */
  readonly group: Group;
  readonly command: CommandSummary;
  /** No mount was draining the queue; the command was discarded, not run. */
  readonly dropped: boolean;
}

/**
 * An outbound message left the feature.
 *
 * Carries the **whole message including `_tag`**, unlike the `on<Tag>` prop the
 * parent receives, which has `_tag` stripped because the tag is already in the
 * prop's name. A log has no such context, and a stream of anonymous payloads is
 * not a log.
 */
export interface DevtoolsOutput extends DevtoolsEnvelope {
  readonly _tag: "Output";
  readonly output: { readonly _tag: string };
}

/**
 * A command died, or an `on<Tag>` handler threw.
 *
 * Emitted from exactly one place per path, which is worth stating because there
 * are two paths and they look like they should share one: the interpreter's
 * exit hook routes through `raiseDefect`, and `emitOutput`'s catch deliberately
 * calls the defect sink *directly* so a parent's bug is never mistaken for the
 * feature's own. The first emits inside `raiseDefect`; the second emits at its
 * own catch. Adding an emission to the exit hook as well would double every
 * dying command.
 *
 * When `handled` is true, a `Transition` for the `Error` action follows, with
 * `cause: { _tag: "Defect" }`. That is **not** a duplicate report: one says a
 * defect occurred, the other says the feature's recovery ran.
 */
export interface DevtoolsDefect extends DevtoolsEnvelope {
  readonly _tag: "Defect";
  /** The action tag the defect is attributed to. */
  readonly from: string;
  readonly defect: DefectSummary;
  /** An `Error` handler took it, rather than React's error boundary. */
  readonly handled: boolean;
}

/**
 * Everything the runtime reports, as one tagged union.
 *
 * Loosely typed on purpose — a root observer sees features it knows nothing
 * about. Every field is encodable, which is the property the whole module is
 * sold on: actions, outputs, state and props are all schemas with no escape
 * hatch, and the two fields that were *not* encodable — a `Command`'s effect
 * and a defect's `Error` — are erased into {@link CommandSummary} and
 * {@link DefectSummary} rather than passed through. So a sink can be a
 * `postMessage` transport or a replay log with no schema-aware serialiser in
 * between.
 *
 * There is no timestamp. The sink is called synchronously at the emission
 * point, so emit-time and receive-time are the same instant, and a receiver
 * that wants a clock has one. Keeping `Date.now()` out of the library also
 * keeps every expected event in a test a total literal, and stops an elapsed
 * figure from implying a reducer duration nothing here measures.
 *
 * This is also the argument for outputs over a shared bus, restated as a data
 * structure: an output has a declared tag, a schema and a known recipient, so
 * the edge between two features is derivable from the stream. Bus traffic is
 * opaque and the edge is not.
 *
 * Note what is not here: anything for an externally *sent* message. That was a
 * `Query` variant in the original sketch, and cutting queries removed it —
 * which is the second-order reason they went. A message arriving from outside
 * has no origin the runtime can name, so the one variant that could not be
 * filled in was also the only one crossing a boundary inbound.
 */
export type DevtoolsEvent = DevtoolsTransition | DevtoolsCommand | DevtoolsOutput | DevtoolsDefect;

// ---------------------------------------------------------------------------
// Encodable summaries
// ---------------------------------------------------------------------------

/**
 * A {@link Command} with its effect erased.
 *
 * The shape mirrors the ADT one-for-one so a reader can recognise what the
 * reducer wrote, minus the one field that cannot cross a `postMessage`: the
 * leaf's callback. Everything a debugger actually wants from a leaf — that
 * there is one, where it sits in a batch, what key names its fiber — is
 * structure, and structure survives.
 */
export type CommandSummary =
  | { readonly _tag: "None" }
  /** The leaf. The effect itself is gone; only the fact of it remains. */
  | { readonly _tag: "Effect" }
  | { readonly _tag: "Keyed"; readonly key: string; readonly command: CommandSummary }
  | { readonly _tag: "Batch"; readonly commands: ReadonlyArray<CommandSummary> }
  | { readonly _tag: "Cancel"; readonly target: Group };

/**
 * An unknown thrown value, flattened to three optional-ish strings.
 *
 * An `Error` is structured-cloneable but `JSON.stringify`s to `{}`, so passing
 * one through would quietly empty the most important field in the log at the
 * first transport boundary. The cost, stated plainly: `stack` is a *string*, so
 * a console printing it loses the browser's clickable frames. Encodability was
 * judged worth that, because a stack you can read beats a stack you can click
 * but cannot send anywhere.
 */
export interface DefectSummary {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Erase a command to its {@link CommandSummary}.
 *
 * Total: nesting is preserved, batch order is preserved, and nothing about the
 * input can make it throw — it runs on a debugging path, and a summariser that
 * can fail is a debugger that breaks the program it was installed to watch.
 */
export declare const summarizeCommand: (command: Command<any, any>) => CommandSummary;

/**
 * Erase an unknown thrown value to its {@link DefectSummary}.
 *
 * `unknown` and not `Error` because `throw` accepts anything: a string, a
 * symbol, `undefined`, an object with a throwing `message` getter. Every one of
 * those produces a summary rather than a second failure.
 */
export declare const summarizeDefect: (error: unknown) => DefectSummary;

// ---------------------------------------------------------------------------
// The sink service
// ---------------------------------------------------------------------------

/**
 * Where events go.
 *
 * **Synchronous, and that is the whole design constraint.** `createFeatureStore`'s
 * fold is a plain function; only commands are Effects. A sink returning an
 * `Effect` would put a forked fiber and a scheduler hop on the hottest path in
 * the library, and the log could land after the state it describes had already
 * moved on — a debugger that reorders the thing it is reporting.
 *
 * One method, so an implementation is a literal. The console logger, the test
 * recorder and a `postMessage` transport are all this interface.
 */
export interface DevtoolsSink {
  readonly onEvent: (event: DevtoolsEvent) => void;
}

/**
 * The default sink: does nothing, and is the signal that nobody installed one.
 *
 * A frozen module constant rather than a fresh object per read, because the
 * runtime detects "no devtools" by comparing the resolved reference against
 * **this exact value** by identity. `Context.getReferenceUnsafe` caches the
 * default it computes, so repeated reads are identity-stable — but
 * `Devtools.defaultValue()` re-invokes the thunk and returns something new, so
 * nothing may ever compare against that.
 */
export declare const noopDevtools: DevtoolsSink;

/**
 * The service key, as a `Context.Reference` rather than a `Context.Service`.
 *
 * A `Reference` has a default, which makes reading it **total**: no failure
 * channel, and `Reference<S> extends Service<never, S>`, so installing one
 * widens nothing. That is what lets devtools be merged into an existing root
 * layer without moving `RootR` and therefore without touching a single
 * `component(bp)` call — the property the entire install story rests on, and
 * the reason this is not a plain `Service` that a store would have to check for.
 */
export declare const Devtools: Context.Reference<DevtoolsSink>;

/**
 * Install a sink at the root.
 *
 * `Layer<never>` — no requirements, no error channel — so
 * `Layer.mergeAll(AppLayer, devtoolsLayer(sink))` types as `AppLayer` does, and
 * a `import.meta.env.DEV ? devtoolsLayer(…) : Layer.empty` ternary has one type
 * on both branches.
 */
export declare const devtoolsLayer: (sink: DevtoolsSink) => Layer.Layer<never>;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Drop an ambient transition that changed nothing. **The console default.**
 *
 * Ambient means `PropsChanged` and `HookChanged` — the two the feature did not
 * ask for. Those are the log's real noise floor: not the ones this library
 * fires (props are compared **by value** via `Schema.toEquivalence`, so an
 * unchanged parent re-render folds nothing at all), but the ones whose handler
 * looks at a changed input and legitimately decides to do nothing.
 *
 * Everything else stays, including the two cases {@link skipUnchanged} would
 * wrongly eat: `Unmounted`, whose returned state is discarded by design so
 * `previous === next` always, and a dispatch that deliberately no-ops — often
 * the exact thing the log was opened to see.
 */
export declare const skipUnchangedAmbient: (event: DevtoolsEvent) => boolean;

/**
 * Drop **any** transition where state did not move, whatever caused it.
 *
 * Blunter than {@link skipUnchangedAmbient} and not the default, for the
 * reasons given there. Exported because a feature whose reducer no-ops on most
 * actions has a different noise problem, and this is the one line that fixes it.
 */
export declare const skipUnchanged: (event: DevtoolsEvent) => boolean;

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * An in-memory sink, for asserting on the event stream in a test.
 *
 * `events` is the array as it grows, so a test reads it after the fact rather
 * than subscribing. That is the right shape here precisely because emission is
 * synchronous: by the time `await Effect.runPromise(…)` returns, everything
 * that was going to be emitted has been.
 */
export interface DevtoolsRecorder {
  readonly sink: DevtoolsSink;
  /** Every event, in emission order. */
  readonly events: ReadonlyArray<DevtoolsEvent>;
  readonly clear: () => void;
}

/** Build a fresh {@link DevtoolsRecorder}. */
export declare const createRecorder: () => DevtoolsRecorder;

// ---------------------------------------------------------------------------
// Console logger
// ---------------------------------------------------------------------------

/**
 * The console methods the logger uses, as an injectable interface.
 *
 * Injectable so the logger's own tests assert on calls rather than on whatever
 * the test runner did with `globalThis.console` — and so a non-browser host
 * that has no `group` can supply something that works instead of crashing the
 * program it was watching.
 */
export interface DevtoolsConsole {
  readonly group: (...args: ReadonlyArray<unknown>) => void;
  readonly groupCollapsed: (...args: ReadonlyArray<unknown>) => void;
  readonly groupEnd: () => void;
  readonly log: (...args: ReadonlyArray<unknown>) => void;
  readonly error: (...args: ReadonlyArray<unknown>) => void;
}

/**
 * CSS colours for the `%c` directives, all optional and individually
 * overridable. The defaults are redux-logger's, because a reader who has seen
 * one of these logs before should not have to learn a second palette.
 */
export interface DevtoolsColors {
  readonly previous?: string;
  readonly action?: string;
  readonly next?: string;
  readonly command?: string;
  readonly output?: string;
  readonly defect?: string;
}

/** Options for {@link createConsoleDevtools}. Every field has a default. */
export interface ConsoleDevtoolsOptions {
  /** `groupCollapsed` rather than `group`. Default `true`. */
  readonly collapsed?: boolean;
  /** Keep the event? Default {@link skipUnchangedAmbient}. */
  readonly predicate?: (event: DevtoolsEvent) => boolean;
  /**
   * Print a **shallow, own-keys** diff of the two states. Default `false`.
   *
   * Shallow deliberately: deep-diffing an unknown state is unbounded work on a
   * value this library does not own, which is the same argument the hooks
   * equivalence already makes about comparing them.
   */
  readonly diff?: boolean;
  /** Wall-clock stamp and elapsed-since-last figure. Default `true`. */
  readonly timestamps?: boolean;
  readonly colors?: DevtoolsColors;
  /** Default `globalThis.console`. */
  readonly console?: DevtoolsConsole;
}

/**
 * A redux-logger-style sink: one collapsed group per event, showing prev state,
 * action, next state and cause.
 *
 * ```text
 * ▸ cart#1  Bump  @ 12:34:56.789  (+412ms)
 *     prev state   { count: 0 }
 *     action       { _tag: "Bump" }
 *     next state   { count: 1 }
 *     cause        { _tag: "Dispatch" }
 * ▸ cart#1  ⟶ Bump  batch(cancel(Bump), keyed(q, effect))
 * ▸ cart#1  ⇢ OrderPlaced
 * ▸ cart#1  ✖ CheckoutRequested: network down (unhandled)
 * ```
 *
 * `groupEnd` runs in a `finally`. One throw inside a group body — a getter on
 * user state, a circular structure — would otherwise leave the group open and
 * permanently indent every subsequent console line on the page, long after the
 * feature that caused it unmounted.
 */
export declare const createConsoleDevtools: (options?: ConsoleDevtoolsOptions) => DevtoolsSink;

/**
 * {@link createConsoleDevtools} as a layer — the one-liner an app installs.
 *
 * ```ts
 * const { Provider, component } = createRuntime(
 *   Layer.mergeAll(AppLayer, import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty),
 * );
 * ```
 */
export declare const consoleDevtoolsLayer: (options?: ConsoleDevtoolsOptions) => Layer.Layer<never>;
