/**
 * `search.tsx` in a real browser.
 *
 * The demo's headline behaviour is the one the command-leaf redesign rewrote:
 * each keystroke cancels the keystroke before it, mid-delay, and only the last
 * one reaches the service. That used to be a `"restart"` policy the runtime
 * interpreted; the handler now writes `Command.restart("query", …)` — sugar
 * for a `Cancel` sequenced ahead of a `keyed` leaf, not a policy. The
 * observable behaviour has to be identical across all three spellings, and a
 * counting fake service is what says so.
 *
 * The node suite cannot answer this one: the debounce is only meaningful
 * against real typing into a real input, where each `change` is a separate
 * event and the interrupt lands between them.
 */

import { Effect, Layer } from "effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";
import { createRuntime } from "../lib/tea";
import { search, SearchApi } from "./search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// A service that counts what actually reached it
// ---------------------------------------------------------------------------

const queries: Array<string> = [];

const TestSearchApi = Layer.succeed(SearchApi, {
  query: (text: string) =>
    Effect.sync(() => {
      queries.push(text);
      return [`${text} — first hit`, `${text} — second hit`];
    }),
});

const { component } = createRuntime(TestSearchApi);
const Search = component(search, { name: "search" });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Search filter="all" placeholder="Search…" />));
  return container;
};

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  queries.length = 0;
});

/**
 * Type into the search box the way a user does: set the value, then fire the
 * event React listens for. `input.value = …` alone changes nothing React can
 * see, and `change` on a React-controlled input is delivered as `input`.
 */
const type = async (text: string) => {
  const input = container!.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.bind(
      input,
    );
    setter(text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const hits = () => Array.from(container!.querySelectorAll("li")).map((li) => li.textContent);

/**
 * Let the debounce elapse *inside* `act`, so the dispatch the command makes
 * when it resolves is a React update React knows about. Polling with
 * `vi.waitFor` observes the same end state, but every repaint it waits for
 * lands outside `act` and React logs a warning for each — noise that would
 * drown the one thing worth reading in this file's output.
 */
const settle = async (ms = 500) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

// ---------------------------------------------------------------------------

test("a keystroke paints as pending, then paints the hits it debounced into", async () => {
  await mount();
  await type("effect");

  // Pending is the state the handler wrote synchronously; the query itself is
  // still 300ms away, so nothing has reached the service yet.
  expect(container!.querySelector("ul")?.getAttribute("aria-busy")).toBe("true");
  expect(queries).toEqual([]);

  await settle();

  expect(queries).toEqual(["effect"]);
  expect(hits()).toEqual(["effect — first hit", "effect — second hit"]);
  expect(container!.querySelector("ul")?.getAttribute("aria-busy")).toBe("false");
});

test("each keystroke interrupts the one before it, so only the last query is sent", async () => {
  await mount();

  // Four keystrokes inside one debounce window. Under the old `"restart"`
  // policy the runtime superseded the in-flight fiber; now the handler's
  // `Command.restart` desugars to a cancel ahead of the replacement. Either
  // way the user typed one word and the service must see one query.
  await type("e");
  await type("ef");
  await type("eff");
  await type("effect");

  await settle();

  expect(queries).toEqual(["effect"]);
  expect(hits()).toEqual(["effect — first hit", "effect — second hit"]);
});

test("emptying the box cancels the pending query instead of merely ignoring it", async () => {
  await mount();
  await type("effect");
  await type("");

  await settle(600);

  // The paint half is the weak half: the `for` guard on `HitsArrived` stops a
  // stale response repainting an emptied box whether or not anything was
  // cancelled, so asserting only this passes against the bug.
  expect(hits()).toEqual([]);
  expect(container!.querySelector("input")!.value).toBe("");

  // The request half is the one that discriminates. Without the cancel on the
  // reset path the query is still sent 300ms after the user emptied the box.
  expect(queries).toEqual([]);
});

test("the clear button cancels the pending query too", async () => {
  await mount();
  await type("effect");

  // Same reset, reached the other way — through the `Cleared` action rather
  // than through `TextEdited` with empty text. Both paths reset state, so both
  // have to interrupt, and only one of them was written first.
  // By its text, not by position: the clear button is the only one today and
  // is rendered only while the box has text, so a bare `querySelector("button")`
  // would silently start clicking something else the day a second one appears.
  const button = Array.from(container!.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "clear",
  )!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  await settle(600);

  expect(queries).toEqual([]);
  expect(hits()).toEqual([]);
});

test("changing the filter re-runs the query that is in the box", async () => {
  await mount();
  await type("effect");
  await settle();
  expect(queries).toEqual(["effect"]);

  // `PropsChanged` re-dispatches `TextEdited`, so the re-run goes through the
  // same handler — and therefore through the same cancel — rather than
  // duplicating the command at a second site.
  await act(async () => root!.render(<Search filter="docs" placeholder="Search…" />));
  await settle();

  expect(queries).toEqual(["effect", "effect"]);
});
