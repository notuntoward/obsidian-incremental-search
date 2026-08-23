import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection } from "@codemirror/state";
import { CachedMetadata } from "obsidian";
import { MatchRange, SearchDirection, SearchSessionState } from "./types";
import { computeMatches } from "./engine";
import { removeWidget, showWidgetTableToast, hideWidgetTableToast } from "./widget";

export const setSession = StateEffect.define<SearchSessionState | null>();

export const searchSessionField = StateField.define<SearchSessionState | null>({
	create() {
		return null;
	},
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setSession)) {
				return effect.value;
			}
		}
		return value;
	},
});

/**
 * Builds decorations for search matches overlapping visible viewport ranges.
 */
export function buildHighlightDecorations(
	session: SearchSessionState | null,
	visibleRanges: readonly { from: number; to: number }[]
): DecorationSet {
	if (!session || session.matches.length === 0) {
		return Decoration.none;
	}

	const positions: { from: number; to: number; mark: Decoration }[] = [];

	for (const [i, m] of session.matches.entries()) {
		const inVisible = visibleRanges.some((r) => r.from <= m.to && r.to >= m.from);
		if (!inVisible) continue;

		const isCurrent = i === session.activeIndex;
		const exactCls = isCurrent ? "incsearch-match-exact is-current" : "incsearch-match-exact";

		if (m.chars && m.chars.length > 1) {
			const spanCls = isCurrent
				? "incsearch-match-fuzzy-span is-current"
				: "incsearch-match-fuzzy-span";

			positions.push({
				from: m.from,
				to: m.to,
				mark: Decoration.mark({ class: spanCls }),
			});

			let currentOffset = m.from;
			for (const c of m.chars) {
				if (c.from > currentOffset) {
					positions.push({
						from: currentOffset,
						to: c.from,
						mark: Decoration.mark({ class: "incsearch-match-fuzzy-gap" }),
					});
				}
				positions.push({
					from: c.from,
					to: c.to,
					mark: Decoration.mark({ class: "incsearch-match-fuzzy-word" }),
				});
				currentOffset = c.to;
			}
			if (currentOffset < m.to) {
				positions.push({
					from: currentOffset,
					to: m.to,
					mark: Decoration.mark({ class: "incsearch-match-fuzzy-gap" }),
				});
			}
		} else {
			positions.push({
				from: m.from,
				to: m.to,
				mark: Decoration.mark({ class: exactCls }),
			});
		}
	}

	// Sort by start position; for equal start positions, place enclosing spans first
	positions.sort((a, b) => a.from - b.from || b.to - a.to);
	const builder = positions.map((p) => p.mark.range(p.from, p.to));
	return Decoration.set(builder, true);
}

/**
 * CodeMirror 6 ViewPlugin for rendering search highlights.
 */
export const searchHighlightPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.buildDecorations(view);
		}

		update(update: ViewUpdate) {
			this.decorations = this.buildDecorations(update.view);
		}

		buildDecorations(view: EditorView): DecorationSet {
			const session = view.state.field(searchSessionField, false);
			return buildHighlightDecorations(session ?? null, view.visibleRanges);
		}
	},
	{
		decorations: (v) => v.decorations,
	}
);

/**
 * Saves non-empty query from session to plugin settings.
 */
export function saveSessionQuery(
	session: SearchSessionState | null | undefined,
	plugin: { settings: { lastQuery: string }; saveSettings: () => Promise<void> }
) {
	if (session && session.query) {
		plugin.settings.lastQuery = session.query;
		void plugin.saveSettings();
	}
}

export function scrollToMatch(view: EditorView, match: MatchRange, isTyping = false) {
	view.dispatch({
		effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), {
			y: "center",
			x: "nearest",
		}),
	});

	clearAllTableHighlights(view);
	hideWidgetTableToast();

	if (match.inTable && match.tableMatchData) {
		highlightTableWidget(view, match.tableMatchData);
		showWidgetTableToast(match.tableMatchData);
	}
}

