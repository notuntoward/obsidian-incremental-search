# Obsidian Incremental Search

[![Build](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml)

Incremental search for Obsidian notes and PDFs. Start typing and jump straight to the match — no need to open a separate panel or type a whole phrase.

Inspired by GNU Emacs `isearch` and `swiper`, for anyone who'd rather keep their hands on the keyboard.

## Contents

- [Quick start](#quick-start)
- [How search works](#how-search-works)
- [Commands & keyboard shortcuts](#commands--keyboard-shortcuts)
- [In-search controls](#in-search-controls)
- [Settings](#settings)
- [Customizing highlight colors](#customizing-highlight-colors)
- [Development](#development)
- [Developer notes: highlight color engine](#developer-notes-highlight-color-engine)

## Quick start

1. Run **Incremental Search: Forward** or **Incremental Search: Backward** from the Command Palette (assign a hotkey — see below).
2. Start typing. Matches highlight as you go, starting from your cursor.
3. Press the same hotkey again to jump to the next match, or press `Enter` to land the cursor there and close the search.

Works in notes (source and Live Preview), tables, callouts, and PDFs.

## How search works

Type a few words and the plugin finds them nearby, in order — you don't need the exact phrase.

For example, searching `the KAN` matches text like *"the original KAN"* — the words don't need to be adjacent.

**Need an exact match?** Wrap any part of your search in double quotes. Searching `"the KAN"` matches only that exact phrase, with no words in between.

You can mix quoted and unquoted parts in the same search. For example:

`foo "bar baz" qux`

Here, `foo` and `qux` are still flexible, but `bar baz` must appear together, exactly as written, in between.

To search for a literal quote character inside a quoted phrase, escape it with a backslash, as in `"she said \"hi\""`.

**Case sensitivity is automatic.** All-lowercase searches ignore case (`react` matches `React`); typing any capital letter makes the search case-sensitive (`React` matches only `React`).

**Extra spaces are literal.** One space between words is a flexible gap; two or more spaces require that many literal spaces in the note.

> [!TIP]
> In PDFs, matches must start at word boundaries and gaps between words are bounded. This still lets you type a prefix like `modalit` to match `modalities`, while avoiding false matches that start mid-word or span unrelated paragraphs.

## Commands & keyboard shortcuts

Hotkeys are unassigned by default so they never conflict with your existing keymap.

| Command | Command ID | Suggested hotkey | Description |
| :--- | :--- | :--- | :--- |
| Incremental Search: Forward | `obsidian-incremental-search:forward` | `Ctrl+S` / `Cmd+S` or `Alt+S` | Start or advance forward search from the cursor |
| Incremental Search: Backward | `obsidian-incremental-search:backward` | `Ctrl+R` / `Cmd+R` or `Alt+R` | Start or advance backward search from the cursor |

To assign hotkeys: **Settings → Hotkeys**, search for "Incremental Search," and bind both commands.

## In-search controls

Once a search is active, these keys control navigation and how the search session ends. Which behavior you get for `Enter`, `Shift+Enter`, and `Esc` depends on the **Search exit behavior** setting (**Settings → Incremental Search → Navigation & exit behavior**) — the two columns below show the two available modes.

| Key | Emacs-style mode (default) | Obsidian-style mode |
| :--- | :--- | :--- |
| Type characters | Updates query, jumps to nearest match | Updates query, jumps to nearest match |
| Forward hotkey / `F3` | Next match | Next match |
| Backward hotkey / `Shift+F3` | Previous match | Previous match |
| `Enter` | Accept match, place cursor, close search | Find next match |
| `Shift+Enter` | Accept match, place cursor, close search | Find previous match |
| `Esc` | Cancel, restore original position | Accept match, close search |
| `Ctrl+G` | Not bound by default | Not bound by default |
| `Ctrl+Enter` / `Cmd+Enter` | Toggle highlighting of other matches — only when "Highlight all matches" is set to *On demand* | Same as Emacs-style |
| Click outside / switch tab | Dismiss, keep current cursor position | Dismiss, keep current cursor position |

## Settings

All options live under **Settings → Incremental Search**.

**Navigation & exit behavior**
- *Search exit behavior* — Emacs-style (`Enter` accepts, `Esc` cancels) or Obsidian-style (`Enter` finds next, `Esc` accepts). This also determines the default bindings shown in the table above.

**Match highlighting**
- *Highlight all matches* — on demand (default; toggle with `Ctrl+Enter`/`Cmd+Enter`), always, or off. `Ctrl+Enter` only has an effect when this is set to *on demand*.
- *Secondary match highlight style* — adaptive theme-matched (default), dotted underline, subtle tint, Obsidian's default highlight, or custom colors.
- *Secondary match prominence* — slider, 20 to 100 percent (default 75).
- *Enforce text legibility (WCAG)* — keeps secondary-match contrast above the WCAG AA floor (4.5:1), falling back to a dotted underline if a color combination would fail (default on).
- *Custom colors* — light/dark theme color overrides, shown when "Custom colors" style is selected.
- A live preview swatch in the settings tab shows how highlights will look in your current theme.

**Matching rules**
- *Space-as-wildcard matching* — toggle wildcard gaps on spaces vs. plain substring search.
- *Match only visible part of links* — ignores hidden URLs and wikilink destinations when searching (default on).

**Interface**
- *Use popup modal interface* — swap the inline floating widget for a center-screen modal.

## Customizing highlight colors

Override highlight colors with a standard Obsidian CSS snippet:

```css
/* .obsidian/snippets/custom-incsearch.css */
:root {
  --incsearch-current-outline-resolved: var(--interactive-accent);
  --incsearch-secondary-fill: rgba(112, 93, 207, 0.15);
  --incsearch-secondary-edge: rgba(112, 93, 207, 0.45);
}

.theme-dark {
  --incsearch-secondary-fill: rgba(80, 160, 255, 0.18);
  --incsearch-secondary-edge: rgba(80, 160, 255, 0.5);
}
```
