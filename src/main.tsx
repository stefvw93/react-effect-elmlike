import { Context, Effect, Layer, pipe, Result, Schema } from "effect";
import { createRoot } from "react-dom/client";
import { StrictMode, type ReactNode } from "react";
import { Action, Children, Command, consoleDevtoolsLayer, createRuntime, define } from "./lib";
import type { UnknownError } from "effect/Cause";

const TodoItem = Schema.Struct({
  id: Schema.Number,
  todo: Schema.String,
  completed: Schema.Boolean,
  userId: Schema.Number,
});

class TodoService extends Context.Service<
  TodoService,
  {
    getById: (
      id: number,
    ) => Effect.Effect<Result.Result<typeof TodoItem.Type, UnknownError>, never, never>;
  }
>()("TodoService") {
  static readonly live = Layer.succeed(TodoService, {
    getById: (id: number) =>
      pipe(
        Effect.tryPromise(() =>
          fetch(`https://dummyjson.com/todos/${id}`)
            .then((res) => res.json())
            .then((data) => Schema.decodeUnknownSync(TodoItem)(data)),
        ),
        Effect.result,
      ),
  });
}

const Props = Schema.Struct({
  children: Schema.optionalKey(Children.as<(item: typeof TodoItem.Type) => ReactNode>()),
});

const State = Schema.Struct({
  query: Schema.UndefinedOr(Schema.NumberFromString),
  data: Schema.NullishOr(TodoItem),
});

const Input = Action("Input", { value: Schema.Number });
const ClickedSubmit = Action("ClickedSubmit", {});
const TodoResolved = Action("TodoResolved", { data: Schema.NullishOr(TodoItem) });
const TodoChanged = Action.output("TodoChanged", { data: Schema.NullishOr(TodoItem) });
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
      Effect.gen(function* () {
        if (state.query === undefined) return;

        const todoService = yield* TodoService;
        const data = yield* todoService.getById(state.query);

        yield* dispatch({
          _tag: "TodoResolved",
          data: Result.getOrNull(data),
        });
      }),
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
    <h2>Find a task by id</h2>
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
    {state.data && props.children?.(state.data)}
  </main>
));

const todoFetcher = TodoFetcherBlueprint.create({ initialState, reducer, render });

const { Provider, component } = createRuntime(
  Layer.mergeAll(consoleDevtoolsLayer(), TodoService.live),
);

const TodoFetcher = component(todoFetcher, { name: "TodoFetcher" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider>
      <TodoFetcher onTodoChanged={(data) => console.log("on data changed", data)}>
        {(data) => `To do: ${data.todo}`}
      </TodoFetcher>
    </Provider>
  </StrictMode>,
);
