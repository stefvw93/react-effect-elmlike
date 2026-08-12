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
