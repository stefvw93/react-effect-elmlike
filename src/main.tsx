import { Effect, Schema } from "effect";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { Action, Children, Command, consoleDevtoolsLayer, createRuntime, define } from "./lib";

const Props = Schema.Struct({
  children: Schema.optionalKey(Children),
});

const State = Schema.Struct({
  query: Schema.UndefinedOr(Schema.NumberFromString),
  data: Schema.Any,
});

const Input = Action("Input", { value: Schema.Number });
const ClickedSubmit = Action("ClickedSubmit", {});
const TodoResolved = Action("TodoResolved", { data: Schema.Any });
const TodoChanged = Action.output("TodoChanged", { data: Schema.Any });
const TodoFetcherAction = Action.of([Input, ClickedSubmit, TodoResolved]);
const TodoFetcherOutput = Action.of([TodoChanged]);

const TodoFetcherBlueprint = define({
  props: Props,
  state: State,
  action: TodoFetcherAction,
  output: TodoFetcherOutput,
});

const initialState = TodoFetcherBlueprint.initialState(() => ({ query: undefined, data: null }));

const reducer = TodoFetcherBlueprint.reducer({
  Input: (action, { state }) => ({ ...state, query: action.value }),

  ClickedSubmit: (_action, { state }) => [
    { ...state, data: null },
    Command.effect((dispatch) =>
      Effect.promise(() =>
        fetch(`https://dummyjson.com/todos/${state.query}`).then((res) => res.json()),
      ).pipe(Effect.andThen((data) => dispatch({ _tag: "TodoResolved", data }))),
    ),
  ],

  TodoResolved: (action, { state }) => {
    const nextState = { ...state, data: action.data };
    return [
      nextState,
      Command.effect((dispatch) => dispatch(TodoChanged.make({ data: nextState.data }))),
    ];
  },
});

const render = TodoFetcherBlueprint.render(({ props, state, dispatch }) => (
  <main>
    <h1>{state.query}</h1>
    <form
      onSubmit={(e) => {
        e.preventDefault();
        dispatch(ClickedSubmit.make({}));
      }}
    >
      <input onChange={(e) => dispatch(Input.make({ value: Number(e.target.value) }))} />
      <button type="submit">Fetch</button>
    </form>
    <pre>{JSON.stringify(state.data, null, 2)}</pre>
    {props.children}
  </main>
));

const todoFetcher = TodoFetcherBlueprint.create({ initialState, reducer, render });

const { Provider, component } = createRuntime(consoleDevtoolsLayer());

const TodoFetcher = component(todoFetcher, { name: "TodoFetcher" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider>
      <TodoFetcher onTodoChanged={(data) => console.log("on data changed", data)}>test</TodoFetcher>
    </Provider>
  </StrictMode>,
);
