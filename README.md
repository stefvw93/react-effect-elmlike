# react-effect

A TEA-style feature runtime for React, built on Effect. A feature is declared as
a **blueprint** — schema-typed props and state, a tagged action vocabulary, an
optional outbound output vocabulary, optional ambient hooks, and a reducer — and
the runtime interprets the `Command` values the reducer returns.

The full specification, including every design decision and the reasoning behind
it, lives in [`src/lib/tea.specs.md`](src/lib/tea.specs.md).

## The surface

```tsx
const Cart = define({
  props: Schema.Struct({ customerId: Schema.String }),
  state: Schema.Struct({ items: Schema.Array(Item) }),
  action: Action.of([Added, Removed]),
  output: Action.of([Action.output("OrderPlaced", { orderId: Schema.String })]),
});

export const cart = Cart.create({ initialState, reducer, render });
```

A blueprint is inert: `cart.reduce(action, snapshot)` is the whole reducer as one
pure function, and `cart.run(actions, options)` folds a sequence and reports what
was emitted — both without React.

Props are schema values, validated and never decoded. `children` is the one that
cannot be, so it is declared instead — at whatever type the feature accepts:

```tsx
children: Children; // ReactNode
children: Children.as<(row: Row) => ReactNode>(); // a render prop
children: Schema.optionalKey(Children); // optional
```

The type argument is the whole contract; the schema carries no structure and
validates anything. `render` receives the real value, so `{props.children}` — or
`props.children(row)` — works as it does in any component. The state machine
does not: children never raise `PropsChanged`, and devtools print `"<children>"`
in their place rather than an element tree.

Declared plainly the key is **required**, which is worth saying for a feature
that cannot render without children. JSX that passes none (a comment counts as
none) omits the key rather than passing `undefined`, and props are validated with
`onExcessProperty: "error"` — hence `optionalKey` for the optional case.

## Commands

A reducer returns the next state and, optionally, a `Command`. The leaf is an
`Effect` handed a `dispatch`, so everything Effect can already express is left to
Effect — a command that emits nothing simply ignores the parameter:

```ts
Added: (action, { state }) => [
  next,
  Command.effect(() => Effect.all([persist(next), track(action)])),
];
```

Concurrency is userland. Debounce, throttle, switch-to-latest and run-at-most-N
are Effect combinators written inside the effect, not a policy vocabulary the
runtime interprets. What the runtime does own is the one thing a handler cannot
do for itself: naming a running fiber so a _different_ action's handler can
interrupt it. A group is one string name — `Command.keyed(name)` sets a
command's whole address, an unkeyed command books under its issuing action's
tag, and `Command.cancel(name)` interrupts that one group. Take-latest is the
common case, so it is one word:

```ts
TextEdited: (action, { state }) => [
  { ...state, text: action.text, pending: true },
  Command.restart(
    "query",
    Command.effect((dispatch) =>
      Effect.sleep("300 millis").pipe(
        Effect.andThen(search(action.text)),
        Effect.flatMap((hits) => dispatch({ _tag: "HitsArrived", hits })),
      ),
    ),
  ),
];
```

`Command.restart(name, command)` is pure sugar for
`Command.batch(Command.cancel(name), Command.keyed(name, command))` — the
cancel sequenced ahead of the replacement — so devtools show the desugared
batch and the hand-written pair stays available wherever the sugar does not
fit.

A long-lived source is `Stream.runForEach(source, dispatch)` inside the same
leaf, so the whole `Stream` vocabulary stays available one call earlier.

`dispatch` is typed by the feature's own action vocabulary, which reaches the
leaf through the handler's contextual type. Two places that context cannot
reach, both by TypeScript's rules rather than this library's: a `.pipe` receiver
(so `Command.keyed(key, command)` and `Command.restart(name, command)` exist
alongside their curried forms), and a command hoisted into a `const` (name the
type there: `Command.effect<MyAction>(…)`).

To mount one, build a root runtime once and turn blueprints into components:

```tsx
const { Provider, component, useRuntime } = createRuntime(AppLayer);

const Cart = component(cart);

<Provider>
  <Cart customerId="c1" onOrderPlaced={({ orderId }) => navigate(orderId)} />
</Provider>;
```

`component` is closed over the root's services, so a feature needing something
the root does not provide is a compile error rather than a runtime failure. Each
declared output becomes one **required** `on<Tag>` prop, so adding an output is
caught at every call site.

`createFeatureStore` and `FeatureStore` are also exported: the headless half of
the runtime, driveable without a DOM. `component` is the only intended caller —
they are exported so the live fold is testable directly.

## Devtools

Every transition, command, output and defect, as a redux-logger-style console
group. It is a **service in the root layer**, not an option on the runtime:

```ts
import { consoleDevtoolsLayer } from "./lib";

const { Provider, component } = createRuntime(
  Layer.mergeAll(AppLayer, import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty),
);
```

Both branches are `Layer<never>`, so merging it moves neither the root's `R` nor
any `component(bp)` call, and a production build keeps only the ternary.

Being a service is the point: `devtoolsLayer(sink)` installs any
`{ onEvent: (event: DevtoolsEvent) => void }`, so the console logger swaps for a
`postMessage` transport or, in a test, `createRecorder()`:

```ts
const recorder = createRecorder();
const store = createFeatureStore({
  ...args,
  runtime: ManagedRuntime.make(devtoolsLayer(recorder.sink)),
});
store.start();
recorder.events; // every event, in emission order
```

**The sink is synchronous, because the fold is.** An `Effect`-returning sink
would put a forked fiber and a scheduler hop on the hottest path in the library,
and the log could land after the state it describes had already moved. When no
sink is installed the emission sites allocate nothing at all.

Every event is encodable, which is what makes a transport sink possible: a
command's effect is erased to a `CommandSummary` and a defect's `Error` to a
`DefectSummary`, because an `Error` `JSON.stringify`s to `{}` and a function
makes `structuredClone` refuse the whole message.

Two things it does not see. Nothing is reported before `start()` — the root
context does not exist until the runtime's first `runFork` — so a first-render
`sync` and a descendant's layout-effect dispatch fall in that window, and an
asynchronous root layer widens it until the layer resolves. And an output
crossing into a parent's `on<Tag>` prop is reported as an `Output` event, but
whatever the parent dispatches next is _not_ attributed to it: the output leaves
through a plain React callback into arbitrary user code, so the runtime cannot
see what happened there and does not guess.

## Testing

- `vp test` — unit and reducer tests (node, no DOM).
- `vp test --config vitest.browser.config.ts` — real-browser tests for the React binding.
- `vp exec tstyche` — type-level tests for the compile-time guards.

---

Scaffolded from the React + TypeScript + Vite template, whose notes follow.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
