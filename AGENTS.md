# Agent Instructions for this Obsidian plugin template

## Project-specific regression risks (read this first)

This codebase has a small number of load-bearing invariants that are easy for
an AI agent to break without any test or type error, because they involve
monkey-patching shared/global objects and undocumented PDF.js internals. If
your change touches any of the areas below, read the cited code and tests
before editing, and extend the cited test alongside your change.

- **PDF search always uses the native path.** `createPdfViewAdapter()` in
  `src/pdf/pdf-view-adapter.ts` unconditionally defines `executeNativeFind`, so
  `src/pdf/pdf-match-controller.ts` always delegates search to PDF.js's own
  `PDFFindController`. An older "custom/manual scan" path (`scanPage`,
  `pattern-matcher.ts`, `match-geometry.ts`, `text-model.ts`, and most of
  `highlight-layer.ts`) was deleted in full because it was unreachable in
  production. Do not re-add a parallel matching/highlighting path "for
  robustness" without first proving some real adapter can lack
  `executeNativeFind` — if you can't prove it, the code is dead on arrival.

- **Global/shared-object monkey-patches must stay instance-scoped, and every
  patch needs a restoration test.** `setupFindControllerHook()` in
  `pdf-match-controller.ts` patches `HTMLElement.prototype.scrollIntoView`
  (a browser-wide prototype) and several undocumented PDF.js internals
  (`findController.match`, `findController.scrollMatchIntoView`,
  `pdfViewer._setCurrentPageNumber`, `pdfViewer._scrollIntoView`,
  `pdfViewer.scrollPageIntoView`). The viewer-level patches are applied to
  *resolved instances only, never to a shared prototype* — see the comment
  above `candidateViewers` explaining why (an arrow function closing over a
  shared prototype object invokes the original with the wrong `this` for
  every other viewer sharing it). `destroy()` must restore every one of
  these to the exact original function. `tests/pdf-match-controller.test.ts`
  has dedicated regression tests for this: "restores the exact original
  HTMLElement.prototype.scrollIntoView on destroy" and "isolates per-viewer
  method patches across two simultaneous controllers". If you change what
  gets patched or how `destroy()` restores it, update or add to those tests
  in the same change — a passing build/typecheck will NOT catch a broken
  restore, since nothing else exercises it.

- **The two scroll-suppression timers are real behavior, not incidental
  constants.** `requestMatchScroll()`'s 2000ms window and
  `markProgrammaticScroll()`'s 400ms window in `pdf-match-controller.ts` are
  covered by fake-timer tests in the "scroll-suppression timing windows"
  block of `tests/pdf-match-controller.test.ts`. Changing either duration or
  removing a `clearTimeout` call will fail those tests; do not delete them to
  "simplify" the suite.

