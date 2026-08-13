/**
 * Search-as-you-type: the case Elm has no good answer for.
 *
 * The debounce is not an operator, and not a timer in the state. `TextEdited`
 * cancels its own group before forking the replacement, so each keystroke
 * interrupts the pending request from the previous keystroke — mid-delay,
 * before it was ever sent. Debounce, cancellation and last-write-wins all fall
 * out of those two lines, and the stale-response race is gone structurally
 * rather than by comparing sequence numbers in the reducer.
 *
 * It used to fall out of one *word* — the handler was declared `"restart"` and
 * the runtime owned a policy vocabulary to make that mean something. The word
 * was shorter; it was also a fiber supervisor reimplementing combinators Effect
 * already had. What replaced it is visible in the handler, which is the point.
 */

import { Context, Effect, Schema } from "effect";
import { Action, Command, define } from "../lib/tea";

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

const TextEdited = Action("TextEdited", { text: Schema.String });
const HitsArrived = Action("HitsArrived", {
  for: Schema.String,
  hits: Schema.Array(Schema.String),
});
const QueryFailed = Action("QueryFailed", { status: Schema.Number });
const Cleared = Action("Cleared", {});

const Props = Schema.Struct({
  /** Changing this must re-run whatever is in the box. */
  filter: Schema.Literals(["all", "docs", "code"]),
  placeholder: Schema.String,
});

// --- blueprint ---------------------------------------------------------------

const Search = define({
  props: Props,
  state: State,
  action: Action.of([TextEdited, HitsArrived, QueryFailed, Cleared]),
});

const getInitialSearchState = () => ({
  text: "",
  hits: [],
  pending: false,
  error: null,
});

/**
 * Emptying the box is a reset *and* an interrupt.
 *
 * The `for` guard on `HitsArrived` already stops a stale response repainting an
 * emptied box, so leaving the query running is invisible on screen — which is
 * exactly why it is worth writing down: the request is still sent, 300ms after
 * the user made it clear they no longer want it. A cancel here is one line, and
 * without it this file's headline claim — that cancellation is visible in the
 * handler — is only true of the paths that happen to issue a new query.
 */
const cleared = [
  getInitialSearchState(),
  Command.cancel({ tag: "TextEdited", key: "query" }),
] as const;

export const search = Search.create({
  initialState: () => getInitialSearchState(),

  reducer: {
    TextEdited: (action, { props, state }) =>
      action.text.length === 0
        ? cleared
        : [
            { ...state, text: action.text, pending: true, error: null },
            Command.batch(
              // Restart-on-keystroke, written where the reader can see the
              // interrupt. The cancel has to run *before* the replacement is
              // registered, which is the one thing this node does that no
              // combinator inside the effect below can.
              Command.cancel({ tag: "TextEdited", key: "query" }),
              Command.keyed(
                "query",
                Command.effect((dispatch) =>
                  Effect.match(
                    // The delay sits inside the interruptible region, which is
                    // what makes the cancel above a debounce rather than just a
                    // cancel.
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
                  ).pipe(Effect.flatMap(dispatch)),
                ),
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

    Cleared: () => cleared,

    // Re-dispatch rather than re-issue. The command lives in exactly one
    // handler, and because it is issued *as* `TextEdited` it lands in the same
    // concurrency group — so changing the filter interrupts a keystroke's
    // pending query instead of racing it.
    PropsChanged: (action, { props, state }) =>
      props.filter === action.previous.filter || state.text.length === 0
        ? state
        : [
            state,
            Command.effect((dispatch) =>
              dispatch({ _tag: "TextEdited" as const, text: state.text }),
            ),
          ],
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
