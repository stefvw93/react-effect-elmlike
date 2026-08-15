import { Context, Layer } from "effect";
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
  /**
   * The **tag-level** address of this work: `Command.cancel(group.tag)`
   * interrupts every fiber this command forks.
   *
   * Tag-level and not the exact `{ tag, key }`, deliberately. A `Batch` can
   * hold members under several different keys, so there is no single precise
   * address for one command in general — and reporting a precise one whenever
   * it happened to exist would make the field mean different things on
   * different events. The keys are still in `command`, on each `Keyed` node,
   * and an action a keyed command dispatches carries its own key in `cause`.
   */
  readonly group: Group;
  readonly command: CommandSummary;
  /**
   * Nothing was there to take this work when it was offered.
   *
   * Answers what the runtime can know **at the offer**, which is whether a
   * mount was draining the queue. It is not a promise that accepted work
   * necessarily ran: a fiber can accept a command and then be torn down before
   * interpreting it — teardown exceeding its bound is the real case — and a
   * synchronous event emitted at the offer cannot be revised afterwards. So
   * `false` means "handed to a live mount", not "ran to completion".
   */
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
export const summarizeCommand = (command: Command<any, any>): CommandSummary => {
  switch (command._tag) {
    case "None":
      return { _tag: "None" };
    case "Effect":
      return { _tag: "Effect" };
    case "Keyed":
      return { _tag: "Keyed", key: command.key, command: summarizeCommand(command.command) };
    case "Batch":
      return { _tag: "Batch", commands: command.commands.map(summarizeCommand) };
    case "Cancel":
      return { _tag: "Cancel", target: command.target };
    default:
      // Unreachable through the typed surface, and deliberately not a throw.
      // The parameter is `Command<any, any>`; a caller that got there by
      // bypassing the types is already in trouble, and a summariser that
      // crashed would turn a debugging aid into the cause of the crash.
      return { _tag: "None" };
  }
};

/**
 * Erase an unknown thrown value to its {@link DefectSummary}.
 *
 * `unknown` and not `Error` because `throw` accepts anything: a string, a
 * symbol, `undefined`, an object with a throwing `message` getter. Every one of
 * those produces a summary rather than a second failure.
 */
export const summarizeDefect = (error: unknown): DefectSummary => {
  // Total, and the outer `try` is what finally makes that true rather than
  // aspirational. Three separate things in here can throw on a sufficiently
  // hostile value, and each was found by trying it rather than by reasoning:
  //
  //   - `instanceof` invokes `getPrototypeOf`, which throws for a **revoked
  //     Proxy**. So even the type test is unsafe, which is why it is inside.
  //   - A property read may be a getter. `instanceof Error` is no guarantee
  //     otherwise: a subclass can define `message` or `stack` as one, and a
  //     library error that formats its message lazily from state that has
  //     since been torn down does exactly that.
  //   - Stringifying invokes `toString` or `Symbol.toPrimitive`.
  //
  // The value reaching here is already a defect, usually from a fold that is
  // going wrong. A summariser that added a second failure on top would take
  // down the program it was installed to explain.
  try {
    if (typeof error === "object" && error !== null) {
      const message = field(error, "message");
      if (typeof message === "string") {
        const name = field(error, "name");
        const stack = field(error, "stack");
        return {
          message,
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof stack === "string" ? { stack } : {}),
        };
      }
    }

    return { message: stringify(error) };
  } catch {
    return { message: "<unsummarizable defect>" };
  }
};

/** One property read, defused. Absent and unreadable collapse to the same thing. */
const field = (source: object, key: "message" | "name" | "stack"): unknown => {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

/**
 * `String(value)`, defused: a user-written `toString` or `Symbol.toPrimitive`
 * can throw for any reason at all. (`String()` handles symbols itself — only
 * implicit conversion throws on them.)
 */
const stringify = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
};

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
 * default it computes, so repeated reads are identity-stable either way — but
 * `Devtools.defaultValue()` re-invokes the thunk, and a thunk returning a fresh
 * literal would hand back a different object every call and make every store
 * conclude a sink was installed. Returning this constant is what keeps that
 * safe, so the constant is the invariant, not an optimisation.
 */
export const noopDevtools: DevtoolsSink = Object.freeze({
  onEvent: () => {},
});

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
export const Devtools: Context.Reference<DevtoolsSink> = Context.Reference<DevtoolsSink>(
  "@tea/Devtools",
  { defaultValue: () => noopDevtools },
);

/**
 * Install a sink at the root.
 *
 * `Layer<never>` — no requirements, no error channel — so
 * `Layer.mergeAll(AppLayer, devtoolsLayer(sink))` types as `AppLayer` does, and
 * a `import.meta.env.DEV ? devtoolsLayer(…) : Layer.empty` ternary has one type
 * on both branches.
 */
