import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection } from "@codemirror/state";
import { MatchRange, SearchDirection, SearchSessionState } from "./types";
import { computeMatches } from "./engine";
import { removeWidget } from "./widget";

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
		const cls = isCurrent ? "incsearch-match-current" : "incsearch-match";

		if (m.chars && m.chars.length > 0) {
			const spanCls = isCurrent ? "incsearch-match-span-current" : "incsearch-match-span";

			positions.push({
				from: m.from,
				to: m.to,
				mark: Decoration.mark({ class: spanCls }),
			});

			for (const c of m.chars) {
				positions.push({
					from: c.from,
					to: c.to,
					mark: Decoration.mark({ class: cls }),
				});
			}
		} else {
			positions.push({
				from: m.from,
				to: m.to,
				mark: Decoration.mark({ class: cls }),
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

/**
 * Scrolls a match range into view centered vertically and nearest horizontally.
 */
export function scrollToMatch(view: EditorView, match: MatchRange) {
	view.dispatch({
		effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), {
			y: "center",
			x: "nearest",
		}),
	});
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
	fuzzy: boolean
) {
	const session = view.state.field(searchSessionField, false);
	if (!session) return;

	const allMatches = computeMatches(view.state, query, fuzzy);
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
		scrollToMatch(view, allMatches[activeIndex]);
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
			effects: setSession.of(null),
		});
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
				effects: setSession.of(null),
			});
		}
		removeWidget(view);
		view.focus();
	} catch (e) {
		console.error("Incremental Search: cancelSession error", e);
		removeWidget(view);
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
	view.focus();
}
