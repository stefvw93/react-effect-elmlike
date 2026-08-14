/**
 * Wiring. One provider at the root, components built from it, and ordinary
 * untyped React everywhere in between.
 *
 * The point of this file is the last one: nothing below the Provider is
 * obliged to be a blueprint. `Sidebar` and `Page` are plain components with
 * plain state, and `ReleaseButton` reaches the same services through
 * `useRuntime` without being rewritten. That is what "adopt it on the shopping
 * cart only" has to look like in practice.
 */

import { useState, type ReactNode } from "react";
import { Context, Effect, Layer } from "effect";
import { consoleDevtoolsLayer } from "../lib/devtools";
import { createRuntime } from "../lib/tea";
import { cart, CartApi } from "./cart";
import { counter } from "./counter";
import { presence, PresenceSocket } from "./presence";
import { search, SearchApi } from "./search";

// --- services the app provides ----------------------------------------------

/** A shared transport. `PresenceSocket` is built on top of it, per-component. */
class Sockets extends Context.Service<
  Sockets,
  { readonly open: (url: string) => Effect.Effect<WebSocket> }
>()("Sockets") {}

declare const AppLayer: Layer.Layer<CartApi | SearchApi | Sockets>;

/**
 * Not in the root: only the presence component needs it, and it is built *from*
 * a root service. `component` will demand exactly this residue and nothing
 * more.
 */
declare const PresenceLayer: Layer.Layer<PresenceSocket, never, Sockets>;

// --- the root ---------------------------------------------------------------

/**
 * Every transition, command, output and defect in every mounted feature, in
 * order, as an RTK-style console log. It is a service in the root layer rather
 * than an option on the runtime, so swapping the console for a `postMessage`
 * transport or a test recorder is a one-line change here and nothing else.
 *
 * Both branches are `Layer<never>`, so merging it moves neither the root's `R`
 * nor any `component(bp)` call below — and in a production build the ternary is
 * the only thing left of it.
 */
export const { Provider, component, useRuntime } = createRuntime(
  Layer.mergeAll(AppLayer, import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty),
);

// --- components -------------------------------------------------------------

export const Counter = component(counter, { name: "counter" });
export const Search = component(search, { name: "search" });
export const Cart = component(cart, { name: "cart" });

// Brings its own layer; the root covers what that layer needs in turn.
export const Presence = component(presence, { layer: PresenceLayer, name: "presence" });

// Building `presence` bare would not compile — the root has no `PresenceSocket`:
//
//   export const Broken = component(presence)
//   //                              ~~~~~~~~
//   // Blueprint<…, PresenceSocket> is not assignable to
//   // Blueprint<…, CartApi | SearchApi | Sockets>

// --- ordinary React, unaware any of this exists -----------------------------

function Sidebar({ children }: { readonly children?: ReactNode }): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <aside>
      <button onClick={() => setOpen((previous) => !previous)}>{open ? "hide" : "show"}</button>
      {open && children}
    </aside>
  );
}

/**
 * The escape hatch. A plain component, no state, no actions — but it can still
 * reach the root's services, so adopting the pattern is never all-or-nothing.
 */
function ReleaseButton({ customerId }: { readonly customerId: string }): ReactNode {
  const runtime = useRuntime();
  return (
    <button
      onClick={() => {
        runtime.runFork(Effect.flatMap(CartApi, (api) => api.release(customerId)));
      }}
    >
      Release hold
    </button>
  );
}

// --- the tree ---------------------------------------------------------------

function Checkout({ customerId }: { readonly customerId: string }): ReactNode {
  // Plain React state, driving a blueprint's props. Nothing special happens at
  // the boundary — the component just re-renders, and `PropsChanged` decides
  // whether that means anything.
  const [currency, setCurrency] = useState<"EUR" | "USD">("EUR");

  return (
    <main>
      <select value={currency} onChange={(event) => setCurrency(event.target.value as "EUR")}>
        <option value="EUR">EUR</option>
        <option value="USD">USD</option>
      </select>

      {/* Derived from `output`, and required — adding a second output breaks
          this call site rather than quietly going unheard. */}
      <Cart
        customerId={customerId}
        currency={currency}
        onOrderPlaced={({ orderId }) => console.info("ordered", orderId)}
      />

      <ReleaseButton customerId={customerId} />
    </main>
  );
}

export function App({ customerId }: { readonly customerId: string }): ReactNode {
  return (
    <Provider>
      <Sidebar>
        <Presence roomId="checkout" selfId={customerId} />
        <Counter start={0} step={1} />
      </Sidebar>

      <Search filter="all" placeholder="Find a product…" />
      <Checkout customerId={customerId} />
    </Provider>
  );
}