function clearAllTableHighlights(view: EditorView) {
	if (view.dom && typeof view.dom.querySelectorAll === "function") {
		Array.from(view.dom.querySelectorAll(".incsearch-table-cell-match")).forEach((span) => {
			const parent = span.parentNode;
			if (parent) {
				parent.replaceChild(document.createTextNode(span.textContent || ""), span);
				parent.normalize();
			}
		});
		Array.from(view.dom.querySelectorAll(".incsearch-table-has-match, .incsearch-cell-has-match")).forEach((el) => {
			el.classList.remove("incsearch-table-has-match");
			el.classList.remove("incsearch-cell-has-match");
		});
	}
}

function getTableWidgetElement(view: EditorView, tableSectionStart: number): HTMLTableElement | null {
	const result = view.domAtPos(tableSectionStart);
	if (!result) return null;
	let node: Node | null = result.node;
	if (node.nodeType === Node.TEXT_NODE) {
		node = node.parentElement;
	}
	const el = node instanceof HTMLElement ? node : null;
	if (!el) return null;
	
	if (el.matches("table")) return el as HTMLTableElement;
	const innerTable = el.querySelector("table");
	if (innerTable) return innerTable as HTMLTableElement;
	return el.closest("table") as HTMLTableElement | null;
}

function highlightMatchedSubstringInCell(cell: HTMLElement, matchText: string) {
	if (!matchText) return;
	const wrapper = cell.querySelector(".table-cell-wrapper") ?? cell;
	for (const child of Array.from(wrapper.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE && child.textContent) {
			const text = child.textContent;
			const idx = text.toLowerCase().indexOf(matchText.toLowerCase());
			if (idx !== -1) {
				const before = text.slice(0, idx);
				const matched = text.slice(idx, idx + matchText.length);
				const after = text.slice(idx + matchText.length);

				const fragment = document.createDocumentFragment();
				if (before) fragment.appendChild(document.createTextNode(before));
				const mark = document.createElement("span");
				mark.className = "incsearch-table-cell-match incsearch-match-exact is-current";
				mark.textContent = matched;
				fragment.appendChild(mark);
				if (after) fragment.appendChild(document.createTextNode(after));

				wrapper.replaceChild(fragment, child);
				break;
			}
		}
	}
}

function highlightTableWidget(view: EditorView, data: NonNullable<MatchRange["tableMatchData"]>) {
	const table = getTableWidgetElement(view, data.sectionStart);
	if (!table) return;
	table.classList.add("incsearch-table-has-match");

	if (typeof data.rowIndex === "number" && typeof data.colIndex === "number") {
		const row = table.rows?.[data.rowIndex];
		const cell = row?.cells?.[data.colIndex];
		if (cell) {
			cell.classList.add("incsearch-cell-has-match");
			const matchedString = data.cellText.slice(data.matchStartInCell, data.matchEndInCell).trim();
			if (matchedString) {
				highlightMatchedSubstringInCell(cell, matchedString);
			}
		}
	}
}

/**
 * Advances the active match forward or backward with wrap-around.
 */
export function advance(view: EditorView, dir: SearchDirection) {
	const session = view.state.field(searchSessionField, false);
	if (!session) return;

	const matches = session.matches;
	if (matches.length === 0) return;

	let nextIndex: number;
	if (dir === "forward") {
		nextIndex = session.activeIndex + 1;
		if (nextIndex >= matches.length) nextIndex = 0;
	} else {
		nextIndex = session.activeIndex - 1;
		if (nextIndex < 0) nextIndex = matches.length - 1;
	}

	view.dispatch({
		effects: setSession.of({
			...session,
			direction: dir,
			activeIndex: nextIndex,
		}),
	});

	scrollToMatch(view, matches[nextIndex]);
}

/**
 * Sets the active match to a specific index.
 */
