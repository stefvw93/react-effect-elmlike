import { Layer, Schema } from "effect";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { Action, createRuntime, define } from "./lib";

const Props = Schema.Struct({
  start: Schema.Number,
  step: Schema.Number,
});

const State = Schema.Struct({
  count: Schema.Number,
});

const Incremented = Action("Incremented", {});
const Decremented = Action("Decremented", {});
const CounterAction = Action.of([Incremented, Decremented]);

const CounterBlueprint = define({
  props: Props,
  state: State,
  action: CounterAction,
});

const initialState = CounterBlueprint.initialState((props) => ({ count: props.start }));

const reducer = CounterBlueprint.reducer({
  Incremented: (_action, { state, props }) => ({ count: state.count + props.step }),
  Decremented: (_action, { state, props }) => ({ count: state.count - props.step }),
});

const render = CounterBlueprint.render(({ state, dispatch }) => (
  <main>
    <h1>{state.count}</h1>
    <button onClick={() => dispatch({ _tag: "Decremented" })}>−</button>
    <button onClick={() => dispatch({ _tag: "Incremented" })}>+</button>
  </main>
));

const counter = CounterBlueprint.create({ initialState, reducer, render });

/**
 * The root runtime. `Layer.empty` because this feature needs no services — the
 * point of the entry point is to show what a leaf costs, which is one line.
 */
const { Provider, component } = createRuntime(Layer.empty);

const Counter = component(counter, { name: "Counter" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider>
      <Counter start={0} step={1} />
    </Provider>
  </StrictMode>,
);
