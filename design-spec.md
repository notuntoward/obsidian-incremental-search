# Obsidian Swiper-Style Incremental Search — Design Spec

## Goal

Recreate the core UX of Emacs `swiper` inside Obsidian's editor: live fuzzy highlighting of all matches in the visible buffer as you type, directional search from the current cursor position, in-session direction toggling, jump-to-match on Enter, and query memory across invocations.

Obsidian's editor is CodeMirror 6 (CM6) under the hood, and the plugin API exposes the primitives needed to build this without forking the editor: `ViewPlugin`, `Decoration`/`DecorationSet`, `SearchCursor`/`RegExpCursor` (from `@codemirror/search`), keymap `Extension`s, and `EditorSelection` for cursor placement.

## Feature Checklist

| # | Feature | Status in spec |
|---|---|---|
| 1 | Fuzzy match highlighting across whole visible buffer, live as you type | Core |
| 2 | Forward search from cursor position | Core |
| 3 | Backward search from cursor position | Core |
| 4 | Toggle direction mid-search (`Ctrl+S` / `Ctrl+R`) without losing query | Core |
| 5 | Enter places cursor on current match | Core |
| 6 | Double-tap hotkey reuses last query | Core |
| 7 | Distinct highlight for current match vs. other matches | Core |
| 8 | Live match count ("3/17") | Recommended |
| 9 | Wrap-around at buffer start/end | Recommended |
| 10 | Smart case folding (lowercase = insensitive, any uppercase = sensitive) | Recommended |
| 11 | Escape restores original cursor position | Recommended |
| 12 | Auto-scroll active match into view | Recommended |

## Architecture

### 1. Plugin-level state (not CM state)

A plain field on the `Plugin` subclass, persisted via `saveData()`/`loadData()`:

```ts
interface SwiperSearchSettings {
  lastQuery: string;
}
```

This survives across command invocations and Obsidian restarts. It is intentionally kept outside CodeMirror's `StateField` system because it doesn't need to be part of undo history or editor transactions.

### 2. Search session state (CM6 `StateEffect` + `StateField`)

A `StateField<SearchSessionState | null>` holds the ephemeral session while the search UI is open:

```ts
interface SearchSessionState {
  query: string;
  direction: "forward" | "backward";
  matches: { from: number; to: number }[];
  activeIndex: number;
  originSelection: { anchor: number; head: number }; // for Escape restore
}
```

The field is updated via `StateEffect.define<Partial<SearchSessionState>>()` dispatched from the input widget's keydown/input handlers. When the field's value is `null`, the decoration `ViewPlugin` renders nothing.

### 3. Decorations (`ViewPlugin`)

A `ViewPlugin` reads the current `SearchSessionState` from the state field on every update and rebuilds a `DecorationSet` restricted to `view.visibleRanges` for performance on long notes:

- All matches → `Decoration.mark({ class: "swiper-match" })`
- The match at `activeIndex` → `Decoration.mark({ class: "swiper-match-current" })`

Only visible-range text is scanned for decoration purposes; the underlying match list itself is computed over the *full document* (via `SearchCursor`/`RegExpCursor`) so wrap-around and match counts stay accurate even for off-screen matches.

### 4. Matching engine

- Literal/regex matching: `RegExpCursor` from `@codemirror/search`, which already supports case folding and doesn't require reimplementing scanning logic.
- Fuzzy matching: since CM6's search module is literal/regex only, "fuzzy" behavior (matching non-contiguous characters, like `fzf`/Ivy's flex matching) needs a custom scorer. The scaffold ships with a simple subsequence-matcher; swap in `fuzzysort` or Obsidian's internal fuzzy-match utilities for closer parity with swiper/Ivy.

### 5. Keymap / commands

Registered via `editor.cm` (the exposed CM6 `EditorView`) as a CM6 `keymap` extension scoped to when the session state is non-null, plus a global Obsidian command for the initial hotkey:

- Global hotkey (e.g. `Ctrl+Alt+S`) — opens search widget; if pressed again within N ms with no typed input, pre-fills `lastQuery` and jumps straight to first match.
- `Ctrl+S` inside search widget — advance forward / flip direction to forward and advance.
- `Ctrl+R` inside search widget — advance backward / flip direction to backward and advance.
- `Enter` — commit: move `EditorSelection` to `activeIndex` match, close widget, save query to `lastQuery`.
- `Escape` — restore `originSelection`, close widget, discard session.

### 6. UI widget

A small floating input rendered via Obsidian's `Menu`-adjacent DOM APIs or a simple absolutely-positioned `div` appended to the editor's DOM, containing:

- Text input (bound to `query`)
- Match counter text node ("3/17")
- Direction indicator (▲/▼)

This mirrors swiper's minibuffer-based UI without needing a full modal.

## Non-Obvious Behaviors Worth Preserving

- **Wrap-around**: when `activeIndex` exceeds `matches.length - 1` going forward, wrap to `0`; going backward past `0`, wrap to `matches.length - 1`.
- **Smart case**: if `query` contains any uppercase character, force case-sensitive matching; otherwise case-insensitive. Recompute on every keystroke.
- **Scroll-into-view**: after every index change, dispatch `EditorView.scrollIntoView(pos, { y: "center" })` so the active match is never off-screen even though matches list spans the full document.
- **Debounce large notes**: for documents above a size threshold (e.g. 50k characters), debounce the match recomputation (~50–80ms) so typing doesn't stutter.

## File Layout for the Scaffold

```
obsidian-swiper-search/
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
└── main.ts
```

The accompanying scaffold file (`main.ts`) implements items 1–7 from the checklist (the "Core" tier) plus wrap-around, scroll-into-view, and smart case folding from the "Recommended" tier, as a working starting point. It uses a simple subsequence fuzzy matcher; swap in a proper fuzzy-scoring library for production-quality ranking.

## Suggested Next Steps

1. Scaffold the plugin locally with the Obsidian sample plugin template or the files provided here.
2. Wire up `esbuild` per Obsidian's standard plugin build process.
3. Load as an unpacked plugin in a test vault (`.obsidian/plugins/obsidian-swiper-search/`).
4. Iterate on the fuzzy scorer and match-highlight CSS to taste.
5. Consider publishing to the community plugin list once stable — no existing plugin currently fills this exact niche.
