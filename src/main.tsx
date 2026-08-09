import { Schema, Stream } from "effect";
import { Action, define } from "./lib";

const Props = Schema.Struct({
  start: Schema.Number,
  step: Schema.Number,
});

const State = Schema.Struct({
  count: Schema.Number,
});

// const Incremented = Action("Incremented", {});
// const Decremented = Action("Decremented", {});
const Hello = Action("Hello", {});
const CounterAction = Action.of([Hello]);

const CounterBlueprint = define({
  props: Props,
  state: State,
  action: CounterAction,
});

const initialState = CounterBlueprint.initialState((props) => ({ count: props.start }));

const reducer = CounterBlueprint.reducer({
  Hello: (action, snapshot) => {
    console.log("hello from Hello reducer", { action, snapshot });
    return [snapshot.state, Stream.empty];
  },
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

export const one = [counter.reduce({ _tag: "Hello" }, at(10))];
