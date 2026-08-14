/**
 * The React binding, in a real browser.
 *
 * The node suite drives `createFeatureStore` directly and covers the fold,
 * routing, lifecycle ordering and store lifetime — none of which needs a DOM.
 * What is left, and what only a browser can answer, is whether a blueprint
 * actually paints: that `render` reaches the document, that a dispatch from a
 * real click repaints, that an output crosses the boundary into a parent's
 * `on<Tag>` prop, and that a props change costs one render rather than two.
 */

import { Layer, Schema } from "effect";
import { Component, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { Action, Command, createRuntime, define } from "./tea";

// `act` needs this flag to actually batch; without it React warns and the
// "one render, not two" assertion below would pass for the wrong reason.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { component } = createRuntime(Layer.empty);

// ---------------------------------------------------------------------------
// A counter that announces when it crosses a threshold.
// ---------------------------------------------------------------------------

const Reached = Action.output("Reached", { at: Schema.Number });

const Counter = define({
  props: Schema.Struct({ step: Schema.Number, label: Schema.String }),
  state: Schema.Struct({ count: Schema.Number, renders: Schema.Number }),
  action: Action.of([Action("Bumped", {}), Action("Announce", {})]),
  output: Action.of([Reached]),
});

const counter = Counter.create({
  initialState: (props) => ({ count: props.step, renders: 0 }),
  reducer: {
    Bumped: (_action, { state, props }) => {
      const count = state.count + props.step;
      return count >= 10
        ? [{ ...state, count }, Command.output(Reached, { at: count })]
        : { ...state, count };
    },
    Announce: (_action, { state }) => [state, Command.output(Reached, { at: state.count })],
    // Whole-object, per the docs: this fires for any props change, and the
    // handler decides what it cares about.
    PropsChanged: (_action, { state, props }) => ({ ...state, count: props.step }),
  },
  render: ({ state, props, dispatch }) => (
    <div>
      <span data-testid="label">{props.label}</span>
      <span data-testid="count">{state.count}</span>
      <button data-testid="bump" onClick={() => dispatch({ _tag: "Bumped" })}>
        bump
      </button>
      <button data-testid="announce" onClick={() => dispatch({ _tag: "Announce" })}>
        announce
      </button>
    </div>
  ),
});

const CounterView = component(counter, { name: "Counter" });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Minimal boundary, so a thrown defect is observable instead of unmounting the tree. */
class ErrorBoundary extends Component<
  { readonly children?: React.ReactNode; readonly onError: (error: unknown) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (element: React.ReactNode) => {
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
});

const text = (testId: string) =>
  container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

const click = async (testId: string) => {
  const element = container?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  await act(async () => element?.click());
};

// ---------------------------------------------------------------------------

test("a mounted blueprint paints its initial state", async () => {
  await mount(<CounterView step={2} label="hello" onReached={() => {}} />);

  // The tree lands a tick after mount resolves, so this waits rather than
  // asserting synchronously.
  await vi.waitFor(() => {
    expect(text("count")).toBe("2");
    expect(text("label")).toBe("hello");
  });
});

test("a dispatch from a real click repaints", async () => {
  await mount(<CounterView step={2} label="hello" onReached={() => {}} />);
  await vi.waitFor(() => expect(text("count")).toBe("2"));

  await click("bump");
  await vi.waitFor(() => expect(text("count")).toBe("4"));

  await click("bump");
  await vi.waitFor(() => expect(text("count")).toBe("6"));
});

test("an output leaves through its `on<Tag>` prop, with `_tag` stripped", async () => {
  const reached = vi.fn();
  await mount(<CounterView step={5} label="hello" onReached={reached} />);
  await vi.waitFor(() => expect(text("count")).toBe("5"));

  await click("announce");

  await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1));
  // The prop name already carries the tag, so the payload does not.
  expect(reached).toHaveBeenCalledWith({ at: 5 });
});

test("an output raised from a threshold crossing reaches the parent", async () => {
  const reached = vi.fn();
  await mount(<CounterView step={5} label="hello" onReached={reached} />);
  await vi.waitFor(() => expect(text("count")).toBe("5"));

  await click("bump");

  await vi.waitFor(() => expect(text("count")).toBe("10"));
  await vi.waitFor(() => expect(reached).toHaveBeenCalledWith({ at: 10 }));
});

test("a props change repaints on the render that carried it, not the one after", async () => {
  // A parent that owns `step`, so changing it is an ordinary React re-render.
  const Parent = () => {
    const [step, setStep] = useState(3);
    return (
      <div>
        <button data-testid="raise" onClick={() => setStep(7)}>
          raise
        </button>
        <CounterView step={step} label="hello" onReached={() => {}} />
      </div>
    );
  };

  await mount(<Parent />);
  await vi.waitFor(() => expect(text("count")).toBe("3"));

  // One `act` flush. Detecting the change in an effect would paint the old
  // value first and correct it on a second pass; the assertion right after a
  // single flush is what distinguishes the two.
  await click("raise");
  expect(text("count")).toBe("7");
});

