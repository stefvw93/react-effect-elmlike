import react from "@vitejs/plugin-react";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

/**
 * Real-browser tests, run only by `vp test --config vitest.browser.config.ts`.
 *
 * Kept out of the default `vp test` run on purpose: the node suite is the fast
 * inner loop, and it covers the headless core (`Blueprint.reduce`, `run`,
 * `createFeatureStore`) which needs no DOM at all. What lands here is the part
 * that only a real browser can answer — that a blueprint actually paints, and
 * repaints when its state moves.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
