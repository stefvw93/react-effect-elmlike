/**
 * Devtools emission through the React binding, in a real browser.
 *
 * The node suite drives `createFeatureStore` directly and covers every
 * emission site. What it cannot cover is the thing this feature is installed
 * *into*: `sync` folding in the render body, `start` running in a passive
 * effect, an output crossing into a real `on<Tag>` prop, and a real click
 * driving the whole chain. Those orderings are the ones the design's riskiest
 * claim depends on — that the root context exists by the time `Mounted` folds —
 * and a store constructed by hand cannot reproduce them, because `component`
 * is what decides when `start` runs.
 */

import { Effect, Schema } from "effect";
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createRecorder, devtoolsLayer, type DevtoolsEvent } from "./devtools";
import { Action, Command, createRuntime, define } from "./tea";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recorder = createRecorder();
const { component } = createRuntime(devtoolsLayer(recorder.sink));

// ---------------------------------------------------------------------------
// A feature that does one of each: folds on props, runs a command, emits an
// output, and can be made to die on demand.
// ---------------------------------------------------------------------------

const Reached = Action.output("Reached", { at: Schema.Number });

const Counter = define({
  props: Schema.Struct({ step: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("Bumped", {}), Action("Landed", {}), Action("Boom", {})]),
  output: Action.of([Reached]),
});

const counter = Counter.create({
  initialState: (props) => ({ count: props.step }),
  reducer: {
    Bumped: (_action, { state }) => [
      { count: state.count + 1 },
      Command.keyed(
        "bump",
        Command.effect((dispatch) => dispatch({ _tag: "Landed" })),
      ),
    ],
    Landed: (_action, { state }) => [state, Command.output(Reached, { at: state.count })],
    Boom: (_action, { state }) => [state, Command.effect(() => Effect.die(new Error("kaboom")))],
    Error: (_action, { state }) => state,
    PropsChanged: (_action, { props }) => ({ count: props.step }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <span data-testid="count">{state.count}</span>
      <button data-testid="bump" onClick={() => dispatch({ _tag: "Bumped" })}>
        bump
      </button>
      <button data-testid="boom" onClick={() => dispatch({ _tag: "Boom" })}>
        boom
      </button>
    </div>
  ),
});

const CounterView = component(counter, { name: "counter" });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (element: React.ReactNode) => {
  recorder.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
};

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  recorder.clear();
});

const text = (testId: string) =>
  container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

const click = async (testId: string) => {
  const element = container?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  await act(async () => element?.click());
};

const tagged = <T extends DevtoolsEvent["_tag"]>(
  tag: T,
): ReadonlyArray<Extract<DevtoolsEvent, { readonly _tag: T }>> =>
  recorder.events.filter(
    (event): event is Extract<DevtoolsEvent, { readonly _tag: T }> => event._tag === tag,
  );

// ---------------------------------------------------------------------------

test("a real mount reports `Mounted` — the ordering the whole design rests on", async () => {
  // `start` runs in a passive effect and forks the root runtime immediately
  // before folding `Mounted`. If `cachedContext` were not populated by then,
  // this event would be missing and every log would silently begin one action
  // late. No hand-built store can check that: `component` owns when `start`
  // runs, and the effect scheduling is React's.
  await mount(<CounterView step={1} onReached={() => {}} />);

  await vi.waitFor(() => {
    const mounted = tagged("Transition").filter((event) => event.action._tag === "Mounted");
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.name).toBe("counter");
    expect(mounted[0]!.cause).toEqual({ _tag: "Lifecycle" });
  });
});

test("a real click reports the transition and the command it issued", async () => {
  await mount(<CounterView step={1} onReached={() => {}} />);
  await vi.waitFor(() => expect(text("count")).toBe("1"));
  recorder.clear();

  await click("bump");
  await vi.waitFor(() => expect(text("count")).toBe("2"));

  const bumped = tagged("Transition").find((event) => event.action._tag === "Bumped");
  expect(bumped!.cause).toEqual({ _tag: "Dispatch" });
  expect(bumped!.previous).toEqual({ count: 1 });
  expect(bumped!.next).toEqual({ count: 2 });

  const commands = tagged("Command");
  expect(commands).toHaveLength(1);
  expect(commands[0]!.dropped).toBe(false);
  expect(commands[0]!.command).toEqual({
    _tag: "Keyed",
    key: "bump",
    command: { _tag: "Effect" },
  });
});

