import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection } from "@codemirror/state";
import { unfoldEffect, foldEffect, foldedRanges } from "@codemirror/language";
import { CachedMetadata } from "obsidian";
import { MatchRange, SearchDirection, SearchSessionState } from "./types";
import { computeMatches } from "./engine";
import { removeWidget, showWidgetTableToast, hideWidgetTableToast } from "./widget";

interface AutoFoldedRange {
	from: number;
	to: number;
}

let autoUnfoldedFoldRanges: AutoFoldedRange[] = [];
let autoUnfoldedCallouts: HTMLElement[] = [];

export function getAutoUnfoldedCallouts(): readonly HTMLElement[] {
	return autoUnfoldedCallouts;
}

export function getAutoUnfoldedFoldRanges(): readonly AutoFoldedRange[] {
	return autoUnfoldedFoldRanges;
}

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
	const highlightAll = session.highlightAllMatches !== false;

	for (const [i, m] of session.matches.entries()) {
		const isCurrent = i === session.activeIndex;
		if (!highlightAll && !isCurrent) {
			continue;
		}

		const inVisible = visibleRanges.some((r) => r.from <= m.to && r.to >= m.from);
		if (!inVisible) continue;

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

function getCalloutRangeAtPos(view: EditorView, pos: number): { from: number; to: number } | null {
	if (!view.state || !view.state.doc || typeof view.state.doc.lineAt !== "function") {
		return null;
	}
	const doc = view.state.doc;
	if (pos < 0 || pos > doc.length) return null;
	const currentLine = doc.lineAt(pos);
	if (!currentLine || !currentLine.text || !currentLine.text.startsWith(">")) {
		return null;
	}

	// 1. Scan upward to find the start line of the callout
	let startLineNum = currentLine.number;
	let foundHeader = false;
	while (startLineNum >= 1) {
		const line = doc.line(startLineNum);
		if (!line.text.startsWith(">")) {
			break;
		}
		if (/^>\s*\[![^\]]+\]/.test(line.text)) {
			foundHeader = true;
			break;
		}
		startLineNum--;
	}

	if (!foundHeader) {
		return null;
	}

	// 2. Scan downward from startLineNum to find the end line of the callout
	let endLineNum = startLineNum;
	while (endLineNum <= doc.lines) {
		const line = doc.line(endLineNum);
		if (!line.text.startsWith(">")) {
			break;
		}
		endLineNum++;
	}
	endLineNum--;

	return {
		from: doc.line(startLineNum).from,
		to: doc.line(endLineNum).to,
	};
}

function isHTMLElement(node: Node | null | undefined): node is HTMLElement {
	return !!node && node.nodeType === Node.ELEMENT_NODE;
}

function getElementFromDomAtPosResult(result: { node: Node; offset: number }): HTMLElement[] {
	const elements: HTMLElement[] = [];
	const { node, offset } = result;

	if (isHTMLElement(node)) {
		elements.push(node);
	} else if (node.parentElement) {
		elements.push(node.parentElement);
	}

	if (node.childNodes && node.childNodes.length > 0) {
		if (offset >= 0 && offset < node.childNodes.length) {
			const child = node.childNodes[offset];
			if (isHTMLElement(child)) {
				elements.push(child);
			} else if (child.parentElement) {
				elements.push(child.parentElement);
			}
		}
		if (offset > 0 && offset <= node.childNodes.length) {
			const prevChild = node.childNodes[offset - 1];
			if (isHTMLElement(prevChild)) {
				elements.push(prevChild);
			} else if (prevChild.parentElement) {
				elements.push(prevChild.parentElement);
			}
		}
	}

	return elements;
}

function findCalloutElement(element: HTMLElement | null): HTMLElement | null {
	if (!element) return null;
	if (element.matches(".callout")) return element;
	const calloutParent = element.closest<HTMLElement>(".callout");
	if (calloutParent) return calloutParent;
	const embedBlock = element.closest<HTMLElement>(".cm-embed-block");
	if (embedBlock) {
		const callout = embedBlock.querySelector<HTMLElement>(".callout");
		if (callout) return callout;
	}
	if (
		element.matches(".cm-embed-block") ||
		element.matches(".cm-line") ||
		element.classList.contains("cm-callout")
	) {
		const callout = element.querySelector<HTMLElement>(".callout");
		if (callout) return callout;
	}
	return null;
}

