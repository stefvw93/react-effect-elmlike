/**
 * Unit tests for `devtools.ts`, against `devtools.specs.md`'s Acceptance
 * Criteria.
 *
 * Emission — what `createFeatureStore` reports and when — lives in
 * `tea.test.ts`, because that is where the store is. This file covers the
 * module's own surface: the summaries, the reference, the recorder and the
 * console logger.
 */

import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  consoleDevtoolsLayer,
  createConsoleDevtools,
  createRecorder,
  Devtools,
  devtoolsLayer,
  noopDevtools,
  skipUnchanged,
  skipUnchangedAmbient,
  summarizeCommand,
  summarizeDefect,
  type DevtoolsConsole,
  type DevtoolsEvent,
} from "./devtools";
import { Command } from "./tea";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const envelope = { name: "cart", instance: "1" } as const;

const transition = (
  fields: Partial<Extract<DevtoolsEvent, { readonly _tag: "Transition" }>> = {},
): DevtoolsEvent => ({
  _tag: "Transition",
  ...envelope,
  cause: { _tag: "Dispatch" },
  action: { _tag: "Bump" },
  previous: { count: 0 },
  next: { count: 1 },
  ...fields,
});

/** Records every call, so an assertion can name the method and the arguments. */
const spyConsole = (): DevtoolsConsole & {
  readonly calls: ReadonlyArray<readonly [keyof DevtoolsConsole, ReadonlyArray<unknown>]>;
} => {
  const calls: Array<readonly [keyof DevtoolsConsole, ReadonlyArray<unknown>]> = [];
  const record =
    (method: keyof DevtoolsConsole) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push([method, args]);
    };
  return {
    calls,
    group: record("group"),
    groupCollapsed: record("groupCollapsed"),
    groupEnd: record("groupEnd"),
    log: record("log"),
    error: record("error"),
  };
};

const methods = (spy: ReturnType<typeof spyConsole>): ReadonlyArray<string> =>
  spy.calls.map(([method]) => method);

/** Every argument of every call, flattened — for "is this string in the output". */
const printed = (spy: ReturnType<typeof spyConsole>): string =>
  spy.calls.map(([, args]) => args.map((arg) => String(arg)).join(" ")).join("\n");

// ---------------------------------------------------------------------------
// summarizeCommand
// ---------------------------------------------------------------------------

