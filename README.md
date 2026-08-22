# Obsidian Incremental Search

[![Build](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml)

A fast, keyboard-centric incremental search plugin for Obsidian.

Users who keep their hands on the home row will appreciate this keyboard-driven search workflow—especially those who also use GNU Emacs or modal editors. Search results highlight instantly in the active note as you type, and subsequent search keypresses immediately cycle through matches in either direction without ever reaching for the mouse.

---

## Features

- **Instant In-Document Highlighting:** Matches highlight directly in your document viewport with active match selection and full fuzzy-span background shading that automatically adapts to both light and dark themes.
- **Directional Incremental Navigation:** Search starts from your current cursor position. Triggering the search command again advances to the next or previous match in real time.
- **Smart Space-as-Wildcard Matching:** Type search terms separated by spaces to match words across lines or paragraphs. Type extra spaces to match exact literal spaces.
- **Search Memory & Double-Tap Recall:** Pressing a search hotkey twice in a row (without typing anything in between) immediately recalls and resumes your previous search query in the direction of the second keypress.
- **Clean Keyboard Dismissal:**
  - `Enter`: Commits the match and places the cursor at the end of the match.
  - `Escape`: Cancels search and restores your cursor to where you began.
  - Search widget disappears immediately upon exit.
- **Alternative Popup Modal:** An optional center-screen modal interface is available in settings. It provides an interface that may be more familiar to some users, though it is more limited than the default inline widget (it is non-directional, uses a simplified matching engine, and both forward/backward commands simply open the same modal).

---

## Commands & Recommended Keybindings

The plugin registers two commands in Obsidian's Command Palette. **Commands are not mapped to default hotkeys out of the box** so they do not conflict with your existing keymap.

| Command Name | Command ID | Description | Recommended Keybinding |
| :--- | :--- | :--- | :--- |
| **Incremental Search: Forward** | `forward` | Starts/advances forward search from cursor | `Ctrl+S` (Windows/Linux) or `⌃S` / `⌥S` (macOS) |
| **Incremental Search: Backward** | `backward` | Starts/advances backward search from cursor | `Ctrl+R` (Windows/Linux) or `⌃R` / `⌥R` (macOS) |

To configure these hotkeys in Obsidian:
1. Open **Settings → Hotkeys**.
2. Search for `Incremental Search`.
3. Assign your preferred shortcuts to **Forward** and **Backward**.

---

## Space-as-Wildcard Matching Rules

When fuzzy matching is enabled (default), spaces between words act as flexible wildcards or literal space matchers according to the following rules:

| Spaces typed | Wildcard behavior | Literal spaces required in document | Example |
| :--- | :--- | :--- | :--- |
| **1 space** | `.*` (unbounded gap) | 0 | `the KAN` matches `the original KAN` |
| **2 spaces** | Suppressed (exact) | 1 literal space | `the  KAN` matches only `the KAN` |
| **3 spaces** | Suppressed (exact) | 2 literal spaces | `the   KAN` matches only `the  KAN` |
| **N spaces** | Suppressed (exact) | N − 1 literal spaces | Matches exactly N − 1 spaces |

---

## Settings

- **Fuzzy matching:** Toggle between space-as-wildcard fuzzy matching and exact literal substring search.
- **Double-tap window (ms):** The timeout window (default `600ms`) during which consecutive search hotkey presses recall the last search query.
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

- [**GNU Emacs**](https://cgit.git.savannah.gnu.org/cgit/emacs.git) — for pioneering incremental search (`isearch`) and space-as-wildcard navigation.
- [**Ivy / Swiper**](https://github.com/abo-abo/swiper) — for inspiring line-based incremental completion and regex/fuzzy search workflows.