export function setActiveIndex(view: EditorView, index: number) {
	const session = view.state.field(searchSessionField, false);
	if (!session || index < 0 || index >= session.matches.length) return;

	view.dispatch({
		effects: setSession.of({
			...session,
			activeIndex: index,
		}),
	});

	scrollToMatch(view, session.matches[index]);
}

/**
 * Recomputes all matches for a new query and updates the active selection.
 */
export function recomputeQuery(
	view: EditorView,
	query: string,
	direction: SearchDirection,
	fuzzy: boolean,
	matchOnlyVisibleLinks: boolean,
	linkCache?: CachedMetadata,
	isTyping = false
) {
	const session = view.state.field(searchSessionField, false);
	if (!session) return;

	const allMatches = computeMatches(view.state, query, fuzzy, matchOnlyVisibleLinks, linkCache);
	const cursorPos = session.originSelection.head;

	let activeIndex = 0;
	if (allMatches.length > 0) {
		if (direction === "forward") {
			const idx = allMatches.findIndex((m) => m.from >= cursorPos);
			activeIndex = idx === -1 ? 0 : idx;
		} else {
			let idx = -1;
			for (let i = allMatches.length - 1; i >= 0; i--) {
				if (allMatches[i].to <= cursorPos) {
					idx = i;
					break;
				}
			}
			activeIndex = idx === -1 ? allMatches.length - 1 : idx;
		}
	}

	view.dispatch({
		effects: setSession.of({
			...session,
			query,
			direction,
			matches: allMatches,
			activeIndex,
		}),
	});

	if (allMatches.length > 0) {
		scrollToMatch(view, allMatches[activeIndex], isTyping);
	}
}

/**
 * Commits the current active match and closes the search session.
 */
export function commitMatch(
	view: EditorView,
	plugin: { settings: { lastQuery: string }; saveSettings: () => Promise<void> }
) {
	try {
		const session = view.state.field(searchSessionField, false);
		if (!session || session.matches.length === 0) {
			closeSession(view, plugin);
			view.focus();
			return;
		}

		const m = session.matches[session.activeIndex];
		saveSessionQuery(session, plugin);

		view.dispatch({
			selection: EditorSelection.cursor(m.to),
			effects: [
				setSession.of(null),
				EditorView.scrollIntoView(EditorSelection.range(m.from, m.to), {
					y: "center",
					x: "nearest",
				}),
			],
		});
		clearAllTableHighlights(view);
		removeWidget(view);
		view.focus();
	} catch (e) {
		console.error("Incremental Search: commitMatch error", e);
		removeWidget(view);
		view.focus();
	}
}

/**
 * Cancels the session and restores the cursor to where search started.
 */
export function cancelSession(
	view: EditorView,
	plugin: { settings: { lastQuery: string }; saveSettings: () => Promise<void> }
) {
	try {
		const session = view.state.field(searchSessionField, false);
		if (session) {
			saveSessionQuery(session, plugin);
			view.dispatch({
				selection: EditorSelection.range(
					session.originSelection.anchor,
					session.originSelection.head
				),
				effects: [
					setSession.of(null),
					EditorView.scrollIntoView(
						EditorSelection.range(
							session.originSelection.anchor,
							session.originSelection.head
						),
						{ y: "center", x: "nearest" }
					),
				],
			});
		}
		removeWidget(view);
		clearAllTableHighlights(view);
		view.focus();
	} catch (e) {
		console.error("Incremental Search: cancelSession error", e);
		removeWidget(view);
		clearAllTableHighlights(view);
		view.focus();
	}
}

/**
 * Closes the session and clears search state without modifying editor selection.
 */
export function closeSession(
	view: EditorView,
	plugin: { settings: { lastQuery: string }; saveSettings: () => Promise<void> }
) {
	const session = view.state.field(searchSessionField, false);
	saveSessionQuery(session, plugin);

	view.dispatch({ effects: setSession.of(null) });
	removeWidget(view);
	clearAllTableHighlights(view);
	view.focus();
}