export const devtoolsLayer = (sink: DevtoolsSink): Layer.Layer<never> =>
  Layer.succeed(Devtools)(sink);

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
export const skipUnchangedAmbient = (event: DevtoolsEvent): boolean =>
  !(
    event._tag === "Transition" &&
    (event.action._tag === "PropsChanged" || event.action._tag === "HookChanged") &&
    event.previous === event.next
  );

/**
 * Drop **any** transition where state did not move, whatever caused it.
 *
 * Blunter than {@link skipUnchangedAmbient} and not the default, for the
 * reasons given there. Exported because a feature whose reducer no-ops on most
 * actions has a different noise problem, and this is the one line that fixes it.
 */
export const skipUnchanged = (event: DevtoolsEvent): boolean =>
  !(event._tag === "Transition" && event.previous === event.next);

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
export const createRecorder = (): DevtoolsRecorder => {
  // One array, handed out as-is rather than copied on read. A caller that took
  // a reference before the first event still sees them arrive, which is what
  // makes `const { events } = createRecorder()` at the top of a test work.
  const events: Array<DevtoolsEvent> = [];

  return {
    sink: { onEvent: (event) => void events.push(event) },
    events,
    clear: () => {
      events.length = 0;
    },
  };
};

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
export const createConsoleDevtools = (options: ConsoleDevtoolsOptions = {}): DevtoolsSink => {
  const {
    collapsed = true,
    predicate = skipUnchangedAmbient,
    diff = false,
    timestamps = true,
    colors,
    console: output = globalThis.console,
  } = options;

  const palette = { ...defaultColors, ...colors };

  /**
   * Last print time per mount, for the elapsed figure.
   *
   * Keyed by `name#instance` and not by `name`: two mounts of one blueprint
   * each have their own clock, and sharing one would report the gap between
   * two unrelated features as if it were a reducer's duration.
   */
  const lastSeen = new Map<string, number>();

  return {
    onEvent: (event) => {
      const key = `${event.name}#${event.instance}`;
      // Both terminal events a `stop()` emits: the `Unmounted` transition and
      // the teardown command that follows it. The command must evict too, or
      // it re-inserts the entry the transition just removed.
      const unmounting =
        (event._tag === "Transition" && event.action._tag === "Unmounted") ||
        (event._tag === "Command" && event.group.tag === "Unmounted");

      // The predicate is user code reading user state, so a throw is a
      // property of one value, not of the sink. Escaping would reach the
      // store's disable-on-throw rule and take devtools dark for the rest of
      // the page — keep the event and report instead.
      let keep = true;
      try {
        keep = predicate(event);
      } catch (error) {
        try {
          output.error("%cdevtools predicate threw", palette.defect, error);
        } catch {
          // The console itself is broken. Nothing left to report it with.
        }
      }

      if (!keep) {
        // Still forget the mount. A custom predicate that filtered `Unmounted`
        // would otherwise leak one map entry per mount for the life of the
        // page — a leak in the tool installed to find leaks.
        if (unmounting) lastSeen.delete(key);
        return;
      }

      const now = timestamps ? performance.now() : undefined;
      const previous = now === undefined ? undefined : lastSeen.get(key);
      if (now !== undefined) lastSeen.set(key, now);

      const stamp =
        now === undefined
          ? ""
          : `  @ ${clock()}${previous === undefined ? "" : `  (+${Math.round(now - previous)}ms)`}`;

      // Called through `output`, not through a hoisted reference to the
      // method: `const open = output.group` loses the receiver, and a console
      // implementation whose methods are not pre-bound — which the global one
      // is not obliged to be — would throw on the first event.
      const line = `%c${headline(event)}${stamp}`;
      if (collapsed) output.groupCollapsed(line, palette.header);
      else output.group(line, palette.header);

      // Caught, not merely `finally`'d, and the two do different jobs.
      //
      // `finally` is what keeps the group balanced: one throw with an open
      // group indents every later console line on the page, long after the
      // feature that opened it unmounted.
      //
      // The `catch` is what keeps this sink *alive*. Printing reads user state
      // — a getter, a Proxy, a `toString` — so a throw here is a property of
      // one value, not of the sink. Letting it escape would reach `report` in
      // the store, whose disable rule is justified by "a sink that threw once
      // will throw on every fold", and that premise is exactly what does not
      // hold for a value-dependent failure: devtools would go dark for the
      // rest of the page because one state object was hostile. Reported
      // through `error` rather than swallowed, so a genuine bug in here is
      // still visible.
      try {
        body(event, { output, palette, diff });
      } catch (error) {
        try {
          output.error("%cdevtools could not print this event", palette.defect, error);
        } catch {
          // The console itself is broken. Nothing left to report it with.
        }
      } finally {
        output.groupEnd();
        if (unmounting) lastSeen.delete(key);
      }

      // Bounded, because the only other thing that removes an entry is an
      // `Unmounted` transition — and a mount whose fiber died never folds one,
      // so a page that churns through such mounts would grow this map without
      // limit. Clearing wholesale rather than evicting one entry: the map
      // holds a debugging nicety, and the cost of losing it is that the next
      // event per mount prints no elapsed figure.
      if (lastSeen.size > 512) lastSeen.clear();
    },
  };
};

