/**
 * The feature that motivated the outbound channel, and the one place the whole
 * design is visible at once: props in, state accumulated, commands for effects,
 * one announcement out.
 *
 * **`onCheckout` is not a prop.** It was outbound traffic wearing an inbound
 * costume — a function in the props schema, invoked from inside a command,
 * invisible to any transport. It is an output, and the parent gets a required
 * `onOrderPlaced` derived from the declaration. Removing it is also what let the
 * props schema drop its escape hatch entirely, so a devtools event no longer lies
 * about its props.
 *
 * Two things were sketched on top of that and both were cut:
 *
 *   - **`queries`** — `CheckoutRequested` was promoted so a sticky bar outside the
 *     cart could trigger checkout. Cut: the trigger belongs to the feature. The
 *     button is in `render` where it always was, and if the DOM wants it in a
 *     header, portal it there.
 *   - **`TotalChanged`** — an output announcing the subtotal, so a header badge
 *     could show it. Cut: a value that has to cross continuously is not this
 *     feature's value. Either the badge is cart UI and belongs inside `render`, or
 *     `lines` has two owners and belongs in a service. Emulating a continuous
 *     channel with discrete announcements meant hand-emitting from four handlers,
 *     which is a thing you forget on the fifth.
 *
 * What is left is one sentence: React, with a callback prop turned into a value.
 */

import { useState, type ReactNode } from "react";
import { Context, Effect, Layer, Schema, Stream, Struct } from "effect";
import { Action, Command, createRuntime, define } from "../lib/tea";

// --- domain (unchanged) -------------------------------------------------------

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

declare function useCatalog(customerId: string): { readonly stale: boolean };
declare function useOnlineStatus(): boolean;

// --- props: inbound, continuous ----------------------------------------------

/**
 * One field shorter than it was. `onCheckout: callback<…>()` is gone, and with
 * it the last reason this schema needed an escape hatch — everything left
 * encodes, so a devtools event no longer lies about its props.
 */
const CartProps = Schema.Struct({
  customerId: Schema.String,
  currency: Schema.Literals(["EUR", "USD"]),
});

export type CartProps = typeof CartProps.Type;

// --- state --------------------------------------------------------------------

const LineSchema = Schema.Struct({
  sku: Schema.String,
  title: Schema.String,
  unitPrice: Schema.Number,
  quantity: Schema.Number,
});

const CartState = Schema.Struct({
  lines: Schema.Array(LineSchema),
  discount: Schema.Number,
  checkout: Schema.Literals(["idle", "reserving", "charging"]),
  error: Schema.NullOr(Schema.String),
});

type CartState = typeof CartState.Type;

const subtotal = (state: CartState): number =>
  state.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) - state.discount;

// --- actions: internal, never cross the boundary ------------------------------

const LinesRestored = Action("LinesRestored", {
  lines: Schema.Array(LineSchema),
});
const QuantityChanged = Action("QuantityChanged", {
  sku: Schema.String,
  quantity: Schema.Number,
});
const CouponSubmitted = Action("CouponSubmitted", { code: Schema.String });
const CouponAccepted = Action("CouponAccepted", { discount: Schema.Number });
const CheckoutRequested = Action("CheckoutRequested", {});
const CheckoutAdvanced = Action("CheckoutAdvanced", {
  stage: Schema.Literals(["reserving", "charging"]),
});
const CheckoutCompleted = Action("CheckoutCompleted", {
  orderId: Schema.String,
});
const Failed = Action("Failed", { reason: Schema.String });

/**
 * The vocabulary as one value. It is a `Schema.Union` underneath, so it encodes —
 * which is what a devtools transport needed and an array of schemas never gave —
 * and it nests: `Action.of([Shared, …])` flattens `Shared` into the key set, so a
 * vocabulary two features have in common is a value rather than a copied list.
 */
const CartActions = Action.of([
  LinesRestored,
  QuantityChanged,
  CouponSubmitted,
  CouponAccepted,
  CheckoutRequested,
  CheckoutAdvanced,
  CheckoutCompleted,
  Failed,
]);

// --- outputs: outbound, discrete ----------------------------------------------

