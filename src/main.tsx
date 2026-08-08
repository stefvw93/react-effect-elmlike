/**
 * The dev shell, and nothing more.
 *
 * `lib/tea.ts` is a type surface — every value in it is `declare`d — so there is
 * no runtime to mount a blueprint against yet. `examples/app.tsx` is the wiring
 * this file will render once there is one; until then it typechecks and does not
 * run, which is the honest state of the project.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