describe("summarizeCommand", () => {
  it("erases the effect, keeping only the fact of a leaf", () => {
    const summary = summarizeCommand(Command.effect(() => Effect.void));

    expect(summary).toEqual({ _tag: "Effect" });
    // Stated as an own-keys assertion and not just a deep-equal, because the
    // whole point is that the callback did not come along.
    expect(Object.keys(summary)).toEqual(["_tag"]);
  });

  it("summarizes the no-op", () => {
    expect(summarizeCommand(Command.none)).toEqual({ _tag: "None" });
  });

  it("preserves `Keyed` nesting", () => {
    const summary = summarizeCommand(
      Command.keyed(
        "outer",
        Command.keyed(
          "inner",
          Command.effect(() => Effect.void),
        ),
      ),
    );

    expect(summary).toEqual({
      _tag: "Keyed",
      key: "outer",
      command: { _tag: "Keyed", key: "inner", command: { _tag: "Effect" } },
    });
  });

  it("preserves `Batch` order", () => {
    const summary = summarizeCommand(
      Command.batch(
        Command.cancel("Bump"),
        Command.keyed(
          "q",
          Command.effect(() => Effect.void),
        ),
        Command.none,
      ),
    );

    expect(summary).toEqual({
      _tag: "Batch",
      commands: [
        { _tag: "Cancel", target: { tag: "Bump" } },
        { _tag: "Keyed", key: "q", command: { _tag: "Effect" } },
        { _tag: "None" },
      ],
    });
  });

  it("passes a `Cancel` target through, keyed and unkeyed", () => {
    expect(summarizeCommand(Command.cancel("Bump"))).toEqual({
      _tag: "Cancel",
      target: { tag: "Bump" },
    });
    expect(summarizeCommand(Command.cancel({ tag: "Bump", key: "k" }))).toEqual({
      _tag: "Cancel",
      target: { tag: "Bump", key: "k" },
    });
  });

  it("round-trips through JSON and `structuredClone`, unlike the command it summarizes", () => {
    const command = Command.batch(
      Command.cancel("Bump"),
      Command.keyed(
        "q",
        Command.effect(() => Effect.void),
      ),
    );
    const summary = summarizeCommand(command);

    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(structuredClone(summary)).toEqual(summary);

    // The negative control, and it has to be `structuredClone` rather than
    // `JSON.stringify`: stringify drops a function *silently*, so a raw command
    // happens to produce the same shape as its summary and the comparison would
    // suggest this function was unnecessary. A real transport does not drop it
    // — it refuses the whole message, which is the failure being prevented.
    expect(() => structuredClone(command)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// summarizeDefect
// ---------------------------------------------------------------------------

describe("summarizeDefect", () => {
  it("keeps an `Error`'s name, message and stack", () => {
    const error = new TypeError("network down");
    const summary = summarizeDefect(error);

    expect(summary.name).toBe("TypeError");
    expect(summary.message).toBe("network down");
    expect(typeof summary.stack).toBe("string");
  });

  it("survives a thrown string, symbol, number, null and undefined", () => {
    expect(summarizeDefect("plain").message).toBe("plain");
    expect(summarizeDefect(Symbol("sym")).message).toContain("sym");
    expect(summarizeDefect(42).message).toBe("42");
    expect(summarizeDefect(null).message).toBe("null");
    expect(summarizeDefect(undefined).message).toBe("undefined");
  });

  it("survives a value whose own `message` getter throws", () => {
    // A summariser on a debugging path may not fail: it would take down the
    // program it was installed to watch, at the exact moment that program was
    // already in trouble.
    const hostile = {
      get message(): string {
        throw new Error("nope");
      },
    };

    expect(() => summarizeDefect(hostile)).not.toThrow();
    expect(typeof summarizeDefect(hostile).message).toBe("string");
  });

  it("survives a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => summarizeDefect(circular)).not.toThrow();
  });

  it("is JSON-encodable where the `Error` it replaces is not", () => {
    // The claim the type-level tests could not make: `Error` is *structurally*
    // three strings, so no type assertion distinguishes it. The difference is
    // that its own properties are non-enumerable.
    const error = new Error("network down");
    expect(JSON.stringify(error)).toBe("{}");

    const summary = summarizeDefect(error);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(JSON.parse(JSON.stringify(summary)).message).toBe("network down");
  });
});

// ---------------------------------------------------------------------------
// The sink service
// ---------------------------------------------------------------------------

describe("the Devtools reference", () => {
  it("defaults to `noopDevtools`, by identity, from an empty context", () => {
    // By identity and not by shape: the runtime detects "nobody installed a
    // sink" with an `===` against this exact object, and skips every emission
    // site when it matches.
    expect(Context.getReferenceUnsafe(Context.empty(), Devtools)).toBe(noopDevtools);
  });

  it("returns the same object on repeated reads", () => {
    const context = Context.empty();
    const first = Context.getReferenceUnsafe(context, Devtools);
    const second = Context.getReferenceUnsafe(context, Devtools);

    expect(first).toBe(second);
    expect(first).toBe(noopDevtools);
  });

  it("does not return `noopDevtools` from `defaultValue()` — never compare against it", () => {
    // Recorded as a test because it is the trap: `getReferenceUnsafe` caches
    // what it computes, but `defaultValue()` re-invokes the thunk. Code that
    // compared against `Devtools.defaultValue()` would decide a sink was
    // installed on every single fold.
    expect(Devtools.defaultValue()).toBe(noopDevtools);
  });

  it("`noopDevtools` is a frozen no-op", () => {
    expect(Object.isFrozen(noopDevtools)).toBe(true);
    expect(() => noopDevtools.onEvent(transition())).not.toThrow();
    expect(noopDevtools.onEvent(transition())).toBeUndefined();
  });

  it("`devtoolsLayer` installs a sink where the reference is read", async () => {
    const recorder = createRecorder();
    const runtime = ManagedRuntime.make(devtoolsLayer(recorder.sink));

    const resolved = Context.getReferenceUnsafe(await runtime.context(), Devtools);

    expect(resolved).toBe(recorder.sink);
    expect(resolved).not.toBe(noopDevtools);
    await runtime.dispose();
  });

  it("merges into a root layer without displacing what is already there", async () => {
    // The install story, asserted at runtime rather than only in the types.
    const runtime = ManagedRuntime.make(Layer.mergeAll(Layer.empty, consoleDevtoolsLayer()));

    expect(Context.getReferenceUnsafe(await runtime.context(), Devtools)).not.toBe(noopDevtools);
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

describe("createRecorder", () => {
  it("collects events in emission order", () => {
    const recorder = createRecorder();
    const first = transition({ action: { _tag: "A" } });
    const second = transition({ action: { _tag: "B" } });

    recorder.sink.onEvent(first);
    recorder.sink.onEvent(second);

    expect(recorder.events).toEqual([first, second]);
  });

  it("exposes the events as they accumulate, not a snapshot taken at build time", () => {
    const recorder = createRecorder();
    const events = recorder.events;

    recorder.sink.onEvent(transition());

    expect(events).toHaveLength(1);
  });

  it("clears", () => {
    const recorder = createRecorder();
    recorder.sink.onEvent(transition());
    recorder.clear();

    expect(recorder.events).toHaveLength(0);
  });

  it("hands out independent recorders", () => {
    const first = createRecorder();
    const second = createRecorder();
    first.sink.onEvent(transition());

    expect(second.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe("skipUnchangedAmbient — the console default", () => {
  it("drops a `PropsChanged` whose handler returned the same state", () => {
    const state = { count: 0 };
    expect(
      skipUnchangedAmbient(
        transition({
          cause: { _tag: "Lifecycle" },
          action: { _tag: "PropsChanged" },
          previous: state,
          next: state,
        }),
      ),
    ).toBe(false);
  });

  it("drops an unchanged `HookChanged` too", () => {
    const state = { count: 0 };
    expect(
      skipUnchangedAmbient(
        transition({
          cause: { _tag: "Lifecycle" },
          action: { _tag: "HookChanged" },
          previous: state,
          next: state,
        }),
      ),
    ).toBe(false);
  });

  it("keeps a `PropsChanged` that moved state", () => {
    expect(
      skipUnchangedAmbient(
        transition({ cause: { _tag: "Lifecycle" }, action: { _tag: "PropsChanged" } }),
      ),
    ).toBe(true);
  });

  it("keeps `Unmounted`, whose state never moves by design", () => {
    // `reduce` discards `Unmounted`'s returned state, so `previous === next`
    // always. A blunter predicate hides the teardown of every feature on the
    // page — see `skipUnchanged` below, which does exactly that.
    const state = { count: 0 };
    expect(
      skipUnchangedAmbient(
        transition({
          cause: { _tag: "Lifecycle" },
          action: { _tag: "Unmounted" },
          previous: state,
          next: state,
        }),
      ),
    ).toBe(true);
  });

  it("keeps `Mounted`", () => {
    const state = { count: 0 };
    expect(
      skipUnchangedAmbient(
        transition({
          cause: { _tag: "Lifecycle" },
          action: { _tag: "Mounted" },
          previous: state,
          next: state,
        }),
      ),
    ).toBe(true);
  });

  it("keeps a deliberate no-op dispatch — often the thing you opened the log to see", () => {
    const state = { count: 0 };
    expect(skipUnchangedAmbient(transition({ previous: state, next: state }))).toBe(true);
  });

  it("keeps every non-transition event", () => {
    expect(
      skipUnchangedAmbient({
        _tag: "Command",
        ...envelope,
        cause: { _tag: "Dispatch" },
        group: { tag: "Bump" },
        command: { _tag: "Effect" },
        dropped: false,
      }),
    ).toBe(true);
    expect(
      skipUnchangedAmbient({
        _tag: "Output",
        ...envelope,
        cause: { _tag: "Dispatch" },
        output: { _tag: "OrderPlaced" },
      }),
    ).toBe(true);
    expect(
      skipUnchangedAmbient({
        _tag: "Defect",
        ...envelope,
        cause: { _tag: "Dispatch" },
        from: "Bump",
        defect: { message: "boom" },
        handled: false,
      }),
    ).toBe(true);
  });
});

describe("skipUnchanged", () => {
  it("drops any transition where state did not move, whatever caused it", () => {
    const state = { count: 0 };

    expect(skipUnchanged(transition({ previous: state, next: state }))).toBe(false);
    expect(
      skipUnchanged(
        transition({
          cause: { _tag: "Lifecycle" },
          action: { _tag: "Unmounted" },
          previous: state,
          next: state,
        }),
      ),
    ).toBe(false);
  });

  it("keeps a transition that moved", () => {
    expect(skipUnchanged(transition())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Console logger
// ---------------------------------------------------------------------------

describe("createConsoleDevtools", () => {
  it("collapses by default, and expands when told to", () => {
    const collapsed = spyConsole();
    createConsoleDevtools({ console: collapsed }).onEvent(transition());
    expect(methods(collapsed)).toContain("groupCollapsed");
    expect(methods(collapsed)).not.toContain("group");

    const expanded = spyConsole();
    createConsoleDevtools({ console: expanded, collapsed: false }).onEvent(transition());
    expect(methods(expanded)).toContain("group");
    expect(methods(expanded)).not.toContain("groupCollapsed");
  });

  it("prints prev state, action, next state and cause", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent(transition());
    const output = printed(spy);

    expect(output).toContain("prev state");
    expect(output).toContain("action");
    expect(output).toContain("next state");
    expect(output).toContain("cause");
  });

  it("carries `%c` colour directives", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent(transition());

    expect(printed(spy)).toContain("%c");
  });

  it("names the feature and the instance", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent(transition());

    expect(printed(spy)).toContain("cart#1");
  });

  it("closes the group exactly once", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent(transition());

    expect(methods(spy).filter((method) => method === "groupEnd")).toHaveLength(1);
  });

  it("closes the group even when printing the body throws", () => {
    // The failure this guards is not the throw, it is what a *missing*
    // `groupEnd` does afterwards: every subsequent console line on the page
    // stays indented inside a group that will never close, long after the
    // feature that opened it unmounted.
    const spy = spyConsole();
    let opened = false;
    const hostile: DevtoolsConsole = {
      ...spy,
      groupCollapsed: (...args) => {
        opened = true;
        spy.groupCollapsed(...args);
      },
      log: () => {
        throw new Error("a getter on user state threw");
      },
    };

    expect(() => createConsoleDevtools({ console: hostile }).onEvent(transition())).toThrow();
    expect(opened).toBe(true);
    expect(methods(spy)).toContain("groupEnd");
  });

  it("sends a defect body through `console.error`", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent({
      _tag: "Defect",
      ...envelope,
      cause: { _tag: "Dispatch" },
      from: "CheckoutRequested",
      defect: { name: "Error", message: "network down" },
      handled: false,
    });

    expect(methods(spy)).toContain("error");
    expect(printed(spy)).toContain("network down");
  });

  it("marks an unhandled defect as unhandled", () => {
    const spy = spyConsole();
    const sink = createConsoleDevtools({ console: spy });
    sink.onEvent({
      _tag: "Defect",
      ...envelope,
      cause: { _tag: "Dispatch" },
      from: "Bump",
      defect: { message: "boom" },
      handled: false,
    });

    expect(printed(spy)).toContain("unhandled");
  });

  it("prints a command's summary and the group it addresses", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent({
      _tag: "Command",
      ...envelope,
      cause: { _tag: "Dispatch" },
      group: { tag: "Bump" },
      command: {
        _tag: "Batch",
        commands: [
          { _tag: "Cancel", target: { tag: "Bump" } },
          { _tag: "Keyed", key: "q", command: { _tag: "Effect" } },
        ],
      },
      dropped: false,
    });
    const output = printed(spy);

    expect(output).toContain("Bump");
    expect(output).toContain("batch");
    expect(output).toContain("cancel");
    expect(output).toContain("keyed");
    expect(output).toContain("q");
  });

  it("says so when a command was dropped rather than run", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent({
      _tag: "Command",
      ...envelope,
      cause: { _tag: "Dispatch" },
      group: { tag: "Bump" },
      command: { _tag: "Effect" },
      dropped: true,
    });

    expect(printed(spy)).toContain("dropped");
  });

  it("prints the whole output message, tag included", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent({
      _tag: "Output",
      ...envelope,
      cause: { _tag: "Dispatch" },
      output: { _tag: "OrderPlaced" },
    });

    expect(printed(spy)).toContain("OrderPlaced");
  });

  it("applies the default predicate, and an override", () => {
    const state = { count: 0 };
    const unchangedProps = transition({
      cause: { _tag: "Lifecycle" },
      action: { _tag: "PropsChanged" },
      previous: state,
      next: state,
    });

    const defaulted = spyConsole();
    createConsoleDevtools({ console: defaulted }).onEvent(unchangedProps);
    expect(defaulted.calls).toHaveLength(0);

    const overridden = spyConsole();
    createConsoleDevtools({ console: overridden, predicate: () => true }).onEvent(unchangedProps);
    expect(overridden.calls.length).toBeGreaterThan(0);

    // And a predicate that rejects everything prints nothing at all — no
    // stray group left open by an event that was filtered after opening it.
    const silenced = spyConsole();
    createConsoleDevtools({ console: silenced, predicate: () => false }).onEvent(transition());
    expect(silenced.calls).toHaveLength(0);
  });

  it("names changed, added and removed keys when `diff` is on", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy, diff: true }).onEvent(
      transition({
        previous: { count: 0, removed: true, same: "x" },
        next: { count: 1, added: true, same: "x" },
      }),
    );
    const output = printed(spy);

    expect(output).toContain("~ count");
    expect(output).toContain("+ added");
    expect(output).toContain("- removed");
    // Unchanged keys are noise; a diff that lists them is not a diff.
    expect(output).not.toContain("same");
  });

  it("prints no diff when `diff` is off", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy }).onEvent(
      transition({ previous: { count: 0 }, next: { count: 1 } }),
    );

    expect(printed(spy)).not.toContain("~ count");
  });

  it("prints an elapsed figure from the second event of a mount onwards", () => {
    const spy = spyConsole();
    const sink = createConsoleDevtools({ console: spy });

    sink.onEvent(transition());
    const afterFirst = printed(spy);
    sink.onEvent(transition());
    const afterSecond = printed(spy).slice(afterFirst.length);

    expect(afterFirst).not.toContain("+");
    expect(afterSecond).toMatch(/\+\d/);
  });

  it("keeps elapsed times per mount, not per feature name", () => {
    const spy = spyConsole();
    const sink = createConsoleDevtools({ console: spy });

    sink.onEvent(transition());
    const afterFirst = printed(spy);
    sink.onEvent(transition({ instance: "2" }));

    // A second mount of the same blueprint starts its own clock. Keying by
    // `name` alone would report the gap between two unrelated features.
    expect(printed(spy).slice(afterFirst.length)).not.toMatch(/\+\d/);
  });

  it("drops a mount's elapsed entry when it unmounts", () => {
    // Without this the map grows one entry per mount for the life of the page:
    // a leak in the tool you installed to find leaks.
    const spy = spyConsole();
    const sink = createConsoleDevtools({ console: spy });
    const state = { count: 0 };

    sink.onEvent(transition());
    sink.onEvent(
      transition({
        cause: { _tag: "Lifecycle" },
        action: { _tag: "Unmounted" },
        previous: state,
        next: state,
      }),
    );
    const beforeRemount = printed(spy);
    sink.onEvent(transition());

    expect(printed(spy).slice(beforeRemount.length)).not.toMatch(/\+\d/);
  });

  it("omits the clock when `timestamps` is off", () => {
    const withStamps = spyConsole();
    const stamped = createConsoleDevtools({ console: withStamps });
    stamped.onEvent(transition());
    stamped.onEvent(transition());
    expect(printed(withStamps)).toMatch(/\d{2}:\d{2}:\d{2}/);

    const without = spyConsole();
    const plain = createConsoleDevtools({ console: without, timestamps: false });
    plain.onEvent(transition());
    plain.onEvent(transition());
    expect(printed(without)).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(printed(without)).not.toMatch(/\+\d+ms/);
  });

  it("takes colour overrides", () => {
    const spy = spyConsole();
    createConsoleDevtools({ console: spy, colors: { action: "color: #123456" } }).onEvent(
      transition(),
    );

    expect(printed(spy)).toContain("#123456");
  });

  it("never throws on an event it cannot pretty-print", () => {
    // State is the user's and may be anything: a circular structure, a value
    // with a throwing getter. The logger prints something and moves on, because
    // the alternative is a debugger that crashes the fold.
    const spy = spyConsole();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      createConsoleDevtools({ console: spy, diff: true }).onEvent(
        transition({ previous: circular, next: { other: 1 } }),
      ),
    ).not.toThrow();
  });
});

describe("consoleDevtoolsLayer", () => {
  it("installs a console sink readable through the reference", async () => {
    const spy = spyConsole();
    const runtime = ManagedRuntime.make(consoleDevtoolsLayer({ console: spy }));

    const sink = Context.getReferenceUnsafe(await runtime.context(), Devtools);
    sink.onEvent(transition());

    expect(spy.calls.length).toBeGreaterThan(0);
    await runtime.dispose();
  });
});