/**
 * No handler, and it could not have one — an output tag is not in the reducer's
 * key set, so writing one is a compile error rather than a handler that silently
 * never fires.
 *
 * `Action.output` is `Action` with the other phantom on it, and that phantom is
 * the whole difference. Mixing `OrderPlaced` into the `Action.of([…])` that
 * builds `CartActions` is a type error, and so is passing `CartOutputs` to
 * `action` — which is what the earlier `action` / `output` pair only *looked*
 * like it was doing.
 *
 * `.of` is shared rather than per-channel: the members carry the brand, so it
 * reads the channel back off them instead of being told twice.
 */
const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });

const CartOutputs = Action.of([OrderPlaced]);

// --- the interface, in one place ----------------------------------------------

const Cart = define({
  props: CartProps,
  state: CartState,
  action: CartActions,
  output: CartOutputs,

  useHooks: function useCartHooks(props) {
    return {
      catalog: useCatalog(props.customerId),
      online: useOnlineStatus(),
    };
  },
});

/**
 * `cases` carries a constructor per member that fills `_tag` for you — the thing
 * `action(…)` was named after and never actually provided, so every command in the
 * old version hand-wrote `{ _tag: "…" as const }` and nothing checked the tag
 * against the vocabulary.
 */
const progressToAction = (progress: CheckoutProgress) =>
  progress.step === "done"
    ? CartActions.cases.CheckoutCompleted.make({ orderId: progress.orderId })
    : CartActions.cases.CheckoutAdvanced.make({ stage: progress.step });

// --- the pieces ----------------------------------------------------------------

export const initialState = Cart.initialState(() => ({
  lines: [],
  discount: 0,
  checkout: "idle" as const,
  error: null,
}));

export const reducer = Cart.reducer({
  Mounted: (_action, { props, state }) => [
    state,
    Command.stream(
      Stream.fromEffect(
        Effect.map(
          Effect.flatMap(CartApi, (api) => api.restore(props.customerId)),
          (lines) => ({ _tag: "LinesRestored" as const, lines }),
        ),
      ),
    ),
  ],

  LinesRestored: (action, { state }) => Struct.assign(state, { lines: action.lines }),

  QuantityChanged: (action, { state }) =>
    Struct.evolve(state, {
      lines: (lines) =>
        lines.map((line) =>
          line.sku === action.sku ? Struct.assign(line, { quantity: action.quantity }) : line,
        ),
    }),

  CouponSubmitted: (action, { state, hooks }) =>
    hooks.online
      ? [
          state,
          Command.stream(
            Stream.fromEffect(
              Effect.match(
                Effect.flatMap(CartApi, (api) => api.redeem(action.code)),
                {
                  onFailure: (error) => ({
                    _tag: "Failed",
                    reason: `Coupon ${error.code} was rejected.`,
                  }),
                  onSuccess: (discount) => ({
                    _tag: "CouponAccepted",
                    discount,
                  }),
                },
              ),
            ),
          ),
        ]
      : { ...state, error: "You appear to be offline." },

  CouponAccepted: (action, { state }) => ({ ...state, discount: action.discount }),

  CheckoutRequested: (_action, { state, props }) => [
    { ...state, checkout: "reserving" as const, error: null },
    Command.stream(
      Stream.flatMap(Stream.fromEffect(CartApi), (api) =>
        api.checkout(props.customerId, state.lines),
      ).pipe(
        Stream.map(progressToAction),
        Stream.catchTag("CheckoutFailed", (error) =>
          Stream.succeed({ _tag: "Failed" as const, reason: error.reason }),
        ),
      ),
    ),
  ],

  CheckoutAdvanced: (action, { state }) => ({ ...state, checkout: action.stage }),

  /**
   * The old version reached for `props.onCheckout` inside `Command.effect` — an
   * untyped function call, invisible to the log, and the reason `callback` had
   * to exist in the props schema at all.
   *
   * Now it emits a value. The parent is still called, but by the runtime rather
   * than by this handler, so the announcement is a schema, it encodes, and the
   * devtools event carries `cause: { _tag: "Output", … }` linking whatever the
   * parent does next back to this line.
   */
  CheckoutCompleted: (action, { state }) => [
    { ...state, checkout: "idle" as const },
    Command.stream(Stream.succeed({ _tag: "OrderPlaced" as const, orderId: action.orderId })),
  ],

  Failed: (action, { state }) => ({
    ...state,
    checkout: "idle" as const,
    error: action.reason,
  }),

  PropsChanged: (action, { props, state }) =>
    props.customerId === action.previous.customerId
      ? state
      : {
          lines: [],
          discount: 0,
          checkout: "idle" as const,
          error: null,
        },

  HookChanged: (action, { state, hooks }) =>
    hooks.online === action.previous.online
      ? state
      : { ...state, error: hooks.online ? null : "Reconnecting…" },

  Unmounted: (_action, { state, props }) => [
    state,
    Command.effect(Effect.flatMap(CartApi, (api) => api.release(props.customerId))),
  ],
});

