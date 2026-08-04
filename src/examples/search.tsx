/**
 * Search-as-you-type: the case Elm has no good answer for.
 *
 * The debounce is not an operator, and not a timer in the state. `TextEdited`
 * is declared `"restart"`, so each keystroke interrupts the pending request
 * from the previous keystroke — mid-delay, before it was ever sent. Debounce,
 * cancellation and last-write-wins all fall out of that one word, and the
 * stale-response race is gone structurally rather than by comparing sequence
 * numbers in the reducer.
 */

import { Context, Effect, Schema, Stream } from "effect";
import { define } from "../lib/tea";

// --- service ---------------------------------------------------------------

interface Unreachable {
  readonly _tag: "Unreachable";
  readonly status: number;
}

export class SearchApi extends Context.Service<
  SearchApi,
  {
    readonly query: (
      text: string,
      filter: "all" | "docs" | "code",
    ) => Effect.Effect<ReadonlyArray<string>, Unreachable>;
  }
>()("SearchApi") {}

// --- state and actions ------------------------------------------------------

const State = Schema.Struct({
  text: Schema.String,
  hits: Schema.Array(Schema.String),
  pending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

const TextEdited = Schema.TaggedStruct("TextEdited", { text: Schema.String });
const HitsArrived = Schema.TaggedStruct("HitsArrived", {
  for: Schema.String,
  hits: Schema.Array(Schema.String),
});
const QueryFailed = Schema.TaggedStruct("QueryFailed", { status: Schema.Number });
const Cleared = Schema.TaggedStruct("Cleared", {});

const Props = Schema.Struct({
  /** Changing this must re-run whatever is in the box. */
  filter: Schema.Literals(["all", "docs", "code"]),
  placeholder: Schema.String,
});

// --- blueprint ---------------------------------------------------------------

const Search = define({
  props: Props,
  state: State,
  actions: [TextEdited, HitsArrived, QueryFailed, Cleared],
});

export const search = Search.create({
  initialState: () => ({
    text: "",
    hits: [],
    pending: false,
    error: null,
  }),

  concurrency: {
    TextEdited: "restart",
  },

  reducer: {
    TextEdited: (action, { state, props, initialState }) =>
      action.text.length === 0
        ? initialState
        : [
            { ...state, text: action.text, pending: true, error: null },
            Stream.fromEffect(
              Effect.match(
                // The delay sits inside the interruptible region, which is what
                // turns "restart" into a debounce rather than just a cancel.
                Effect.delay(
                  Effect.flatMap(SearchApi, (api) => api.query(action.text, props.filter)),
                  "300 millis",
                ),
                {
                  onFailure: (error: Unreachable) => ({
                    _tag: "QueryFailed" as const,
                    status: error.status,
                  }),
                  onSuccess: (hits) => ({
                    _tag: "HitsArrived" as const,
                    for: action.text,
                    hits,
                  }),
                },
              ),
            ),
          ],

    // `for` is carried so a response can say what it answers — which keeps this
    // correct even if the policy is ever relaxed to "parallel".
    HitsArrived: (action, { state }) =>
      action.for === state.text ? { ...state, hits: action.hits, pending: false } : state,

    QueryFailed: (action, { state }) => ({
      ...state,
      pending: false,
      error: `Search is unavailable (${action.status}).`,
    }),

    Cleared: (_action, { initialState }) => initialState,

    // Re-dispatch rather than re-issue. The command lives in exactly one
    // handler, and because it is issued *as* `TextEdited` it lands in the same
    // concurrency group — so changing the filter interrupts a keystroke's
    // pending query instead of racing it.
    "@propsChanged": (action, { state }) =>
      action.next.filter === action.previous.filter || state.text.length === 0
        ? state
        : [state, Stream.succeed({ _tag: "TextEdited" as const, text: state.text })],
  },

  render: ({ state, props, dispatch }) => (
    <div>
      <input
        type="search"
        value={state.text}
        placeholder={props.placeholder}
        onChange={(event) => dispatch({ _tag: "TextEdited", text: event.target.value })}
      />
      {state.text.length > 0 && (
        <button onClick={() => dispatch({ _tag: "Cleared" })}>clear</button>
      )}

      {state.error ? (
        <p role="alert">{state.error}</p>
      ) : (
        <ul aria-busy={state.pending}>
          {state.hits.map((hit) => (
            <li key={hit}>{hit}</li>
          ))}
        </ul>
      )}
    </div>
  ),
});
