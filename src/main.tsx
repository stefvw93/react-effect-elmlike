import { Effect, Schema } from "effect";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { Action, Command, consoleDevtoolsLayer, createRuntime, define } from "./lib";

const Props = Schema.Struct({
  start: Schema.Number,
  step: Schema.Number,
});

const State = Schema.Struct({
  count: Schema.Number,
  data: Schema.Any,
});

const Incremented = Action("Incremented", {});
const Decremented = Action("Decremented", {});
const Submitted = Action("Submitted", {});
const Resolved = Action("Resolved", { data: Schema.Any });
const DataChanged = Action.output("DataChanged", { data: Schema.Any });
const CounterAction = Action.of([Incremented, Decremented, Submitted, Resolved]);
const CounterOutput = Action.of([DataChanged]);

const CounterBlueprint = define({
  props: Props,
  state: State,
  action: CounterAction,
  output: CounterOutput,
});

const initialState = CounterBlueprint.initialState((props) => ({ count: props.start, data: null }));

const reducer = CounterBlueprint.reducer({
  Incremented: (_action, { state, props }) => ({ ...state, count: state.count + props.step }),
  Decremented: (_action, { state, props }) => ({ ...state, count: state.count - props.step }),

  Submitted: (_action, { state }) => [
    { ...state, data: null },
    Command.effect((dispatch) =>
      Effect.promise(() =>
        fetch(`https://dummyjson.com/todos/${state.count}`).then((res) => res.json()),
      ).pipe(Effect.andThen((data) => dispatch({ _tag: "Resolved", data }))),
    ),
  ],

  Resolved: (action, { state }) => [
    { ...state, data: action.data },
    Command.effect((dispatch) => dispatch(DataChanged.make({ data: action.data }))),
  ],
});

const render = CounterBlueprint.render(({ state, dispatch }) => (
  <main>
    <h1>{state.count}</h1>
    <button onClick={() => dispatch({ _tag: "Decremented" })}>−</button>
    <button onClick={() => dispatch({ _tag: "Incremented" })}>+</button>
    <button onClick={() => dispatch({ _tag: "Submitted" })}>Fetch</button>
    <pre>{JSON.stringify(state.data, null, 2)}</pre>
  </main>
));

const counter = CounterBlueprint.create({ initialState, reducer, render });

const { Provider, component } = createRuntime(consoleDevtoolsLayer());

const Counter = component(counter, { name: "Counter" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider>
      <Counter start={0} step={1} onDataChanged={(data) => console.log("on data changed", data)}>
        {/*test*/}
      </Counter>
    </Provider>
  </StrictMode>,
);
