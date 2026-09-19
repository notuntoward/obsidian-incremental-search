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