- **There is exactly one canonical "current match" selector.** Do not
  hard-code `.highlight.selected`, `.highlight.is-selected`, or
  `.incsearch-pdf-match.is-current` anywhere under `src/pdf/`. Import
  `NATIVE_CURRENT_MATCH_SELECTOR`, `NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR`,
  `CURRENT_MATCH_SELECTOR`, `MATCH_ELEMENT_CLASS_TOKENS`, or
  `isMatchElementCandidate` from `src/utils/scroll.ts` instead (see the
  comment block above `NATIVE_CURRENT_MATCH_SELECTOR` there for why this
  exists). `tests/scroll.test.ts` has a static source-scan test, "never
  re-inlines a hardcoded current-match class string in src/pdf/**", that
  fails the build if this rule is violated — do not weaken or delete it.

- **Debug logging must stay silent by default.** Use `logDebug` from
  `src/utils/logger.ts` for diagnostics, never a bare `console.log`.
  `logDebug` only prints to the console when `settings.debugLogging` is
  `true` (default `false`), per Obsidian's plugin guideline that the
  developer console should show nothing but errors by default. Do not bypass
  this gate.

- **The plugin id is `incremental-search`, not `obsidian-incremental-search`.**
  Obsidian's community-plugin submission rules forbid an id containing
  "obsidian". Command IDs are namespaced by the manifest id
  (`incremental-search:forward`, etc.) — do not reintroduce the old id or
  string-match against it anywhere.

- **Never mutate `pdfViewer.currentPageNumber` before `executeNativeFind` to
  "steer" the initial match selection.** PDF.js's `PDFFindController` uses
  its own internal `_selected.pageIdx / _selected.matchIdx` state — not
  `currentPageNumber` — to decide where scanning begins. Setting
  `currentPageNumber` before a search is a side-effectful no-op at best and
  actively harmful at worst: it can cause PDF.js to start scanning from the
  wrong page and select matches that are completely above or below the
  visible viewport. An earlier `alignToViewportPage()` helper was an example
  of this anti-pattern and was removed. Do not re-introduce it.

- **Scroll suppression must use match-element geometry, not page geometry.**
  `isPageCompletelyOffScreen` answers "is any pixel of this page visible?",
  not "is this specific match visible?". A page can be 90% off-screen with
  only its footer in view while the selected match is near its header. Always
  reach for `getCompoundMatchBoundingRect` + `scrollTargetIntoViewIfNeeded`
  (from `src/utils/scroll.ts`) to make the visibility decision, regardless of
  whether PDF.js provides an `element` argument in `scrollMatchIntoView` or
  only page-level `{ pageIdx, matchIdx }` params. The page-level path is a
  timing-only fallback (element not yet in the DOM), not a different code path
  with different geometry logic.

- **Tests for PDF scroll behaviour must use realistic element geometry, not
  just internal-state assertions.** A test that only checks "was
  `currentPageNumber` set?" or "was `executeNativeFind` called?" does not
  prove that the viewport moved (or did not move). Every scroll-suppression
  fix must be accompanied by a test that:
  1. Creates actual `HTMLElement` mocks with `getBoundingClientRect` returning
     real viewport-relative coordinates.
  2. Attaches those elements to the mock `containerEl` so
     `getCompoundMatchBoundingRect` can find them via `querySelectorAll`.
  3. Asserts `scrollBy` / `scrollTo` are **not** called when the match is
     already within the container rect, and **are** called with the correct
     delta when the match is outside it.
  Tests that skip geometry mocks give false confidence and have historically
  allowed the bugs described above to ship.

- **Initial search steering across multi-page/boundary viewports must queue
  deferred matches (`pendingSteeredMatches`) to avoid skipping matches on
  forward advance.** When a PDF view straddles a boundary between visible pages
  (e.g., bottom of Page 3 and top of Page 4), PDF.js often delivers an on-screen
  match on the later page because its internal cursor started there, even though
  an earlier match is visible in the viewport on the preceding page.
  `setupFindControllerHook` steers the initial selection to the true earliest
  visible match in reading order. Crucially, PDF.js's native `PDFFindController`
  stores its selection in private state (`#selected`); mutating
  `findController._selected` does NOT change PDF.js's internal pointer. If the
  controller immediately dispatches `executeNativeFind({ type: "again" })` on the
  next user advance, PDF.js advances from its own delivered match rather than our
  steered match, skipping all intermediate matches (e.g., jumping from Match 17
  to 18, skipping 17). Therefore, steering must populate
  `pendingSteeredMatches`, and `advance("forward")` must consume this queue
  before delegating to native find. Any change to `advance()` or initial
  search steering must preserve this synchronization; see
  `tests/pdf-match-controller.test.ts` ("does not skip the true next match when
  advancing forward after initial search steering").

- **Minimal scrolling ("just enough") must expose the complete match outline box
  in all four directions using `DEFAULT_SCROLL_PADDING`.** Current match
  elements have CSS outline styling (`2px solid`, `outline-offset: 1px`,
  `margin: -2px -1px`) that extends 3–5px beyond the text node's bounding rect.
  If minimal scrolling (`computeMinimalAxisDelta`, `computeScrollDeltas`,
  `scrollTargetIntoViewIfNeeded`) uses zero padding, elements touching or flush
  with the viewport edge will report `delta = 0` and `isOff = false`, cutting off
  the outline border against the container or toolbar edge. Always default to
  `DEFAULT_SCROLL_PADDING = 8` (defined in `src/utils/scroll.ts`) across all four
  directions (above, below, left, right). Do not pass `padding: 0` or remove
  padding buffers. Minimal scroll applies when a match is partially visible; if a
  match is entirely off-screen along an axis, it centers. This is guarded by
  "performs minimal scroll in all four directions (above, below, left, right) to
  expose the full match box with padding buffer" and "never passes padding: 0" in
  `tests/scroll.test.ts`.

## Build verification rule

This project produces a pre-built artifact (`main.js`) that the Obsidian runtime
loads directly. After editing any source file under `src/`, you MUST:

1. Run `npm run build`.
2. Grep the built `main.js` for a fingerprint of your change to confirm the
   bundle on disk reflects the edit.

Do not declare a task done without grepping the built artifact for evidence.

## Tooling

- Lint: `npm run lint` (ESLint with `eslint-plugin-obsidianmd` rules, zero warnings).
- Type-check + bundle: `npm run build`.
- Unit tests: `npm run test:run` (Vitest). `obsidian` resolves to a mock in
  `tests/__mocks__/obsidian.ts`.
- Browser tests: `npm run test:browser` (Playwright, requires
  `npx playwright install chromium`).

## When building an Obsidian plugin inside a git worktree

If the vault loads this plugin via a junction to the main checkout, a build
inside a worktree is not automatically visible to Obsidian. Re-point the vault
junction with the shared relink script, or finish tests in the worktree and
build in the main checkout. See the global rule in `~/.config/kilo/AGENTS.md`.

# Obsidian Plugin Development Rules

## System Prompt & Core Directive
You are an expert Obsidian Plugin Development Assistant. When writing or refactoring code for this environment, your highest priority is to **leverage native Obsidian API facilities**. 

> **CRITICAL RULE:** Do not reinvent the wheel. Never write custom string manipulation, regex parsers, or manual serialization for tasks already handled by the core Obsidian API (e.g., frontmatter/YAML parsing, file reading/writing, DOM generation).

---

## 1. Architectural Constraints & Native APIs

Always map tasks to the correct native sub-system on the global `app` instance. Do not use generic Node.js or browser equivalents if an Obsidian API exists.

| Use Case | Native Obsidian Class/Method | Avoid This Pattern |
| :--- | :--- | :--- |
| **Frontmatter/YAML Mutation** | `app.fileManager.processFrontMatter(file, (fm) => {})` | Regex parsing, manual string building, string splitting |
| **Reading Frontmatter Cache** | `app.metadataCache.getFileCache(file).frontmatter` | Re-reading and parsing the entire file from disk |
| **File Safe I/O** | `app.vault.cachedRead(file)`, `app.vault.process(file, ...)` | Generic `fs` modules, raw string overwrites |
| **UI Component Generation** | `containerEl.createEl()`, `Setting` class | Raw `document.createElement()` or template literal innerHTML |
| **User Interaction/Pickers**| `SuggestModal`, `FuzzySuggestModal` | Custom inputs or raw dropdown DOM implementations |

### Handling Metadata Cache Coordinates
When copying or extracting frontmatter from `metadataCache`, always strip the position tracking data to avoid metadata corruption:
```typescript
const fm = { ...cache.frontmatter };
delete fm.position; // Crucial step before cloning/pasting
```

---

## 2. Project Setup & Environment Discovery

### Cold-Start Protocol (Blank Repository)
If you are initialized in a completely empty or blank repository, **do not attempt to author the environment configurations from scratch.** You must establish the environment using one of the following methods immediately:

1. **Preferred (Template Pull):** Pull the official ecosystem boilerplate directly into the root directory:
   ```bash
   npx degit obsidianmd/obsidian-sample-plugin . --force
   npm install
   ```
2. **Manual Typing Bootstrap:** If you must initialize manually, you must fetch the native API type definitions right away to generate the reference files:
   ```bash
   npm init -y
   npm install --save-dev obsidian
   ```
   *Note: This exposes the API definitions inside `node_modules/obsidian/obsidian.d.ts`.*

### Repository Structure
All active projects must structurally align with the official sample plugin:
* Ensure `esbuild.config.mjs` handles compilation. Do not invent custom build pipelines.
* Distribution requires exactly three core files in the vault plugin directory:
  1. `main.js` (bundled code)
  2. `manifest.json` (plugin metadata)
  3. `styles.css` (if custom styles are required)

### API Reference Protocol
1. **Primary Reference:** Scan `obsidian.d.ts` inside the project root (or inside `node_modules/obsidian/`) before suggesting any method. This is the ultimate source of truth for types, methods, and lifecycle hooks (`onload`, `onunload`).
2. **Online Documentation:** Supplement knowledge using `docs.obsidian.md` for ecosystem guides regarding the leaf/workspace architecture.

---

## 3. UI and DOM Generation Guidelines

* Maintain theme consistency by utilizing built-in CSS variables (e.g., `--text-normal`, `--background-primary`).
* Never pollute the DOM outside of your allocated containers (`PluginSettingTab`, `WorkspaceLeaf`, `Modal`).
* Clean up global listeners, status bar elements, and intervals inside the `onunload()` method to prevent memory leaks.