test("props identity churn alone does not raise `PropsChanged`", async () => {
  // The parent re-renders with equal-by-value props on every tick. Identity
  // comparison would raise `PropsChanged` each time; by-value does not.
  let propsChanges = 0;

  const Watched = define({
    props: Schema.Struct({ id: Schema.String }),
    state: Schema.Struct({ changes: Schema.Number }),
    action: Action.of([Action("Noop", {})]),
  }).create({
    initialState: () => ({ changes: 0 }),
    reducer: {
      Noop: (_action, { state }) => state,
      PropsChanged: (_action, { state }) => {
        propsChanges += 1;
        return { changes: state.changes + 1 };
      },
    },
    render: ({ state }) => <span data-testid="changes">{state.changes}</span>,
  });

  const WatchedView = component(Watched, { name: "Watched" });

  const Parent = () => {
    const [tick, setTick] = useState(0);
    return (
      <div>
        <button data-testid="tick" onClick={() => setTick(tick + 1)}>
          {tick}
        </button>
        {/* A fresh props object every render, equal by value. */}
        <WatchedView id="stable" />
      </div>
    );
  };

  await mount(<Parent />);
  await vi.waitFor(() => expect(text("changes")).toBe("0"));

  await click("tick");
  await click("tick");

  expect(propsChanges).toBe(0);
  expect(text("changes")).toBe("0");
});

test("survives StrictMode's mount → unmount → remount", async () => {
  // The regression this exists for: a single `dispose` in the effect cleanup
  // leaves the remounted store holding a closed scope, and every command after
  // that point silently does nothing. The click below is what catches it.
  const reached = vi.fn();
  await mount(
    <StrictMode>
      <CounterView step={5} label="strict" onReached={reached} />
    </StrictMode>,
  );

  await vi.waitFor(() => expect(text("count")).toBe("5"));

  await click("announce");
  await vi.waitFor(() => expect(reached).toHaveBeenCalledWith({ at: 5 }));

  await click("bump");
  await vi.waitFor(() => expect(text("count")).toBe("10"));
});

test("a declared prop that merely looks like an output handler survives the split", async () => {
  // The reason the split is by derived name and not by an `on*` prefix rule.
  // `onScroll` is an ordinary declared prop here, and stripping it would make
  // it invisible to the feature and to the props schema alike.
  let seen: ((value: number) => void) | undefined;

  const Scroller = define({
    props: Schema.Struct({ onScroll: Schema.Any }),
    state: Schema.Struct({ count: Schema.Number }),
    action: Action.of([Action("Noop", {})]),
    output: Action.of([Reached]),
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: { Noop: (_action, { state }) => state },
    render: ({ props }) => {
      seen = props.onScroll as (value: number) => void;
      return <span data-testid="ok">ok</span>;
    },
  });

  const ScrollerView = component(Scroller, { name: "Scroller" });
  const onScroll = vi.fn();

  await mount(<ScrollerView onScroll={onScroll} onReached={() => {}} />);

  await vi.waitFor(() => expect(text("ok")).toBe("ok"));
  expect(seen).toBe(onScroll);
});

test("an excess prop is rejected, which no spread would catch at compile time", async () => {
  // The hazard `validateProps` exists for: TypeScript's excess-property check
  // does not fire through a spread, so this compiles in real code.
  const config = { step: 2, label: "hello", onReached: () => {}, rogue: true };

  const errors: Array<unknown> = [];
  const onError = (error: unknown) => void errors.push(error);
  const previous = window.onerror;
  window.onerror = (_message, _source, _lineno, _colno, error) => {
    onError(error);
    return true;
  };

  try {
    await mount(
      <ErrorBoundary onError={onError}>
        <CounterView {...(config as React.ComponentProps<typeof CounterView>)} />
      </ErrorBoundary>,
    );
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
  } finally {
    window.onerror = previous;
  }

  expect(String(errors[0])).toMatch(/rogue|excess|unexpected/i);
});

test("an output with no matching prop throws rather than vanishing", async () => {
  // `OutputProps` makes every `on<Tag>` required, so reaching this means the
  // typed surface was bypassed — the same precedent as a missing reducer
  // handler, and the same loud failure.
  const errors: Array<unknown> = [];

  await mount(
    <ErrorBoundary onError={(error) => void errors.push(error)}>
      {/* Cast away the required handler, the way a bad spread would. */}
      <CounterView {...({ step: 5, label: "hello" } as React.ComponentProps<typeof CounterView>)} />
    </ErrorBoundary>,
  );

  await vi.waitFor(() => expect(text("count")).toBe("5"));
  await click("announce");

  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
  expect(String(errors[0])).toMatch(/onReached/);
});

test("a props change costs exactly one render, counted", async () => {
  // The one-render claim was asserted indirectly (the painted value after a
  // single flush) and never counted, so this counts it.
  //
  // It is not the regression guard for the `useSyncExternalStore`-after-`sync`
  // ordering, and should not be read as one: the count still measures one when
  // that ordering is reverted. What it pins is the claim itself — a props
  // change costs one render — against any future change that breaks it.
  let renders = 0;

  const Counted = define({
    props: Schema.Struct({ step: Schema.Number }),
    state: Schema.Struct({ mirrored: Schema.Number }),
    action: Action.of([Action("Noop", {})]),
  }).create({
    initialState: (props) => ({ mirrored: props.step }),
    reducer: {
      Noop: (_action, { state }) => state,
      PropsChanged: (_action, { props }) => ({ mirrored: props.step }),
    },
    render: ({ state }) => {
      renders += 1;
      return <span data-testid="mirrored">{state.mirrored}</span>;
    },
  });

  const CountedView = component(Counted, { name: "Counted" });

  const Parent = () => {
    const [step, setStep] = useState(1);
    return (
      <div>
        <button data-testid="bump-step" onClick={() => setStep((n) => n + 1)}>
          bump
        </button>
        <CountedView step={step} />
      </div>
    );
  };

  await mount(<Parent />);
  await vi.waitFor(() => expect(text("mirrored")).toBe("1"));

  const baseline = renders;
  await click("bump-step");

  expect(text("mirrored")).toBe("2");
  // One render for the new props. Two would mean the fold tripped
  // `useSyncExternalStore`'s post-render consistency check.
  expect(renders - baseline).toBe(1);
});
