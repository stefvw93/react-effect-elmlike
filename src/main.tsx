import { Effect, Layer, Schema } from "effect";
import { Action, define } from "./lib";

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

const render = CounterBlueprint.render(() => <></>);

const counter = CounterBlueprint.create({
  initialState,
  reducer,
  render,
});

console.log({ Counter: CounterBlueprint, created: counter });

const props = { start: 0, step: 5 };
const at = (count: number) => ({
  state: { count },
  props,
  hooks: {},
  initialState: { count: 0 },
});

export const one = [counter.reduce({ _tag: "Incremented" }, at(10))];

void Effect.runPromise(
  counter.run(
    [
      { _tag: "Incremented" },
      { _tag: "Incremented" },
      { _tag: "Incremented" },
      { _tag: "Incremented" },
    ],
    {
      props: { start: 0, step: 5 },
      hooks: {},
      layer: Layer.empty,
    },
  ),
).then(console.log);