const defaultColors: Required<DevtoolsColors> & { readonly header: string } = {
  header: "color: inherit; font-weight: bold",
  previous: "color: #9E9E9E; font-weight: bold",
  action: "color: #03A9F4; font-weight: bold",
  next: "color: #4CAF50; font-weight: bold",
  command: "color: #9C27B0; font-weight: bold",
  output: "color: #009688; font-weight: bold",
  defect: "color: #F20404; font-weight: bold",
};

/** `12:34:56.789`, local time. Cheap enough to build per printed event. */
const clock = (): string => {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3,
  )}`;
};

/** The one line that shows when the group is collapsed, so it carries the news. */
const headline = (event: DevtoolsEvent): string => {
  const who = `▸ ${event.name}#${event.instance}`;
  switch (event._tag) {
    case "Transition":
      return `${who}  ${event.action._tag}`;
    case "Command":
      return `${who}  ⟶ ${address(event.group)}  ${formatCommand(event.command)}${
        event.dropped ? "  (dropped)" : ""
      }`;
    case "Output":
      return `${who}  ⇢ ${event.output._tag}`;
    case "Defect":
      return `${who}  ✖ ${event.from}: ${event.defect.message}${
        event.handled ? "" : " (unhandled)"
      }`;
  }
};

const body = (
  event: DevtoolsEvent,
  context: {
    readonly output: DevtoolsConsole;
    readonly palette: Required<DevtoolsColors> & { readonly header: string };
    readonly diff: boolean;
  },
): void => {
  const { output, palette } = context;
  switch (event._tag) {
    case "Transition": {
      output.log("%cprev state  ", palette.previous, event.previous);
      output.log("%caction      ", palette.action, event.action);
      output.log("%cnext state  ", palette.next, event.next);
      output.log("%ccause       ", palette.header, event.cause);
      if (context.diff) printDiff(event.previous, event.next, output, palette);
      return;
    }
    case "Command": {
      output.log("%ccommand     ", palette.command, formatCommand(event.command));
      output.log("%cgroup       ", palette.command, address(event.group));
      output.log("%ccause       ", palette.header, event.cause);
      return;
    }
    case "Output": {
      output.log("%coutput      ", palette.output, event.output);
      output.log("%ccause       ", palette.header, event.cause);
      return;
    }
    case "Defect": {
      // `error`, not `log`: a defect belongs in the console's error channel,
      // where a filter set to errors-only still shows it.
      output.error("%cdefect      ", palette.defect, event.defect);
      output.log("%ccause       ", palette.header, event.cause);
      return;
    }
  }
};

/**
 * A shallow, own-keys diff.
 *
 * Values are passed to the console as *arguments* rather than interpolated, so
 * a circular structure is the console's problem to render. A throwing getter,
 * read here by the comparison itself, aborts the diff and is caught by the
 * body's guard in `onEvent`.
 */
const printDiff = (
  previous: unknown,
  next: unknown,
  output: DevtoolsConsole,
  palette: Required<DevtoolsColors> & { readonly header: string },
): void => {
  if (!isRecord(previous) || !isRecord(next)) return;

  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(next, key)) output.log(`%c- ${key}`, palette.previous);
    else if (!Object.is(previous[key], next[key])) {
      output.log(`%c~ ${key}`, palette.action, previous[key], "→", next[key]);
    }
  }
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(previous, key)) output.log(`%c+ ${key}`, palette.next, next[key]);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `Bump` or `Bump#key` — how a `Cancel` would name this work. */
const address = (group: Group): string =>
  group.key === undefined ? group.tag : `${group.tag}#${group.key}`;

/** `batch(cancel(Bump), keyed(q, effect))` — the reducer's own shape, in one line. */
const formatCommand = (summary: CommandSummary): string => {
  switch (summary._tag) {
    case "None":
      return "none";
    case "Effect":
      return "effect";
    case "Keyed":
      return `keyed(${summary.key}, ${formatCommand(summary.command)})`;
    case "Batch":
      return `batch(${summary.commands.map(formatCommand).join(", ")})`;
    case "Cancel":
      return `cancel(${address(summary.target)})`;
  }
};

/**
 * {@link createConsoleDevtools} as a layer — the one-liner an app installs.
 *
 * ```ts
 * const { Provider, component } = createRuntime(
 *   Layer.mergeAll(AppLayer, import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty),
 * );
 * ```
 */
export const consoleDevtoolsLayer = (options?: ConsoleDevtoolsOptions): Layer.Layer<never> =>
  devtoolsLayer(createConsoleDevtools(options));
