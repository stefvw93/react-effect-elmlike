/**
 * The full case: props in, callbacks out, community hooks, a service in `R`, a
 * one-shot fallible command, a progressive streaming command, and an "ignore"
 * policy so a double-click cannot double-charge anybody.
 *
 * This is the shape of a "mission critical component" — a cart dropped into an
 * otherwise ordinary React app.
 *
 * Written in the piecewise style: `Cart` declares what the component is made
 * of, then `initialState`, `reducer` and `render` are separate named values.
 * Each is fully typed with no annotation of its own, and each could live in its
 * own file. The other examples inline the same pieces into `create` instead.
 */

import { Context, Effect, Schema, Stream } from "effect";
import { callback, define } from "../lib/tea";

// --- domain -----------------------------------------------------------------

interface Line {
  readonly sku: string;
  readonly title: string;
  readonly unitPrice: number;
  readonly quantity: number;
}

interface CouponRejected {
  readonly _tag: "CouponRejected";
  readonly code: string;
}

interface CheckoutFailed {
  readonly _tag: "CheckoutFailed";
  readonly reason: string;
}

type CheckoutProgress =
  | { readonly step: "reserving" }
  | { readonly step: "charging" }
  | { readonly step: "done"; readonly orderId: string };

export class CartApi extends Context.Service<
  CartApi,
  {
    readonly restore: (customerId: string) => Effect.Effect<ReadonlyArray<Line>>;
    readonly redeem: (code: string) => Effect.Effect<number, CouponRejected>;
    readonly checkout: (
      customerId: string,
      lines: ReadonlyArray<Line>,
    ) => Stream.Stream<CheckoutProgress, CheckoutFailed>;
    readonly release: (customerId: string) => Effect.Effect<void>;
  }
>()("CartApi") {}

// --- community hooks --------------------------------------------------------

declare function useCatalog(customerId: string): { readonly stale: boolean };
declare function useOnlineStatus(): boolean;

// --- props ------------------------------------------------------------------

const Props = Schema.Struct({
  customerId: Schema.String,

  /** Read by `render`. Never enters state, so it needs no action. */
  currency: Schema.Literals(["EUR", "USD"]),

  /**
   * Outbound. Called from a command, so the handler stays pure.
   *
   * `callback` is the escape hatch for the half of props no schema can encode.
   * It checks `typeof === "function"` and carries the signature in the type —
   * which is everything a runtime could have checked anyway.
   */
  onCheckout: callback<(orderId: string) => void>(),
});

export type CartProps = typeof Props.Type;

// --- state and actions ------------------------------------------------------

const LineSchema = Schema.Struct({
  sku: Schema.String,
  title: Schema.String,
  unitPrice: Schema.Number,
  quantity: Schema.Number,
});

const State = Schema.Struct({
  lines: Schema.Array(LineSchema),
  discount: Schema.Number,
  checkout: Schema.Literals(["idle", "reserving", "charging"]),
  error: Schema.NullOr(Schema.String),
});

type CartState = typeof State.Type;

const LinesRestored = Schema.TaggedStruct("LinesRestored", {
  lines: Schema.Array(LineSchema),
});
const QuantityChanged = Schema.TaggedStruct("QuantityChanged", {
  sku: Schema.String,
  quantity: Schema.Number,
});
const CouponSubmitted = Schema.TaggedStruct("CouponSubmitted", { code: Schema.String });
const CouponAccepted = Schema.TaggedStruct("CouponAccepted", { discount: Schema.Number });
const CheckoutRequested = Schema.TaggedStruct("CheckoutRequested", {});
const CheckoutAdvanced = Schema.TaggedStruct("CheckoutAdvanced", {
  stage: Schema.Literals(["reserving", "charging"]),
});
const CheckoutCompleted = Schema.TaggedStruct("CheckoutCompleted", {
  orderId: Schema.String,
});
const Failed = Schema.TaggedStruct("Failed", { reason: Schema.String });

const subtotal = (state: CartState): number =>
  state.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) - state.discount;

const progressToAction = (progress: CheckoutProgress) =>
  progress.step === "done"
    ? ({ _tag: "CheckoutCompleted", orderId: progress.orderId } as const)
    : ({ _tag: "CheckoutAdvanced", stage: progress.step } as const);

// --- what the component is made of -------------------------------------------

const Cart = define({
  props: Props,
  state: State,
  actions: [
    LinesRestored,
    QuantityChanged,
    CouponSubmitted,
    CouponAccepted,
    CheckoutRequested,
    CheckoutAdvanced,
    CheckoutCompleted,
    Failed,
  ],

  // Called in render position with the current props. `props` needs no
  // annotation — `Cart` already knows what it is.
  hooks: {
    catalog: (props) => useCatalog(props.customerId),
    online: () => useOnlineStatus(),
  },
});

// --- the pieces, separately --------------------------------------------------

/** A pure projection, evaluated on mount. Nothing effectful here. */
export const initialState = Cart.initialState(() => ({
  lines: [],
  discount: 0,
  checkout: "idle" as const,
  error: null,
}));