/**
 * `dispatch` covers the declared actions and nothing else. It does not cover
 * outputs, so no button in here can announce something that did not happen — and
 * with queries cut, this is the only place a checkout can start, which is where it
 * belonged.
 */
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

export const cart = Cart.create({
  initialState,
  reducer,
  render,
});

/**
 * The whole outbound interface as one type, and correct for any number of outputs
 * — `typeof OrderPlaced.Type` only worked because there happened to be one.
 */
export type CartOutput = typeof CartOutputs.Type;

// --- the parent side ------------------------------------------------------------

declare const AppLayer: Layer.Layer<CartApi>;

const { Provider, component } = createRuntime(AppLayer, {
  onEvent: (event) => {
    if (import.meta.env.DEV) {
      console.debug(`[${event.name}#${event.instance}]`, event.cause, event.action);
    }
  },
});

export const Cart_ = component(cart, { name: "cart" });

/**
 * What the boundary looks like from outside, and how little there is of it.
 *
 * The parent knows two things about the cart: the props it accepts, and the one
 * thing it announces. It cannot read `lines`, cannot dispatch `Failed`, cannot
 * observe `checkout: "charging"`, and has no handle to reach in with.
 *
 * Compare `app.tsx`, where the same component is used today. The only difference
 * at the call site is `onCheckout={(orderId) => …}` becoming
 * `onOrderPlaced={({ orderId }) => …}` — which is the entire user-facing cost of
 * moving outbound traffic out of the props schema.
 */
export function Checkout({ customerId }: { readonly customerId: string }): ReactNode {
  const [currency, setCurrency] = useState<"EUR" | "USD">("EUR");

  return (
    <Provider>
      <select
        value={currency}
        onChange={(event) => setCurrency(event.target.value as typeof currency)}
      >
        <option value="EUR">EUR</option>
        <option value="USD">USD</option>
      </select>

      <Cart_
        customerId={customerId}
        currency={currency}
        // Derived from `outputs`, and required. Adding a second output breaks this
        // call site — and every other one — rather than quietly going unheard.
        // `_tag` is stripped, so the payload destructures directly.
        onOrderPlaced={({ orderId }) => console.info("ordered", orderId)}
      />
    </Provider>
  );
}

// --- what a feature test reads like ---------------------------------------------

/**
 * The assertion a parent's contract actually depends on, and the one `reduce`
 * alone could never make: *given a checkout, this feature announces exactly one
 * `OrderPlaced`.* Commands run against a test layer, what they emit feeds back
 * in, and what left is reported separately from what stayed.
 */
declare const TestCartApi: Layer.Layer<CartApi>;

export const checkoutAnnouncesTheOrder = Effect.map(
  cart.run([{ _tag: "Mounted" }, { _tag: "CheckoutRequested" }], {
    props: { customerId: "c1", currency: "EUR" },
    hooks: { catalog: { stale: false }, online: true },
    layer: TestCartApi,
  }),
  ({ state, outputs }) => ({
    settled: state.checkout === "idle",
    // `guards` comes with the vocabulary; no hand-written tag comparison.
    placed: outputs.filter(CartOutputs.guards.OrderPlaced),
  }),
);
