/**
 * The floor of ceremony: no services, no commands, no hooks. Worth having
 * because it shows what you pay when you need none of it.
 *
 * Also shows the thing this is actually for. `blueprint.reduce` is the whole
 * reducer as one pure function, so a test feeds it actions and folds — no
 * React, no runtime, no mounting.
 */

import { Schema } from "effect";
import { Action, define, Next } from "../lib/tea";

const State = Schema.Struct({
  count: Schema.Number,
});

const Incremented = Action("Incremented", {});
const Decremented = Action("Decremented", {});
const Reset = Action("Reset", {});

const Props = Schema.Struct({
  start: Schema.Number,
  step: Schema.Number,
});

const Counter = define({
  props: Props,
  state: State,
  action: Action.of([Incremented, Decremented, Reset]),
});

export const counter = Counter.create({
  initialState: (props) => ({ count: props.start }),

  reducer: {
    Incremented: (_action, { state, props }) => ({ count: state.count + props.step }),
    Decremented: (_action, { state, props }) => ({ count: state.count - props.step }),
    Reset: (_action, { initialState }) => initialState,
  },

  render: ({ state, dispatch }) => (
    <div role="group" aria-label="counter">
      <button onClick={() => dispatch({ _tag: "Decremented" })}>-</button>
      <output>{state.count}</output>
      <button onClick={() => dispatch({ _tag: "Incremented" })}>+</button>
      <button onClick={() => dispatch({ _tag: "Reset" })}>reset</button>
    </div>
  ),
});

// ---------------------------------------------------------------------------
// What a test looks like.
// ---------------------------------------------------------------------------

const props = { start: 0, step: 5 };
const at = (count: number) => ({
  state: { count },
  props,
  hooks: {},
  initialState: { count: 0 },
});

export const one = [
  counter.reduce({ _tag: "Incremented" }, at(10)), // { count: 15 }
  counter.reduce({ _tag: "Decremented" }, at(10)), // { count: 5 }
  counter.reduce({ _tag: "Reset" }, at(10)), // { count: 0 }
];

/** A sequence, folded. This is the shape most real assertions want. */
export const sequence = (
  [{ _tag: "Incremented" }, { _tag: "Incremented" }, { _tag: "Decremented" }] as const
).reduce((state, action) => Next.state(counter.reduce(action, { ...at(0), state })), { count: 0 }); // { count: 5 }

/** Lifecycle actions are ordinary inputs here too — no mounting to test them. */
export const onPropsChange = counter.reduce(
  { _tag: "PropsChanged", next: { start: 3, step: 5 }, previous: props },
  at(10),
);

/** Including teardown, now that it returns a `Next` like everything else. */
export const onUnmount = Next.command(counter.reduce({ _tag: "Unmounted" }, at(10))); // undefined