export const reducer = Cart.reducer({
    // Startup command. `restore` cannot fail, so a plain map is enough — this
    // is what Elm calls `Task.perform`.
    "@mounted": ({ props, state }) => [
      state,
      Stream.fromEffect(
        Effect.map(
          CartApi.use((api) => api.restore(props.customerId)),
          (lines) => ({ _tag: "LinesRestored" as const, lines }),
        ),
      ),
    ],

    LinesRestored: (action, { state }) => ({ ...state, lines: action.lines }),

    QuantityChanged: (action, { state }) => ({
      ...state,
      lines: state.lines.map((line) =>
        line.sku === action.sku ? { ...line, quantity: action.quantity } : line,
      ),
    }),

    // Fallible one-shot, handled where it fails. `Effect.match` yields two
    // *specific* actions — strictly better than one error funnel at the root.
    // Reads an ambient hook value without copying it into state.
    CouponSubmitted: (action, { state, hooks }) =>
      hooks.online
        ? [
            state,
            Stream.fromEffect(
              Effect.match(
                CartApi.use((api) => api.redeem(action.code)),
                {
                  onFailure: (error: CouponRejected) => ({
                    _tag: "Failed" as const,
                    reason: `Coupon ${error.code} was rejected.`,
                  }),
                  onSuccess: (discount) => ({
                    _tag: "CouponAccepted" as const,
                    discount,
                  }),
                },
              ),
            ),
          ]
        : { ...state, error: "You appear to be offline." },

    CouponAccepted: (action, { state }) => ({ ...state, discount: action.discount }),

    // Progressive emission: one command, many actions, one scope.
    //
    // Deliberately *not* `Effect.result`. Reifying the failure into a `Result`
    // is right for a one-shot effect, but a stream would have to be collapsed
    // to a single value first — which throws away the progressive emission that
    // is the entire point. For a fallible stream, catch at the stream level.
    //
    CheckoutRequested: (_action, { state, props }) => [
      { ...state, checkout: "reserving" as const, error: null },
      Stream.flatMap(Stream.fromEffect(CartApi), (api) =>
        api.checkout(props.customerId, state.lines),
      ).pipe(
        Stream.map(progressToAction),
        Stream.catchTag("CheckoutFailed", (error) =>
          Stream.succeed({ _tag: "Failed" as const, reason: error.reason }),
        ),
      ),
    ],

    CheckoutAdvanced: (action, { state }) => ({ ...state, checkout: action.stage }),

    // Outbound: the escape hatch to the untyped parent is a command, so the
    // state change stays pure and the side effect stays in the effect channel.
    CheckoutCompleted: (action, { state, props }) => [
      { ...state, checkout: "idle" as const },
      Stream.drain(
        Stream.fromEffect(Effect.sync(() => props.onCheckout(action.orderId))),
      ),
    ],

    Failed: (action, { state }) => ({
      ...state,
      checkout: "idle" as const,
      error: action.reason,
    }),

    // `currency` is read straight from props and never appears here.
    "@propsChanged": (action, { state, initialState }) =>
      action.next.customerId === action.previous.customerId ? state : initialState,

    // `action.hook` narrows `next` per key.
    "@hookChanged": (action, { state }) => {
      switch (action.hook) {
        case "online":
          return { ...state, error: action.next ? null : "Reconnecting…" };
        case "catalog":
          return state;
      }
    },

    // In-app resource release only. A server-side "abandon cart" belongs in a
    // `pagehide` beacon, not here — React unmount does not fire on tab close.
    "@unmounted": ({ props }) => CartApi.use((api) => api.release(props.customerId)),
});

export const render = Cart.render(({ state, props, hooks, dispatch }) => (
    <section aria-busy={state.checkout !== "idle"}>
      {hooks.catalog.stale && <p>Prices may be out of date.</p>}
      {state.error && <p role="alert">{state.error}</p>}

      <ul>
        {state.lines.map((line) => (
          <li key={line.sku}>
            {line.title}
            <input
              type="number"
              value={line.quantity}
              onChange={(event) =>
                dispatch({
                  _tag: "QuantityChanged",
                  sku: line.sku,
                  quantity: event.target.valueAsNumber,
                })
              }
            />
          </li>
        ))}
      </ul>

      <output>
        {new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: props.currency,
        }).format(subtotal(state))}
      </output>

      <button
        disabled={state.checkout !== "idle" || !hooks.online}
        onClick={() => dispatch({ _tag: "CheckoutRequested" })}
      >
        {state.checkout === "idle" ? "Check out" : "Working…"}
      </button>
    </section>
));

// --- assembled ---------------------------------------------------------------

export const cart = Cart.create({
  initialState,
  reducer,
  render,

  // A second click while charging is discarded, not allowed to interrupt and
  // retry. Nothing is wrapped at the call site to make this true.
  concurrency: {
    CheckoutRequested: "ignore",
  },
});
