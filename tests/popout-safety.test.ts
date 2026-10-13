import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pop-out windows have their own `document` and `window`. The bare globals refer to the MAIN
// window, so using them for focus checks, timers, frames, or listeners silently breaks the
// search box (wrong target, stolen focus, rAF never firing) only when the user works in a
// pop-out. Use `activeDocument`/`activeWindow`, or derive the window from the element:
// `el.ownerDocument` / `el.ownerDocument.defaultView`.
//
// Deliberate main-document uses (e.g. hooking the main document's listeners, or sweeping it in
// removeAllWidgets) are fine and are not matched by these patterns.
const FORBIDDEN: Array<[RegExp, string]> = [
  [/(^|[^\w.])document\.(activeElement|querySelector|querySelectorAll|body)\b/, "document.<focus/query/body>"],
  [/(^|[^\w.])window\.(requestAnimationFrame|setTimeout|setInterval|addEventListener|removeEventListener|getSelection)\b/, "window.<timer/listener/selection>"],
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("pop-out window safety (static scan)", () => {
  for (const file of ["src/main.ts", "src/widget.ts", "src/session.ts"]) {
    it(`${file} never uses main-window document/window for focus, timers, or listeners`, () => {
      const src = stripComments(readFileSync(join(__dirname, "..", file), "utf8"));
      for (const [re, label] of FORBIDDEN) {
        const m = src.match(re);
        expect(m, `${file}: found main-window-only ${label}: "${m?.[0]}"`).toBeNull();
      }
    });
  }
});
