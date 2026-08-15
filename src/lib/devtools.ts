import { Context, Layer } from "effect";
import type { Command, Group } from "./tea";

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * Why the runtime folded the action it is reporting.
 *
 * Exactly four variants, so `cause` can be **required**: every emission site
 * inside the runtime knows its own cause. There is deliberately no `Output`
 * cause — what a parent did with an output happens in arbitrary user code the
 * runtime cannot observe. A devtools UI can infer that edge from an adjacent
 * {@link DevtoolsOutput}; the runtime will not assert it.
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
 */
export interface DevtoolsCommand extends DevtoolsEnvelope {
  readonly _tag: "Command";
  /**
   * The **tag-level** address of this work: `Command.cancel(group.tag)`
   * interrupts every fiber this command forks. Deliberately not an exact
   * `{ tag, key }` — a `Batch` can hold members under several keys, so no
   * single precise address exists in general. The keys are in `command`, on
   * each `Keyed` node.
   */
  readonly group: Group;
  readonly command: CommandSummary;
  /**
   * Nothing was there to take this work when it was offered — a command
   * dispatched after unmount is discarded silently by design, and the log
   * would otherwise show work being issued that never ran. `false` means
   * "handed to a live mount", not "ran to completion": a fiber can accept a
   * command and be torn down before interpreting it.
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
 * about. Every field is encodable: the two that were not — a `Command`'s
 * effect and a defect's `Error` — are erased into {@link CommandSummary} and
 * {@link DefectSummary}. So a sink can be a `postMessage` transport or a
 * replay log with no schema-aware serialiser in between.
 *
 * No timestamp: the sink is called synchronously at the emission point, so a
 * receiver that wants a clock has one, and every expected event in a test
 * stays a total literal.
 */
export type DevtoolsEvent = DevtoolsTransition | DevtoolsCommand | DevtoolsOutput | DevtoolsDefect;

// ---------------------------------------------------------------------------
// Encodable summaries
// ---------------------------------------------------------------------------

/**
 * A {@link Command} with its effect erased. The shape mirrors the ADT
 * one-for-one, minus the one field that cannot cross a `postMessage`: the
 * leaf's callback.
 */
export type CommandSummary =
  | { readonly _tag: "None" }
  /** The leaf. The effect itself is gone; only the fact of it remains. */
  | { readonly _tag: "Effect" }
  | { readonly _tag: "Keyed"; readonly key: string; readonly command: CommandSummary }
  | { readonly _tag: "Batch"; readonly commands: ReadonlyArray<CommandSummary> }
  | { readonly _tag: "Cancel"; readonly target: Group };

/**
 * An unknown thrown value, flattened to encodable strings — an `Error` itself
 * `JSON.stringify`s to `{}`. The cost: `stack` is a string, so the console
 * loses the browser's clickable frames.
 */
export interface DefectSummary {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Erase a command to its {@link CommandSummary}. Total: nesting and batch
 * order are preserved, and nothing about the input can make it throw — a
 * summariser that can fail is a debugger that breaks the program it watches.
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
      return { _tag: "None" };
  }
};

/**
 * Erase an unknown thrown value to its {@link DefectSummary}. `unknown`, not
 * `Error`: `throw` accepts anything, and every hostile shape produces a
 * summary rather than a second failure.
 */
export const summarizeDefect = (error: unknown): DefectSummary => {
  // The outer `try` is what makes this total. Everything in here can throw on
  // a hostile value: `typeof`-guarded reads may hit getters (`instanceof
  // Error` guarantees nothing — a subclass can define `message` or `stack` as
  // one), the type test itself throws for a revoked Proxy, and stringifying
  // invokes user `toString`. A summariser that added a second failure would
  // take down the program it was installed to explain.
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
 * **Synchronous, and that is the whole design constraint.** The store's fold
 * is a plain function; a sink returning an `Effect` would put a fiber and a
 * scheduler hop on the hottest path, and the log could land after the state
 * it describes had moved on. One method, so an implementation is a literal.
 */
export interface DevtoolsSink {
  readonly onEvent: (event: DevtoolsEvent) => void;
}

/**
 * The default sink: does nothing, and is the signal that nobody installed one.
 *
 * A frozen module constant, not a fresh object per read — the runtime detects
 * "no devtools" by comparing the resolved reference against **this exact
 * value** by identity, and `Devtools.defaultValue()` re-invokes its thunk on
 * every call. The constant is the invariant, not an optimisation.
 */
export const noopDevtools: DevtoolsSink = Object.freeze({
  onEvent: () => {},
});

/**
 * The service key, as a `Context.Reference` rather than a `Context.Service`:
 * a `Reference` has a default, so reading it is total and installing one
 * widens nothing (`Reference<S> extends Service<never, S>`). That is what lets
 * devtools merge into an existing root layer without moving `RootR` or
 * touching a single `component(bp)` call.
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
 * Drop an ambient (`PropsChanged`/`HookChanged`) transition that changed
 * nothing. **The console default.** Everything else stays, including the two
 * cases {@link skipUnchanged} would wrongly eat: `Unmounted`, whose returned
 * state is discarded by design so `previous === next` always, and a dispatch
 * that deliberately no-ops — often the exact thing the log was opened to see.
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
 * An in-memory sink, for asserting on the event stream in a test. `events` is
 * the live array as it grows — emission is synchronous, so by the time a test
 * awaits its effect, everything that was going to be emitted has been.
 */
export interface DevtoolsRecorder {
  readonly sink: DevtoolsSink;
  /** Every event, in emission order. */
  readonly events: ReadonlyArray<DevtoolsEvent>;
  readonly clear: () => void;
}

/** Build a fresh {@link DevtoolsRecorder}. */
export const createRecorder = (): DevtoolsRecorder => {
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
 * The console methods the logger uses, injectable so the logger's tests are
 * deterministic and a host without `group` can supply a replacement.
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

  // The defused report for the sink's own failures. If the console itself is
  // broken too, there is nothing left to report with.
  const reportError = (label: string, error: unknown): void => {
    try {
      output.error(`%c${label}`, palette.defect, error);
    } catch {
      // Nothing left to report it with.
    }
  };

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
        reportError("devtools predicate threw", error);
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

      // Called through `output` so unbound console methods keep their receiver.
      const line = `%c${headline(event)}${stamp}`;
      if (collapsed) output.groupCollapsed(line, palette.header);
      else output.group(line, palette.header);

      // `finally` keeps the group balanced; the `catch` keeps the sink alive.
      // Printing reads user state, so a throw here is a property of one value,
      // not of the sink — escaping would reach the store's disable-on-throw
      // rule and take devtools dark for the page. Reported through `error`
      // rather than swallowed, so a genuine logger bug stays visible.
      try {
        body(event, { output, palette, diff });
      } catch (error) {
        reportError("devtools could not print this event", error);
      } finally {
        output.groupEnd();
        if (unmounting) lastSeen.delete(key);
      }

      // Bounded: a mount whose fiber died never folds `Unmounted`, so a page
      // churning through such mounts would grow this map without limit.
      // Clearing wholesale only costs the next event per mount its elapsed
      // figure.
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
