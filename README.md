# Obsidian Incremental Search

[![Build](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml)

A fast, keyboard-first incremental search plugin for Obsidian.

Designed for users who prefer home-row keyboard navigation—such as users of GNU Emacs (`isearch` / `swiper`) and modal editors. Search results highlight instantly in your active note or PDF as you type, and subsequent keypresses cycle seamlessly through matches without touching the mouse.

---

## Key Features

- **⚡ Instant In-Document Highlighting:** Matches highlight directly in your viewport in real time. The active match features a high-contrast outline, while secondary matches use an adaptive theme-matched fill and inset edge.
- **🎨 Adaptive Theme & Legibility Protection:** Automatically derives secondary match colors from your active theme's background and accent luminance. If background tinting reduces text readability, it automatically falls back to a non-intrusive dotted underline.
- **↔️ Directional Navigation from Cursor:** Search begins from your current cursor position. Forward and backward commands navigate through matches relative to where you are working.
- **🔍 Smart Space-as-Wildcard Matching:** Type search terms separated by single spaces to match words across arbitrary distances, lines, or paragraphs. Extra spaces match literal spaces.
- **🔤 Smart-Case Sensitivity:** Automatically searches case-insensitively when your query is all lowercase, and switches to case-sensitive matching the moment an uppercase character is typed.
- **📊 Deep Context Support (Tables, Callouts & PDFs):**
  - **Live Preview Tables:** Highlights matching table cells and displays a floating Table Toast with row/column context.
  - **Callouts:** Searches and highlights content within both collapsed and expanded callouts.
  - **PDF Documents:** Incremental search directly inside Obsidian's native PDF viewer with overlay highlights and page auto-scrolling.
- **🔄 Search Memory & Double-Tap Recall:** Pressing a search hotkey twice consecutively on an empty search recalls your previous query and continues searching in that direction.
- **👁️ On-Demand Secondary Highlighting:** Keep your screen minimal by showing only the active match, or press `Ctrl+Enter` (`Cmd+Enter` on macOS) during search to toggle highlighting for all other matches.
- **🔗 Link Target Filtering:** Avoid false positives by searching only the visible text of Markdown links and aliased wikilinks, ignoring hidden URLs and destinations.
- **⚙️ Configurable Exit Policies:** Choose between Emacs-style (`Enter` accepts, `Esc` cancels) and Obsidian-style (`Enter` finds next, `Esc` accepts) exit behavior.
- **🪟 Optional Center-Screen Modal:** Prefer a dialog over an inline floating widget? Toggle on the popup modal interface in settings.

---

## Commands & Keyboard Shortcuts

The plugin registers two commands in Obsidian's Command Palette. **Hotkeys are unassigned by default** so they never conflict with your existing keymap.

| Command Name | Command ID | Suggested Hotkey | Description |
| :--- | :--- | :--- | :--- |
| **Incremental Search: Forward** | `obsidian-incremental-search:forward` | `Ctrl+S` / `Cmd+S` or `Alt+S` | Starts or advances forward search from the cursor |
| **Incremental Search: Backward** | `obsidian-incremental-search:backward` | `Ctrl+R` / `Cmd+R` or `Alt+R` | Starts or advances backward search from the cursor |

### Assigning Hotkeys
1. Open Obsidian **Settings → Hotkeys**.
2. Search for `Incremental Search`.
3. Assign your preferred shortcuts to **Incremental Search: Forward** and **Incremental Search: Backward**.

---

## In-Search Controls

While the search widget is active, the following controls are available:

| Key Action | Emacs-Style Mode (Default) | Obsidian-Style Mode |
| :--- | :--- | :--- |
| **Type Characters** | Increments query and jumps to the nearest match in current direction | Increments query and jumps to the nearest match in current direction |
| **Forward Hotkey / `F3`** | Advance to next match | Advance to next match |
| **Backward Hotkey / `Shift+F3`** | Advance to previous match | Advance to previous match |
| **`Enter`** | **Accept match** (place cursor at current match and close search) | **Find next match** in current direction |
| **`Shift+Enter`** | Reverse direction / accept | **Find previous match** |
| **`Esc`** | **Cancel search** (restore original cursor and viewport position) | **Accept match** and close search |
| **`Ctrl+G`** | **Cancel search** (restore original position) | **Cancel search** (restore original position) |
| **`Ctrl+Enter` / `Cmd+Enter`** | Toggle highlighting of all secondary matches on/off | Toggle highlighting of all secondary matches on/off |
| **Double-Tap Search Hotkey** | Recalls last search query and advances | Recalls last search query and advances |
| **Click Outside / Switch Tab** | Dismisses widget and retains current cursor position | Dismisses widget and retains current cursor position |

---

## Search Capabilities

### 1. Space-as-Wildcard Matching Rules

When **Space-as-wildcard matching** is enabled (default), spaces between words act as flexible wildcard gaps:

| Spaces Typed | Behavior | Literal Spaces Required in Note | Example |
| :--- | :--- | :--- | :--- |
| **1 space** | `.*` (wildcard gap across words/lines) | 0 | `the KAN` matches `the original KAN` |
| **2 spaces** | Exact match requiring 1 literal space | 1 literal space | `the  KAN` matches `the KAN` |
| **3 spaces** | Exact match requiring 2 literal spaces | 2 literal spaces | `the   KAN` matches `the  KAN` |
| **N spaces** | Exact match requiring N − 1 spaces | N − 1 literal spaces | Matches exactly N − 1 spaces |

> [!TIP]
> When searching with wildcard spaces, non-current matches highlight only the matched words, keeping gaps clean and readable.

### 2. Smart-Case Sensitivity

Matching adapts automatically based on character case:
- **All lowercase:** Search is **case-insensitive** (`react` matches `react`, `React`, and `REACT`).
- **Contains any uppercase letter:** Search automatically becomes **case-sensitive** (`React` matches only `React`).

### 3. Target Environments

- **Markdown Source & Live Preview:** Full text and headings.
- **Markdown Tables:** Highlights cells with column and row awareness. When focusing a match inside a table, a toast popup previews the cell context.
- **Callouts:** Highlights text inside callouts, including collapsed callout blocks.
- **PDF Documents:** Direct overlay highlighting and page auto-scrolling in Obsidian's native PDF viewer.
- **Link Filtering:** When **Match only visible part of links** is enabled, raw URLs (`[label](https://example.com)`) and hidden wikilink destinations (`[[destination|alias]]`) are excluded from search results.

---

## Settings Reference

Access these options in Obsidian **Settings → Incremental Search**:

### 🧭 Navigation & Exit Behavior
- **Search exit behavior:** Choose how `Enter` and `Escape` conclude an active search session:
  - **Emacs-style (default):** `Enter` accepts the current match and places the cursor there; `Escape` (or `Ctrl+G`) cancels and restores your original cursor and viewport.
  - **Obsidian-style:** `Enter` advances to the next match (`Shift+Enter` to previous); `Escape` accepts the current match.

### 🎨 Match Highlighting & Appearance
- **Highlight all matches:**
  - **On demand (default):** Highlights only the active match; press `Ctrl+Enter` (`Cmd+Enter` on macOS) to toggle highlights for all other matches on or off.
  - **Always:** Highlights all matches throughout notes, tables, callouts, and PDF views continuously.
  - **Off:** Never highlights secondary matches (active match only).
- **Secondary match highlight style:**
  - **Adaptive (Theme-matched fill + edge) (default):** Inspects the active theme, computed background, and primary outline to automatically calculate a subordinate fill and inset edge line.
  - **Dotted underline only:** Subtle dotted underline without any background fill.
  - **Subtle background tint only:** Faint background tint without an inset edge line.
  - **Obsidian highlight default:** Traditional Obsidian text highlight styling (`--text-highlight-bg`).
  - **Custom colors:** Specify custom CSS color strings for light and dark themes.
- **Secondary match prominence:** Slider from `20%` to `100%` (default `75%`) controlling the visual weight and contrast ratio of secondary highlights relative to the active match.
- **Enforce text legibility (WCAG):** When enabled (default), ensures normal text contrast never drops below WCAG standards (4.5:1 floor). If a background fill would impair text legibility, it automatically switches to a dotted underline.
- **Custom color (Light theme) / (Dark theme):** Visible when *Custom colors* style is selected. Accepts any valid CSS color (e.g. `#ffe066`, `rgba(112, 93, 207, 0.4)`).
- **Live Preview Swatch:** An interactive preview in the settings tab demonstrating primary and secondary match styling in your active theme.

### ⚙️ Matching Rules
- **Space-as-wildcard matching:** Toggle wildcard matching on spaces vs. literal substring search.
- **Match only visible part of links:** When enabled (default), search ignores hidden destination URLs and paths in Markdown and wikilinks.

### 🪟 Interface
- **Use popup modal interface:** When enabled, replaces the inline floating widget with a center-screen modal suggest picker.

---

## Customizing via CSS Snippets

You can customize match highlighting using standard Obsidian CSS snippets. The plugin exposes the following CSS custom properties:

```css
/* Example: .obsidian/snippets/custom-incsearch.css */
:root {
  /* Active match outline */
  --incsearch-current-outline-resolved: var(--interactive-accent);

  /* Secondary match fill & edge line */
  --incsearch-secondary-fill: rgba(112, 93, 207, 0.15);
  --incsearch-secondary-edge: rgba(112, 93, 207, 0.45);
}

.theme-dark {
  --incsearch-secondary-fill: rgba(80, 160, 255, 0.18);
  --incsearch-secondary-edge: rgba(80, 160, 255, 0.5);
}
```

---

## Development & Testing

```bash
# Install dependencies
npm install

# Automated Tests
npm run test:run      # Run Vitest unit & integration test suite (170+ tests)
npm run test:coverage # Run test suite with code coverage
npm run test:browser  # Run Playwright browser integration tests

# Linting & Building
npm run lint          # ESLint with obsidianmd rules (zero-warning policy)
npm run format        # Prettier formatting
npm run build         # Type-check and bundle main.js
```

---

## License & Acknowledgements

- Licensed under the [MIT License](LICENSE).
- Inspired by [GNU Emacs](https://www.gnu.org/software/emacs/) `isearch` and [Ivy / Swiper](https://github.com/abo-abo/swiper).
