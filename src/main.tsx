import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Effect, Schema } from "effect";
import { Program } from "./lib";

const App = Program.make({
  model: Schema.Struct({
    count: Schema.Number,
  }),

  message: [
    Schema.TaggedStruct("Inc", { by: Schema.Number }),
    Schema.TaggedStruct("Dec", { by: Schema.Number }),
    Schema.TaggedStruct("Reset", {}),
  ],

  view: (model, dispatch) => (
    <main>
      <div>
        <button type="button" onClick={() => dispatch({ _tag: "Dec", by: 1 })}>
          - 1
        </button>
        <output>count is {model.count}</output>
        <button type="button" onClick={() => dispatch({ _tag: "Inc", by: 1 })}>
          + 1
        </button>
      </div>

      <button type="button" onClick={() => dispatch({ _tag: "Reset" })}>
        reset
      </button>
    </main>
  ),
}).pipe((program) =>
  Program.init(program, {
    update: {
      Inc: (msg, model) => [
        { count: model.count + msg.by },
        [Effect.succeed({ _tag: "Reset" }), Effect.succeed({ _tag: "Reset" })],
      ],
      Dec: (msg, model) => ({ count: model.count - msg.by }),
      Reset: () => ({ count: 0 }),
    },
  }),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App count={0} />
  </StrictMode>,
);