function getCalloutAtPos(view: EditorView, pos: number): HTMLElement | null {
	if (!view.dom || typeof view.domAtPos !== "function") {
		return null;
	}

	const calloutRange = getCalloutRangeAtPos(view, pos);
	if (!calloutRange) {
		return null;
	}

	// 1. Try domAtPos at start of callout header (where the widget is embedded)
	try {
		const headerResult = view.domAtPos(calloutRange.from);
		if (headerResult && headerResult.node) {
			for (const el of getElementFromDomAtPosResult(headerResult)) {
				const callout = findCalloutElement(el);
				if (callout) {
					return callout;
				}
			}
		}
	} catch {
		// Ignore
	}

	// 2. Try domAtPos at exact match position
	try {
		const result = view.domAtPos(pos);
		if (result && result.node) {
			for (const el of getElementFromDomAtPosResult(result)) {
				const callout = findCalloutElement(el);
				if (callout) {
					return callout;
				}
			}
		}
	} catch {
		// Ignore
	}

	// 3. Fallback: Query all .callout elements in the editor and match by position or count
	try {
		const allCallouts = Array.from(view.dom.querySelectorAll<HTMLElement>(".callout"));
		if (allCallouts.length === 1) {
			return allCallouts[0];
		}
		for (const c of allCallouts) {
			const embed = c.closest<HTMLElement>(".cm-embed-block");
			if (embed && typeof (view as any).posAtDOM === "function") {
				const embedPos = (view as any).posAtDOM(embed);
				if (embedPos >= calloutRange.from && embedPos <= calloutRange.to) {
					return c;
				}
			}
		}
	} catch {
		// Ignore
	}

	return null;
}

function expandCallout(callout: HTMLElement) {
	callout.classList.remove("is-collapsed");
	callout.setAttribute("data-callout-fold", "+");
	callout.querySelectorAll(".callout-fold").forEach((f) => {
		f.classList.remove("is-collapsed");
	});
	const content = callout.querySelector<HTMLElement>(".callout-content");
	if (content) {
		content.style.display = "block";
	}
}

function collapseCallout(callout: HTMLElement) {
	callout.classList.add("is-collapsed");
	callout.setAttribute("data-callout-fold", "-");
	callout.querySelectorAll(".callout-fold").forEach((f) => {
		f.classList.add("is-collapsed");
	});
	const content = callout.querySelector<HTMLElement>(".callout-content");
	if (content) {
		content.style.display = "none";
	}
}

function getCalloutMatchIndex(
	view: EditorView,
	calloutRange: { from: number; to: number },
	matchFrom: number,
	matchText: string
): number {
	if (!matchText) return 0;
	const doc = view.state.doc;
	const calloutText = doc.sliceString(calloutRange.from, matchFrom);
	let count = 0;
	let idx = calloutText.toLowerCase().indexOf(matchText.toLowerCase());
	while (idx !== -1) {
		count++;
		idx = calloutText.toLowerCase().indexOf(matchText.toLowerCase(), idx + matchText.length);
	}
	return count;
}