test("an output crossing into a real `on<Tag>` prop is reported before the prop is called", async () => {
  // The ordering claim, through the actual React boundary rather than a stub
  // `emit`: the parent's handler is a plain callback into user code, and the
  // event has to be in the log before control leaves the runtime.
  const order: Array<string> = [];
  await mount(
    <CounterView
      step={1}
      onReached={() => {
        order.push("prop");
      }}
    />,
  );
  await vi.waitFor(() => expect(text("count")).toBe("1"));
  recorder.clear();

  await click("bump");

  await vi.waitFor(() => {
    expect(order).toEqual(["prop"]);
    const outputs = tagged("Output");
    expect(outputs).toHaveLength(1);
    // The whole message. The prop received `{ at: 2 }` with `_tag` stripped.
    expect(outputs[0]!.output).toEqual({ _tag: "Reached", at: 2 });

    // The two-hop chain, which is the thing `cause` exists to make readable:
    // the click folded `Bumped`, whose keyed command emitted `Landed`, whose
    // own — unkeyed — command emitted the output. So the output is attributed
    // to `Landed` and not to the click two hops back. A devtools UI walks
    // these edges; the runtime only ever states the one it can see.
    expect(outputs[0]!.cause).toEqual({ _tag: "Command", action: "Landed" });
    const landed = tagged("Transition").find((event) => event.action._tag === "Landed");
    expect(landed!.cause).toEqual({ _tag: "Command", action: "Bumped", key: "bump" });
  });
});

test("a props change folded during render is reported", async () => {
  // `sync` folds in the render body, which is the one emission site that runs
  // while React is rendering rather than from an event or an effect.
  const Parent = () => {
    const [step, setStep] = useState(1);
    return (
      <div>
        <button data-testid="grow" onClick={() => setStep(step + 1)}>
          grow
        </button>
        <CounterView step={step} onReached={() => {}} />
      </div>
    );
  };

  await mount(<Parent />);
  await vi.waitFor(() => expect(text("count")).toBe("1"));
  recorder.clear();

  await click("grow");
  await vi.waitFor(() => expect(text("count")).toBe("2"));

  const propsChanged = tagged("Transition").filter((event) => event.action._tag === "PropsChanged");
  expect(propsChanged).toHaveLength(1);
  expect(propsChanged[0]!.cause).toEqual({ _tag: "Lifecycle" });
  expect(propsChanged[0]!.next).toEqual({ count: 2 });
});

test("a dying command reports one defect and then the recovery fold", async () => {
  await mount(<CounterView step={1} onReached={() => {}} />);
  await vi.waitFor(() => expect(text("count")).toBe("1"));
  recorder.clear();

  await click("boom");

  await vi.waitFor(() => {
    const defects = tagged("Defect");
    expect(defects).toHaveLength(1);
    expect(defects[0]!.from).toBe("Boom");
    expect(defects[0]!.handled).toBe(true);
    expect(defects[0]!.defect.message).toContain("kaboom");

    const recovered = tagged("Transition").find((event) => event.action._tag === "Error");
    expect(recovered!.cause).toEqual({ _tag: "Defect", from: "Boom" });
  });
});

test("unmounting reports `Unmounted` and stops reporting", async () => {
  await mount(<CounterView step={1} onReached={() => {}} />);
  await vi.waitFor(() => expect(text("count")).toBe("1"));
  recorder.clear();

  await act(async () => root!.unmount());
  root = undefined;

  const unmounted = tagged("Transition").filter((event) => event.action._tag === "Unmounted");
  expect(unmounted).toHaveLength(1);
  expect(unmounted[0]!.cause).toEqual({ _tag: "Lifecycle" });
});

test("two mounts of one blueprint are distinguishable in the stream", async () => {
  // The reason `instance` exists: `name` is a *blueprint* name, so without it
  // two of the same feature are one indistinguishable interleaved log.
  await mount(
    <div>
      <CounterView step={1} onReached={() => {}} />
      <CounterView step={5} onReached={() => {}} />
    </div>,
  );

  await vi.waitFor(() => {
    const mounted = tagged("Transition").filter((event) => event.action._tag === "Mounted");
    expect(mounted).toHaveLength(2);
    expect(new Set(mounted.map((event) => event.instance)).size).toBe(2);
    expect(new Set(mounted.map((event) => event.name))).toEqual(new Set(["counter"]));
  });
});

test("StrictMode's double mount is visible as two instances, not one", async () => {
  // StrictMode double-invokes the `useState` initialiser that builds the
  // store, so an id is burned: ids are unique, not gapless. Asserting the
  // *observable* consequence rather than the counter — a log that showed one
  // instance here would be hiding a remount.
  await mount(
    <StrictMode>
      <CounterView step={1} onReached={() => {}} />
    </StrictMode>,
  );

  await vi.waitFor(() => {
    const mounted = tagged("Transition").filter((event) => event.action._tag === "Mounted");
    expect(mounted.length).toBeGreaterThanOrEqual(1);
    expect(mounted.every((event) => event.name === "counter")).toBe(true);
  });
});
