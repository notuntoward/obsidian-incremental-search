# Obsidian Incremental Search

[![Build](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml)

A fast, keyboard-centric incremental search plugin for Obsidian.

Users who keep their hands on the home row will appreciate this keyboard-driven search workflow—especially those who also use GNU Emacs or modal editors. Search results highlight instantly in the active note as you type, and subsequent search keypresses immediately cycle through matches in either direction without ever reaching for the mouse.

---

## Features

- **Instant In-Document Highlighting:** Matches highlight directly in your document viewport with active match selection and full wildcard-span background shading that automatically adapts to both light and dark themes.
- **Tables, Callouts & PDF Support:** Seamless search and highlighting across Markdown body text, Live Preview tables (with table toast and row/column awareness), folded/unfolded callouts, and PDF view documents.
- **Directional Incremental Navigation:** Search starts from your current cursor position. Triggering the search command again advances to the next or previous match in real time.
- **Smart Space-as-Wildcard Matching:** Type search terms separated by spaces to match words across lines or paragraphs. Type extra spaces to match exact literal spaces.
- **Search Memory & Double-Tap Recall:** Pressing a search hotkey twice in a row (without typing anything in between) immediately recalls and resumes your previous search query in the direction of the second keypress.
- **On-Demand Highlight Toggling:** Keep focus on the active match, or press `Ctrl+Enter` (`Cmd+Enter` on macOS) to instantly toggle all match highlights across the document on or off.
- **Clean Keyboard Dismissal & Search Exit Policy:**
  - `Enter` and `Escape` behavior is configurable via the **Search exit behavior** setting to suit both Emacs and Obsidian workflows.
  - Search widget disappears immediately upon exit.
- **Alternative Popup Modal:** An optional center-screen modal interface is available in settings. It provides an interface that may be more familiar to some users, though it is more limited than the default inline widget (it is non-directional, uses a simplified matching engine, and both forward/backward commands simply open the same modal).

---

## Commands & Recommended Keybindings

The plugin registers three commands in Obsidian's Command Palette. **Commands are not mapped to default hotkeys out of the box** so they do not conflict with your existing keymap.

| Command Name | Command ID | Description | Recommended Keybinding |
| :--- | :--- | :--- | :--- |
| **Incremental Search: Forward** | `forward` | Starts/advances forward search from cursor | `Ctrl+S` (Windows/Linux) or `⌃S` / `⌥S` (macOS) |
| **Incremental Search: Backward** | `backward` | Starts/advances backward search from cursor | `Ctrl+R` (Windows/Linux) or `⌃R` / `⌥R` (macOS) |
| **Incremental Search: Accept current incremental-search match** | `accept-match` | Accepts current match and closes search (useful when Enter is set to find-next) | `Alt+Enter` |

To configure these hotkeys in Obsidian:
1. Open **Settings → Hotkeys**.
2. Search for `Incremental Search`.
3. Assign your preferred shortcuts to **Forward**, **Backward**, and **Accept current incremental-search match**.

---

### Completing or cancelling a search

An incremental-search session can end in one of two ways:

- **Accept** ends search at the current match.
- **Cancel** returns to the selection and viewport that were active before search began.

The **Search exit behavior** setting controls the meaning of `Enter` and `Esc` while incremental search is active:

| Behavior | `Enter` | `Esc` |
| :--- | :--- | :--- |
| **Emacs-style** (default) | Accept the current match and end search | Cancel search and restore the original selection and viewport |
| **Obsidian-style** | Find the next match in the current direction | Accept the current match and end search |

In either mode:
- `Ctrl+S` searches forward and `Ctrl+R` searches backward.
- `Shift+Enter` searches backward in Obsidian-style mode.
- `Ctrl+Enter` (or `Cmd+Enter` on macOS) toggles all non-current match highlights on/off when **Highlight all matches** is set to **On demand**.
- `Ctrl+G` cancels search and restores your origin position.

The command **Accept current incremental-search match** always ends the active search at its current match, independent of the selected behavior. It has no default hotkey; assign one in **Settings → Hotkeys** if desired.

---

## Space-as-Wildcard Matching Rules

When space-as-wildcard matching is enabled (default), spaces between words act as flexible wildcards or literal space matchers according to the following rules:

| Spaces typed | Wildcard behavior | Literal spaces required in document | Example |
| :--- | :--- | :--- | :--- |
| **1 space** | `.*` (unbounded gap) | 0 | `the KAN` matches `the original KAN` |
| **2 spaces** | Suppressed (exact) | 1 literal space | `the  KAN` matches only `the KAN` |
| **3 spaces** | Suppressed (exact) | 2 literal spaces | `the   KAN` matches only `the  KAN` |
| **N spaces** | Suppressed (exact) | N − 1 literal spaces | Matches exactly N − 1 spaces |

---

## Case Sensitivity (Smart Case)

Incremental Search uses **smart-case** matching:

- **All lowercase query:** Search is completely **case-insensitive** (e.g. `resist` matches `resist`, `Resist`, `RESIST`).
- **Contains capital letters:** Typing one or more uppercase letters automatically turns on **case-sensitive** matching (e.g. `Resist` matches only `Resist`, and `KAN` matches only `KAN`).

This smart-case behavior applies across all search modes, including exact literal search and space-as-wildcard search.

---

## Settings

- **Search exit behavior:** Choose between **Emacs-style** (`Enter` accepts, `Esc` cancels) and **Obsidian-style** (`Enter` finds next, `Esc` accepts).
- **Highlight all matches:** Controls when matches other than the active match are highlighted:
  - **Always:** Highlight all matches throughout the note, tables, callouts, and PDF documents.
  - **On demand (Ctrl+Enter to toggle)** (default): Show only the active match normally; press `Ctrl+Enter` (or `Cmd+Enter` on macOS) during search to toggle highlighting for all other matches on or off.
  - **Off:** Highlight only the active match.
- **Space-as-wildcard matching:** Toggle between space-as-wildcard matching and exact literal substring search.
- **Match only visible part of links:** When enabled (default), ignores hidden URLs in Markdown links (`[text](url)`) and hidden destinations in aliased wikilinks (`[[destination|alias]]`).
- **Use popup modal interface:** Option to use a center-screen modal picker with line numbers instead of the inline floating widget.

---

## Development & Testing

```bash
# Install dependencies
npm install

# Build & verification
npm run build      # Lint, type-check, and bundle main.js
npm run lint       # ESLint with obsidianmd rules (zero-warning policy)
npm run format     # Format TypeScript files with Prettier

# Automated Tests
npm run test:run      # Run Vitest unit & integration test suite
npm run test:coverage # Run tests with v8 code coverage
npm run test:browser  # Run Playwright browser tests
```

---

## Releasing

1. Bump the version: `npm version patch` (or `minor`/`major`).
2. Push the tag: `git push && git push --tags`.
3. The automated GitHub workflow builds the release bundle containing `main.js`, `manifest.json`, and `styles.css`.

---

## Acknowledgements

- [**GNU Emacs**](https://www.gnu.org/software/emacs/) — for pioneering incremental search (`isearch`) and space-as-wildcard navigation.
- [**Ivy / Swiper**](https://github.com/abo-abo/swiper) — for inspiring line-based incremental completion and regex/wildcard search workflows.
