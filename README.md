# Obsidian Incremental Search

[![CI](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/ci.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/ci.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-incremental-search/actions/workflows/scorecard.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/notuntoward/obsidian-incremental-search/badge)](https://securityscorecards.dev/viewer/?uri=github.com/notuntoward/obsidian-incremental-search)

Incremental search for Obsidian notes and PDFs. Start typing and jump straight to the match — no need to open a separate panel or type a whole phrase.

Inspired by GNU Emacs `isearch` and `swiper`, for anyone who'd rather keep their hands on the keyboard.

## Contents

- [Quick start](#quick-start)
- [How search works](#how-search-works)
- [Commands & keyboard shortcuts](#commands--keyboard-shortcuts)
- [In-search controls](#in-search-controls)
- [Settings](#settings)
- [Customizing highlight colors](#customizing-highlight-colors)
- [Architecture & Theory](doc/ARCHITECTURE_AND_THEORY.md)

## Quick start

1. Run **Incremental Search: Forward Emacs** or **Incremental Search: Reverse Emacs** from the Command Palette (assign a hotkey — see below).
2. Start typing. Matches highlight as you go, starting from your cursor. If you start search with text already selected, it automatically searches for that selection and jumps to the next occurrence.
3. Press the same hotkey again to jump to the next match. In the default Emacs-style keyboard mode, `Enter` accepts the match and closes search; in Obsidian-style mode, `Enter` finds the next match and `Esc` accepts.

Works in notes (source and Live Preview), tables, callouts, and PDFs.

> [!NOTE]
> PDF search hooks into Obsidian's built-in PDF viewer through undocumented internals, so it may stop working after an Obsidian update. Note search is unaffected.

## How search works

Type a few words and the plugin finds them nearby, in order — you don't need the exact phrase.

For example, searching `the KAN` matches text like *"the original KAN"* — the words don't need to be adjacent.

**Search from active selection:** If text is selected in the note or PDF you are searching when you start a search, the plugin immediately uses that selection as the search query and jumps to the next occurrence (for forward search) or previous occurrence (for backward search), excluding the active selection itself. Otherwise search starts empty; a selection in another note, pane, or window is ignored.

**Where a PDF search starts:** A PDF has no cursor, so the last match you accepted in that PDF stands in for one: while it is still on screen, a new search continues after it (forward) or before it (backward). Otherwise, a forward search starts at the top-most visible match and a backward search at the bottom-most. Cancelling a search does not change the starting point.

**Need an exact match?** Wrap any part of your search in double quotes. Searching `"the KAN"` matches only that exact phrase, with no words in between.

You can mix quoted and unquoted parts in the same search. For example:

`foo "bar baz" qux`

Here, `foo` and `qux` are still flexible, but `bar baz` must appear together, exactly as written, in between.

To search for a literal quote character inside a quoted phrase, escape it with a backslash, as in `"she said \"hi\""`.

**Case sensitivity is automatic.** All-lowercase searches ignore case (`react` matches `React`); typing any capital letter makes the search case-sensitive (`React` matches only `React`).

**Extra spaces are literal.** One space between words is a flexible gap; two or more spaces require that many literal spaces in the note.

> [!TIP]
> In PDFs, gaps between words are bounded. This still lets you type a prefix like `modalit` to match `modalities`, while avoiding false matches that span unrelated paragraphs.

## Commands & keyboard shortcuts

Hotkeys are unassigned by default so they never conflict with your existing keymap.

| Command                      | Command ID                    | Suggested hotkey              | Description                                      |
| :--------------------------- | :---------------------------- | :---------------------------- | :----------------------------------------------- |
| Incremental Search: Forward Emacs | `incremental-search:forward` | `Ctrl+S` / `Cmd+S` or `Alt+S` | Start or advance forward search from the cursor |
| Incremental Search: Reverse Emacs | `incremental-search:backward` | `Ctrl+R` / `Cmd+R` or `Alt+R` | Start or advance backward search from the cursor |

To assign hotkeys: **Settings → Hotkeys**, search for "Incremental Search," and bind both commands.

These display names describe Emacs-style directional search. Both commands remain
available in either keyboard mode. Their command IDs are unchanged, so existing
hotkey assignments continue to work.

Outside search, these commands open it, empty, in the active note or PDF.
During search, they move to the next or previous match; when the query is empty,
repeating a command while the search bar is still open recalls the last query. Both interfaces use the command shortcuts you
assign here, with no separate Ctrl/Cmd+S or Ctrl/Cmd+R bindings.

## In-search controls

Once a search is active, these keys control navigation and how the search session ends. Which behavior you get for `Enter`, `Shift+Enter`, and `Esc` depends on **Search keyboard behavior** (**Settings → Incremental Search → Navigation & exit**). This applies to both Compact and the Obsidian-style bar, in notes and PDFs.

| Key | Emacs-style mode (default) | Obsidian-style mode |
| :--- | :--- | :--- |
| Type characters | Updates query, jumps to nearest match | Updates query, jumps to nearest match |
| Forward command hotkey | Next match | Next match |
| Backward command hotkey | Previous match | Previous match |
| `Enter` | Accept match, place cursor, close search | Find next match |
| `Shift+Enter` | Accept match, place cursor, close search | Find previous match |
| `Esc` | Cancel, restore original position | Accept match, close search |
| `Ctrl+G` / `Cmd+G` | Cancel, restore original position | Cancel, restore original position |
| `Ctrl+Enter` / `Cmd+Enter` | Toggle highlighting of other matches — only when "Highlight all matches" is set to *On demand* | Same as Emacs-style |
| Click outside / switch tab | Dismiss, keep current cursor position | Dismiss, keep current cursor position |

`Ctrl+G` / `Cmd+G` cancels in either search interface, regardless of Search keyboard behavior. It works while focus is within the search UI and leaves unrelated shortcuts alone after search closes.

Clicking back into the editor dismisses search and keeps the cursor where you clicked, rather than moving it to the pending match or restoring the search's starting position.

The optional **Obsidian-style bar** changes the appearance, not the search engine or selected keyboard behavior. It uses a rounded search row with a scan-search icon (no colored stripe), plus a muted, wrapping shortcut footer below. In Emacs-style mode, navigation hints show each command's first configured shortcut (or Unassigned); in Obsidian-style mode, they show Enter and Shift+Enter. The footer shows the highlight shortcut only in On demand mode; Compact remains a simple floating box without a footer.

In Obsidian-style keyboard behavior, Enter always searches forward and Shift+Enter always searches backward, regardless of the last search direction. Emacs-style retains Enter/Shift+Enter to accept and Escape to cancel. Configured command hotkeys work in both interfaces and modes.

The bar's controls, from left to right after the input, are:

| Control | Action |
| :--- | :--- |
| Up arrow | Previous match (reverse search) |
| Down arrow | Next match (forward search) |
| Highlight all matches | Switch the saved setting between Always and On demand, applying it immediately without moving the current match |
| X | Cancel search, restore the original cursor/scroll position, and hide the bar, regardless of Search keyboard behavior |

The highlight button is active for **Always**. In **On demand**, `Ctrl+Enter` / `Cmd+Enter` still toggles highlights temporarily without changing the saved setting. The scan-search icon identifies the plugin. The bar works in Markdown and PDFs, in the main window or a pop-out.

## Settings

All options live under **Settings → Incremental Search**, organized into native settings groups.

Descriptions span the row beneath the label and control instead of wrapping beside wide dropdowns. On narrow panels, controls stack below labels. Dropdown labels are concise; their descriptions explain the behavior.

**Interface**
- *Search interface* — Compact (the original floating box, default) or Obsidian-style bar (full-width above the document). Both work in notes and PDFs. The popup interface has been removed; saved popup preferences automatically switch to Compact without resetting other settings.
- Choosing the Obsidian-style bar changes a saved *Highlight all matches: Off* to *On demand*. Off is unavailable while this interface is selected; switching back makes Off available again.

**Matching**
- *Space-as-wildcard matching* — toggle wildcard gaps on spaces vs. plain substring search.
- *Match only visible part of links* — searches Markdown link labels and wikilink aliases, never their hidden destinations or link titles (default on). Bare wikilinks such as `[[note#heading]]` remain searchable because their targets are displayed. Image/embed source syntax and reference definitions are excluded; visibly written URLs and literal link examples inside code remain searchable. Filtering uses the current editor text, including unsaved edits, and does not depend on Obsidian caching external URLs. Turning this off makes link destinations searchable again.

**Navigation & exit**
- *Search keyboard behavior* — Emacs-style (`Enter` accepts, `Esc` cancels) or Obsidian-style (`Enter` finds next, `Shift+Enter` finds previous, `Esc` accepts), consistently across all interfaces. The renamed setting preserves saved preferences. Shortcut hints follow the selected behavior.

**Match highlighting**
- *Highlight all matches* — on demand (default; toggle with `Ctrl+Enter`/`Cmd+Enter`), always, or off. `Ctrl+Enter` only has an effect when this is set to *on demand*.
- Appearance controls and the preview are hidden when highlighting is Off; their saved values are retained.
- *Secondary match highlight style* — adaptive theme-matched (default), dotted underline, subtle tint, Obsidian's default highlight, or custom colors.
- *Secondary match prominence* — slider, 20 to 100 percent (default 75).
- *Enforce text legibility (WCAG)* — keeps secondary-match contrast above the WCAG AA floor (4.5:1), falling back to a dotted underline if a color combination would fail (default on). Hidden for Underline and Obsidian-default styles, where it has no effect.
- *Custom colors* — light/dark theme color overrides, shown when "Custom colors" style is selected.
- A live preview swatch in the settings tab shows how highlights will look in your current theme.

**Troubleshooting**
- *Debug logging* — detailed developer-console diagnostics, off by default.

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