function highlightMatchedTextInCallout(
	view: EditorView,
	callout: HTMLElement,
	matchText: string,
	activeIndexInCallout = 0,
	highlightAll = true
) {
	if (!matchText) return;
	const container = callout.querySelector(".callout-content") ?? callout;

	const activeRef: { span: HTMLElement | null } = { span: null };
	let currentOccur = 0;
	let matchCount = 0;

	function walk(node: Node) {
		if (node.nodeType === Node.TEXT_NODE && node.textContent) {
			const text = node.textContent;
			let lastPos = 0;
			let idx = text.toLowerCase().indexOf(matchText.toLowerCase(), lastPos);
			if (idx !== -1) {
				const frag = document.createDocumentFragment();
				while (idx !== -1) {
					const before = text.slice(lastPos, idx);
					if (before) frag.appendChild(document.createTextNode(before));
					const matched = text.slice(idx, idx + matchText.length);
					const isCurrent = currentOccur === activeIndexInCallout;
					if (highlightAll || isCurrent) {
						const mark = document.createElement("span");
						mark.className = isCurrent
							? "incsearch-callout-match incsearch-match-exact is-current"
							: "incsearch-callout-match incsearch-match-exact";
						mark.textContent = matched;
						if (isCurrent) {
							activeRef.span = mark;
						}
						frag.appendChild(mark);
					} else {
						frag.appendChild(document.createTextNode(matched));
					}
					currentOccur++;
					matchCount++;
					lastPos = idx + matchText.length;
					idx = text.toLowerCase().indexOf(matchText.toLowerCase(), lastPos);
				}
				const after = text.slice(lastPos);
				if (after) frag.appendChild(document.createTextNode(after));

				const parent = node.parentNode;
				if (parent) {
					parent.replaceChild(frag, node);
				}
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as HTMLElement;
			if (
				el.classList.contains("incsearch-callout-match") ||
				el.classList.contains("callout-fold") ||
				el.classList.contains("callout-icon")
			) {
				return;
			}
			for (const child of Array.from(el.childNodes)) {
				walk(child);
			}
		}
	}

	walk(container);

	if (activeRef.span) {
		// 1. Scroll CM6 scrollDOM directly to bypass callout overflow: hidden
		const scroller = view.scrollDOM;
		if (
			scroller &&
			typeof scroller.getBoundingClientRect === "function" &&
			typeof activeRef.span.getBoundingClientRect === "function"
		) {
			try {
				const spanRect = activeRef.span.getBoundingClientRect();
				const scrollerRect = scroller.getBoundingClientRect();
				if (spanRect.height > 0 && scrollerRect.height > 0) {
					const spanCenterY = spanRect.top + spanRect.height / 2;
					const scrollerCenterY = scrollerRect.top + scrollerRect.height / 2;
					const deltaY = spanCenterY - scrollerCenterY;
					scroller.scrollTop += deltaY;
				}
			} catch {
				// Ignore
			}
		}

		// 2. Standard scrollIntoView fallback
		if (typeof activeRef.span.scrollIntoView === "function") {
			try {
				activeRef.span.scrollIntoView({ block: "center", inline: "nearest" });
			} catch {
				// Ignore
			}
		}
	}
}

function clearAllCalloutHighlights(view: EditorView) {
	if (view.dom && typeof view.dom.querySelectorAll === "function") {
		const spans = Array.from(view.dom.querySelectorAll(".incsearch-callout-match"));
		if (spans.length > 0) {
			spans.forEach((span) => {
				const parent = span.parentNode;
				if (parent) {
					parent.replaceChild(document.createTextNode(span.textContent || ""), span);
					parent.normalize();
				}
			});
		}
	}
}

export function restoreAutoUnfoldedStructures(view: EditorView, keepMatchPos?: number) {
	// 1. Re-fold CM6 folded ranges
	if (autoUnfoldedFoldRanges.length > 0) {
		const toReFold = typeof keepMatchPos === "number"
			? autoUnfoldedFoldRanges.filter((r) => keepMatchPos < r.from || keepMatchPos >= r.to)
			: autoUnfoldedFoldRanges;

		if (toReFold.length > 0) {
			try {
				view.dispatch({
					effects: toReFold.map((r) => foldEffect.of(r)),
				});
			} catch {
				// Ignore if folding is not configured in environment
			}
		}
		autoUnfoldedFoldRanges = [];
	}

	// 2. Re-collapse Live Preview Callout elements
	if (autoUnfoldedCallouts.length > 0) {
		const keepCallout = typeof keepMatchPos === "number" ? getCalloutAtPos(view, keepMatchPos) : null;
		for (const callout of autoUnfoldedCallouts) {
			if (callout !== keepCallout) {
				collapseCallout(callout);
			}
		}
		autoUnfoldedCallouts = [];
	}
	clearAllCalloutHighlights(view);
}

function applyLivePreviewHighlights(view: EditorView, match: MatchRange) {
	clearAllCalloutHighlights(view);
	clearAllTableHighlights(view);
	hideWidgetTableToast();

	const session = view.state.field(searchSessionField, false);
	const highlightAll = session?.highlightAllMatches !== false;

	const calloutRange = getCalloutRangeAtPos(view, match.from);
	const currentCallout = getCalloutAtPos(view, match.from);

	if (currentCallout) {
		const isCollapsed =
			currentCallout.classList.contains("is-collapsed") ||
			currentCallout.getAttribute("data-callout-fold") === "-";

		if (isCollapsed) {
			if (!autoUnfoldedCallouts.includes(currentCallout)) {
				autoUnfoldedCallouts.push(currentCallout);
			}
			expandCallout(currentCallout);
		}
	}

	// Re-collapse any previously auto-unfolded callouts where the match has left
	if (autoUnfoldedCallouts.length > 0) {
		for (let i = autoUnfoldedCallouts.length - 1; i >= 0; i--) {
			const callout = autoUnfoldedCallouts[i];
			if (callout !== currentCallout) {
				collapseCallout(callout);
				autoUnfoldedCallouts.splice(i, 1);
			}
		}
	}

	if (currentCallout && calloutRange) {
		const rawText = typeof view.state.sliceDoc === "function"
			? view.state.sliceDoc(match.from, match.to)
			: (view.state.doc?.sliceString?.(match.from, match.to) ?? "");
		const matchText = rawText.replace(/^>\s*/, "").trim();
		if (matchText) {
			const activeIdx = getCalloutMatchIndex(view, calloutRange, match.from, matchText);
			highlightMatchedTextInCallout(view, currentCallout, matchText, activeIdx, highlightAll);
		}
	}

	if (match.inTable && match.tableMatchData) {
		highlightTableWidget(view, match.tableMatchData);
		showWidgetTableToast(match.tableMatchData);
	}
}

export function scrollToMatch(view: EditorView, match: MatchRange, isTyping = false) {
	// Auto-expand CM6 folded ranges if match falls inside one
	try {
		const folds = foldedRanges(view.state);
		if (folds && typeof folds.between === "function") {
			folds.between(match.from, match.to, (from, to) => {
				if (!autoUnfoldedFoldRanges.some((r) => r.from === from && r.to === to)) {
					autoUnfoldedFoldRanges.push({ from, to });
				}
				view.dispatch({
					effects: unfoldEffect.of({ from, to }),
				});
			});
		}
	} catch {
		// Ignore
	}

	// Re-fold any previously auto-unfolded fold ranges where the match has left
	if (autoUnfoldedFoldRanges.length > 0) {
		const toReFold: AutoFoldedRange[] = [];
		for (let i = autoUnfoldedFoldRanges.length - 1; i >= 0; i--) {
			const r = autoUnfoldedFoldRanges[i];
			if (match.to <= r.from || match.from >= r.to) {
				toReFold.push(r);
				autoUnfoldedFoldRanges.splice(i, 1);
			}
		}
		if (toReFold.length > 0) {
			try {
				view.dispatch({
					effects: toReFold.map((r) => foldEffect.of(r)),
				});
			} catch {
				// Ignore
			}
		}
	}

	view.dispatch({
		effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), {
			y: "center",
			x: "nearest",
		}),
	});

	applyLivePreviewHighlights(view, match);
	if (typeof window !== "undefined") {
		if (typeof window.requestAnimationFrame === "function") {
			window.requestAnimationFrame(() => {
				applyLivePreviewHighlights(view, match);
			});
		}
		if (typeof window.setTimeout === "function") {
			window.setTimeout(() => {
				applyLivePreviewHighlights(view, match);
			}, 50);
		}
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
	if (!view.dom || typeof view.domAtPos !== "function") return null;
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
	isTyping = false,
	highlightAllMatches = true
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
			highlightAllMatches,
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
		restoreAutoUnfoldedStructures(view, m.from);
		clearAllTableHighlights(view);
		removeWidget(view);
		view.focus();
	} catch (e) {
		console.error("Incremental Search: commitMatch error", e);
		restoreAutoUnfoldedStructures(view);
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
		restoreAutoUnfoldedStructures(view);
		removeWidget(view);
		clearAllTableHighlights(view);
		view.focus();
	} catch (e) {
		console.error("Incremental Search: cancelSession error", e);
		restoreAutoUnfoldedStructures(view);
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
	restoreAutoUnfoldedStructures(view);
	removeWidget(view);
	clearAllTableHighlights(view);
	view.focus();
}
