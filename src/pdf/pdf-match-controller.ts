import { SearchDirection, IncrementalSearchSettings, shouldShowAllMatches } from "../types";
import { findWildcardMatches, isCaseSensitive, isWithinMaxGap, parseWildcardQuery } from "../engine";
import { PdfSessionState, PdfViewportAnchor, PdfScrollPosition } from "./types";
import { PdfViewAdapter } from "./pdf-view-adapter";
import { clearAllPdfHighlights } from "./highlight-layer";
import { clearSecondaryHighlights } from "./text-layer-highlighter";
import { applyPdfColors, clearPdfColors } from "../utils/colors";
import { logDebug, describeElement } from "../utils/logger";
import { getScrollContainer } from "./pdf-view-adapter";
import {
	isPageCompletelyOffScreen,
	isTargetCompletelyOffScreen,
	scrollTargetIntoViewIfNeeded,
	getCompoundMatchBoundingRect,
	isMatchElementCandidate,
	CURRENT_MATCH_SELECTOR,
	ALL_MATCHES_SELECTOR,
	ALL_MATCH_HEADS_SELECTOR,
	NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR,
	BoundingRectLike,
} from "../utils/scroll";

/**
 * Processes a query string for PDF.js findController according to space-as-wildcard rules.
 */
export function processPdfQuery(
	query: string,
	spaceAsWildcard: boolean
): { processedQuery: string; phraseSearch: boolean } {
	if (!query || !spaceAsWildcard) {
		return { processedQuery: query, phraseSearch: true };
	}

	// 1. Multiple spaces (2+): collapsed to N-1 literal spaces and treated as an exact phrase
	if (/ {2,}/.test(query)) {
		const collapsed = query.replace(/ {2,}/g, (match) => " ".repeat(match.length - 1));
		return { processedQuery: collapsed, phraseSearch: true };
	}

	// 2. Single space separating words: search as multi-token words (phraseSearch: false)
	if (/ \S/.test(query.trim())) {
		return { processedQuery: query.trim(), phraseSearch: false };
	}

	return { processedQuery: query, phraseSearch: true };
}

/**
 * Bound on the flexible gap between consecutive wildcard tokens in PDF page text.
 *
 * PDF.js flattens every end-of-line marker to a space before it hands page text to
 * the find controller, so the page arrives as one unbroken string with no line
 * structure. Without a bound, an unquoted query such as "d factor" could pair the
 * first "d" on the page with the last "factor" and return a single match spanning
 * the whole page. Bounding the gap keeps a match to a local neighborhood while
 * still allowing it to span visual lines.
 */
export const PDF_WILDCARD_MAX_GAP_CHARS = 256;

/**
 * Applies markdown's space-as-wildcard semantics to PDF.js page text while
 * preserving the page-relative offsets expected by the native find controller.
 *
 * Token sequencing and non-greedy tightening come from the shared Layer 1 kernel
 * (`findWildcardMatches`), so PDF and Markdown match identically. Page text has
 * already had every end-of-line marker normalized to a space by PDF.js, so a match
 * may span visual lines; only the flexible gap between its tokens is bounded, via
 * the same `isWithinMaxGap` rule the kernel applies for `maxGapChars`.
 */
export function findPdfWildcardMatches(pageContent: string, query: string, caseSensitive: boolean) {
	const tokens = parseWildcardQuery(query, caseSensitive);
	if (tokens.length === 0) return [];
	return findWildcardMatches(pageContent, tokens, 0, caseSensitive).filter((match) =>
		isWithinMaxGap(match.chars, PDF_WILDCARD_MAX_GAP_CHARS)
	);
}

const MAX_PDF_MATCH_REPEAT_DISTANCE = 512;
// Below this length, a fully glued (no-separator) repeat is more likely to be an
// incidental coincidence (e.g. adjacent table cells like "100100") than an actual
// re-printed text run, so glued repeats shorter than this are not deduplicated.
const MIN_GLUED_PDF_MATCH_REPEAT_LENGTH = 12;

const WHITESPACE_EXCEPT_NEWLINE_RE = /[^\S\n]/;

/**
 * Decides whether the boundary between two equal, adjacent blocks of text looks
 * like a re-printed text run (safe to collapse) rather than two independent
 * occurrences that merely happen to be preceded by identical text. Only looks at
 * the single characters straddling the boundary, so it never needs to allocate
 * the (potentially large) block substrings.
 */
function isPlausiblePdfRepeatBoundary(pageContent: string, firstStart: number, distance: number): boolean {
	const secondStart = firstStart + distance;
	const firstBlockLastChar = pageContent.charAt(firstStart + distance - 1);
	const secondBlockFirstChar = pageContent.charAt(secondStart);

	// A repeat that begins with whitespace isn't a glued re-print of the block itself.
	if (/\s/.test(secondBlockFirstChar)) return false;

	if (firstBlockLastChar === "\n") {
		// A hard line break between two identical runs strongly indicates a
		// duplicated text item (which carries its own EOL marker), not prose.
		return true;
	}
	if (WHITESPACE_EXCEPT_NEWLINE_RE.test(firstBlockLastChar)) {
		// Ordinary whitespace-separated word/phrase repetition in prose
		// ("that that", "very very"): never treat this as a duplicate.
		return false;
	}
	// No separator at all: only trust longer runs, since short glued tokens
	// (e.g. adjacent table cell values) can coincidentally repeat.
	return distance >= MIN_GLUED_PDF_MATCH_REPEAT_LENGTH;
}

/**
 * Compares two equal-length blocks of `text` character by character, exiting on
 * the first mismatch instead of allocating substrings for a full `===` compare.
 */
function pdfBlocksEqual(text: string, start1: number, start2: number, length: number): boolean {
	for (let i = 0; i < length; i++) {
		if (text.charCodeAt(start1 + i) !== text.charCodeAt(start2 + i)) return false;
	}
	return true;
}

/**
 * Determines whether `current` is a visually identical repeat of `previous`,
 * caused by a PDF content stream printing the same text run more than once
 * (faux-bold text, drop shadows, overprinted headers/footers). PDF.js matches
 * are offset-based, so such runs produce two matches at the same location.
 */
function isRepeatedPdfMatch(
	pageContent: string,
	previous: { index: number; length: number },
	current: { index: number; length: number }
): boolean {
	const distance = current.index - previous.index;
	if (distance <= 0 || distance > MAX_PDF_MATCH_REPEAT_DISTANCE) return false;
	if (Math.max(previous.length, current.length) < 3) return false;

	const matchEnd = current.index + current.length;
	const maxShift = Math.min(previous.index, distance);
	for (let shift = 0; shift <= maxShift; shift++) {
		const firstStart = previous.index - shift;
		const secondStart = firstStart + distance;
		if (secondStart + distance > pageContent.length) continue;
		// The repeat must fully contain the current match.
		if (current.index < secondStart || matchEnd > secondStart + distance) continue;

		if (!isPlausiblePdfRepeatBoundary(pageContent, firstStart, distance)) continue;
		if (!pdfBlocksEqual(pageContent, firstStart, secondStart, distance)) continue;
		return true;
	}
	return false;
}

/**
 * Collapses duplicate matches that sit at the same visual position because the
 * PDF prints a text run twice. Without this, advancing skips to the duplicate
 * instead of the next real match, and the current match is painted with both
 * the current and secondary highlight styles.
 *
 * Each match is compared against the immediately preceding match in the
 * original (unfiltered) list, not the last surviving one, so a run printed
 * three or more times collapses completely instead of leaving a spurious
 * extra copy once the comparison distance no longer lines up.
 */
export function deduplicateRepeatedPdfMatches(
	pageContent: string,
	matches: { index: number; length: number }[] | undefined | null
): { index: number; length: number }[] | undefined {
	if (!matches || matches.length <= 1) return matches ?? undefined;
	const result: { index: number; length: number }[] = [];
	for (let i = 0; i < matches.length; i++) {
		const current = matches[i];
		const previousOriginal = i > 0 ? matches[i - 1] : undefined;
		if (previousOriginal && isRepeatedPdfMatch(pageContent, previousOriginal, current)) {
			continue;
		}
		result.push(current);
	}
	return result;
}

const PDF_TOKEN_HIGHLIGHT_NAME = "incsearch-pdf-current-token";

interface CssHighlightRegistry {
	delete(name: string): boolean;
	set(name: string, highlight: unknown): void;
}

function getCssHighlightApi(doc: Document) {
	const view = doc.defaultView as
		| (Window & {
			CSS?: typeof CSS & { highlights?: CssHighlightRegistry };
			Highlight?: new (...ranges: Range[]) => unknown;
		})
		| null;
	const registry = view?.CSS?.highlights;
	return { Highlight: view?.Highlight, registry };
}

function clearNativeSelectedTokenHighlights(doc: Document) {
	getCssHighlightApi(doc).registry?.delete(PDF_TOKEN_HIGHLIGHT_NAME);
}

function highlightNativeSelectedTokens(fragments: HTMLElement[], query: string) {
	const { phraseSearch } = processPdfQuery(query, true);
	if (phraseSearch) return;
	const tokens = parseWildcardQuery(query, isCaseSensitive(query));
	if (tokens.length <= 1) return;

	const segments: { node: Text; start: number; end: number }[] = [];
	let selectedText = "";
	for (const fragment of fragments) {
		const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const textNode = node as Text;
			const start = selectedText.length;
			selectedText += textNode.data;
			segments.push({ node: textNode, start, end: selectedText.length });
			node = walker.nextNode();
		}
	}

	const haystack = isCaseSensitive(query) ? selectedText : selectedText.toLowerCase();
	const ranges: { start: number; end: number }[] = [];
	let searchStart = 0;
	for (const token of tokens) {
		const start = haystack.indexOf(token, searchStart);
		if (start === -1) return;
		ranges.push({ start, end: start + token.length });
		searchStart = start + token.length;
	}

	const highlightRanges: Range[] = [];
	for (const segment of segments) {
		const segmentRanges = ranges
			.filter((range) => range.start < segment.end && range.end > segment.start)
			.sort((a, b) => a.start - b.start);
		for (const tokenRange of segmentRanges) {
			const start = Math.max(tokenRange.start, segment.start) - segment.start;
			const end = Math.min(tokenRange.end, segment.end) - segment.start;
			const range = segment.node.ownerDocument.createRange();
			range.setStart(segment.node, start);
			range.setEnd(segment.node, end);
			highlightRanges.push(range);
		}
	}

	const { Highlight, registry } = getCssHighlightApi(fragments[0]?.ownerDocument ?? document);
	if (Highlight && registry && highlightRanges.length > 0) {
		registry.set(PDF_TOKEN_HIGHLIGHT_NAME, new Highlight(...highlightRanges));
	}
}

/** Styles selected PDF.js fragments without replacing their native geometry. */
export function decorateNativeSelectedHighlightFragments(containerEl: HTMLElement, query = "") {
	clearNativeSelectedTokenHighlights(containerEl.ownerDocument);
	const fragments = Array.from(
		containerEl.querySelectorAll<HTMLElement>(NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR)
	);
	for (const fragment of fragments) {
		fragment.classList.remove(
			"incsearch-join-prev",
			"incsearch-join-next",
			"incsearch-line-join-prev",
			"incsearch-line-join-next"
		);
	}

	for (let i = 0; i < fragments.length - 1; i++) {
		const current = fragments[i];
		const next = fragments[i + 1];
		const currentRect = current.getBoundingClientRect();
		const nextRect = next.getBoundingClientRect();
		const verticalOverlap =
			Math.min(currentRect.bottom, nextRect.bottom) - Math.max(currentRect.top, nextRect.top);
		const minHeight = Math.min(currentRect.height, nextRect.height);
		const edgeGap = Math.min(
			Math.abs(nextRect.left - currentRect.right),
			Math.abs(currentRect.left - nextRect.right)
		);
		const joinTolerance = Math.max(4, minHeight * 0.75);

		if (minHeight > 0 && verticalOverlap >= minHeight * 0.6 && edgeGap <= joinTolerance) {
			current.classList.add("incsearch-join-next");
			next.classList.add("incsearch-join-prev");
			continue;
		}

		const verticalGap = nextRect.top - currentRect.bottom;
		const horizontalOverlap =
			Math.min(currentRect.right, nextRect.right) - Math.max(currentRect.left, nextRect.left);
		if (verticalGap >= 0 && verticalGap <= 4 && horizontalOverlap >= 0) {
			current.classList.add("incsearch-line-join-next");
			next.classList.add("incsearch-line-join-prev");
		}
	}

	highlightNativeSelectedTokens(fragments, query);
}

/**
 * Whether a match fragment reports no layout box (e.g. it is detached or hidden),
 * in which case it cannot participate in visibility-based scanning.
 */
function isZeroSizeRect(rect: BoundingRectLike): boolean {
	return rect.width === 0 && rect.height === 0;
}

/**
 * Rounds a bounding rect for diagnostic logging.
 */
function rectSummary(rect: BoundingRectLike): { top: number; bottom: number; left: number; right: number } {
	return {
		top: Math.round(rect.top),
		bottom: Math.round(rect.bottom),
		left: Math.round(rect.left),
		right: Math.round(rect.right),
	};
}

/**
 * Resolves the head fragment of a match. PDF.js splits a match that wraps across
 * lines or text items into begin/middle/end fragments; the plugin always selects
 * and queues the head.
 */
function resolveMatchHeadElement(fragment: HTMLElement): HTMLElement {
	if (!fragment.classList.contains("middle") && !fragment.classList.contains("end")) {
		return fragment;
	}
	let headEl = fragment;
	let prev = headEl.previousElementSibling as HTMLElement | null;
	while (prev && (prev.classList.contains("middle") || prev.classList.contains("begin"))) {
		headEl = prev;
		if (prev.classList.contains("begin")) break;
		prev = prev.previousElementSibling as HTMLElement | null;
	}
	return headEl;
}

export class PdfMatchController {
	adapter: PdfViewAdapter;
	settings: IncrementalSearchSettings;
	state: PdfSessionState;
	originAnchor: PdfViewportAnchor;
	originScrollPosition: PdfScrollPosition;
	originPageNumber: number;
	unsubscribers: (() => void)[] = [];
	onStateChange?: (state: PdfSessionState) => void;
	originalElementScrollIntoView?: typeof HTMLElement.prototype.scrollIntoView;
	originalMatch?: (query: any, pageContent: string, pageIndex: number) => any;
	originalScrollMatchIntoView?: (params: any) => any;
	originalViewerSetCurrentPageNumbers: Map<any, any> = new Map();
	originalViewerScrollIntoViews: Map<any, any> = new Map();
	originalViewerScrollPageIntoViews: Map<any, any> = new Map();
	userHasManuallyScrolled = false;
	matchScrollPending = false;
	isInitialSearchPending = false;
	isProgrammaticScrolling = false;
	pendingTargetPage?: number;
	pendingSteeredMatches: Array<{ el: HTMLElement; pageNumber: number; activeIndex: number }> = [];
	/**
	 * Direction the pending queue was built for. A forward initial search queues
	 * the matches *after* the steered selection (consumed by advancing forward);
	 * a backward initial search queues the matches *before* it in descending order
	 * (consumed by advancing backward). Advancing against the queue's direction
	 * has to step through the queued matches natively instead of shifting it.
	 */
	pendingSteeredMatchesDirection: SearchDirection = "forward";
	/**
	 * True from the start of a query until the user advances or scrolls. PDF.js
	 * recreates highlight spans from its own selection on every text-layer update,
	 * so the initial-search steering must be re-asserted for as long as this is
	 * open, and the steered index must win over PDF.js's cursor in the counter.
	 */
	private initialSteerWindowOpen = false;
	/** Index of the steered match, or -1 when the search did not steer. */
	private steeredActiveIndex = -1;
	/** Page of the steered match, or -1 when the search did not steer. */
	private steeredPageNumber = -1;
	private matchScrollTimeout?: number;
	private programmaticScrollTimeout?: number;
	/** The patched find controller, used when the steering is re-asserted. */
	private findControllerRef?: any;
	/** One-shot guard so the runtime context snapshot is logged once per query. */
	private steeringContextLogged = false;
	/**
	 * Guards the steering re-assert so that several PDF.js events arriving in the
	 * same frame (text-layer updates fire per page, plus the find-count events)
	 * collapse into a single animation-frame callback instead of repeating the
	 * full document scan for every event.
	 */
	private steerViewRafPending = false;
	/**
	 * Vertical window (in the scroll container's document space) that was on screen
	 * when the query session started: the view the user was looking at when they
	 * asked for the search.
	 *
	 * Steering must judge "visible" against this, not against the live scroll
	 * position. PDF.js scrolls to its own match before the plugin gets to steer,
	 * and once the viewport has moved, whatever PDF.js picked looks like the
	 * correct "bottom-most visible" match, so every later attempt confirms it
	 * instead of correcting it. Document space keeps the captured view valid even
	 * after the scroll position changes.
	 */
	private steerWindowStart?: number;
	private steerWindowEnd?: number;

	requestMatchScroll(targetPage?: number) {
		this.userHasManuallyScrolled = false;
		this.matchScrollPending = true;
		this.pendingTargetPage = targetPage;
		if (this.matchScrollTimeout) {
			window.clearTimeout(this.matchScrollTimeout);
		}
		this.matchScrollTimeout = window.setTimeout(() => {
			this.matchScrollPending = false;
			this.pendingTargetPage = undefined;
			this.matchScrollTimeout = undefined;
		}, 2000);
	}

	cancelPendingMatchScroll() {
		this.matchScrollPending = false;
		this.pendingTargetPage = undefined;
		if (this.matchScrollTimeout) {
			window.clearTimeout(this.matchScrollTimeout);
			this.matchScrollTimeout = undefined;
		}
	}

	markProgrammaticScroll() {
		this.isProgrammaticScrolling = true;
		if (this.programmaticScrollTimeout) {
			window.clearTimeout(this.programmaticScrollTimeout);
		}
		this.programmaticScrollTimeout = window.setTimeout(() => {
			this.isProgrammaticScrolling = false;
			this.programmaticScrollTimeout = undefined;
		}, 400);
	}

	/**
	 * Latches "the user has taken over the view" and ends the initial-search
	 * steering window. The frozen search-time viewport is only valid while the
	 * user has not scrolled since it was captured; once they have, the next query
	 * must re-capture the window where the user is actually looking instead of
	 * snapping the view back to the stale one.
	 */
	private markUserScrolled() {
		this.userHasManuallyScrolled = true;
		this.cancelPendingMatchScroll();
		this.closeInitialSteering();
	}

	/**
	 * Ends the initial-search steering window and discards the frozen search-time
	 * view, so the next query session re-captures both from scratch.
	 */
	private closeInitialSteering() {
		this.initialSteerWindowOpen = false;
		this.steeredActiveIndex = -1;
		this.steeredPageNumber = -1;
		this.steerWindowStart = undefined;
		this.steerWindowEnd = undefined;
	}

	/**
	 * Moves the "current match" selection onto a match head element: clears every
	 * element the canonical current-match selector matches, marks the head
	 * selected, and extends the selection across the begin/middle/end fragments of
	 * a match that wraps lines or text items.
	 */
	private selectMatchHead(headEl: HTMLElement) {
		const prevSelected = Array.from(
			this.adapter.containerEl.querySelectorAll<HTMLElement>(CURRENT_MATCH_SELECTOR)
		);
		for (const el of prevSelected) {
			el.classList.remove("selected", "is-selected", "is-current");
		}
		headEl.classList.add("selected");
		if (headEl.classList.contains("begin")) {
			let next = headEl.nextElementSibling as HTMLElement | null;
			while (next && (next.classList.contains("middle") || next.classList.contains("end"))) {
				next.classList.add("selected");
				if (next.classList.contains("end")) break;
				next = next.nextElementSibling as HTMLElement | null;
			}
		}
	}

	/**
	 * The element currently marked as the active match: PDF.js's own selected
	 * text-layer fragment when present, otherwise the plugin-injected mark.
	 */
	private getSelectedMatchElement(): HTMLElement | null {
		return (
			this.adapter.containerEl.querySelector<HTMLElement>(
				NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR
			) ?? this.adapter.containerEl.querySelector<HTMLElement>(CURRENT_MATCH_SELECTOR)
		);
	}

	scheduleActiveMatchScroll(pageNumber?: number) {
		if (this.userHasManuallyScrolled || !this.matchScrollPending) {
			return;
		}
		// While the initial-search steering owns the selection, the compound-match
		// geometry can still describe PDF.js's own (wrong) match, and scrolling to
		// it is what drags the view away mid-typing. Keep the view on the steered
		// match instead.
		if (this.shouldReassertInitialSteering()) {
			this.ensureSteeredMatchVisible();
			return;
		}
		if (this.scrollActiveMatchIntoView(pageNumber)) {
			return;
		}
		window.requestAnimationFrame(() => {
			if (!this.userHasManuallyScrolled && this.matchScrollPending) {
				if (this.scrollActiveMatchIntoView(pageNumber)) {
					return;
				}
				window.setTimeout(() => {
					if (!this.userHasManuallyScrolled && this.matchScrollPending) {
						this.scrollActiveMatchIntoView(pageNumber);
					}
				}, 40);
			}
		});
	}

	selectAndScrollMatch(matchEl: HTMLElement, pageNumber: number) {
		this.selectMatchHead(matchEl);

		const scrollContainer = getScrollContainer(this.adapter.containerEl);
		if (scrollContainer) {
			const pageEl = this.adapter.getPageElement(pageNumber);
			const targetRect =
				getCompoundMatchBoundingRect(this.adapter.containerEl, pageEl) ??
				matchEl.getBoundingClientRect();
			this.markProgrammaticScroll();
			scrollTargetIntoViewIfNeeded(targetRect, scrollContainer, {
				behavior: "smooth",
				forceCenter: false,
			});
			this.cancelPendingMatchScroll();
		}
	}

	scrollActiveMatchIntoView(pageNumber?: number): boolean {
		if (this.userHasManuallyScrolled || !this.matchScrollPending) {
			return false;
		}
		const scrollContainer = getScrollContainer(this.adapter.containerEl);
		const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;
		if (!scrollContainer || !containerRect) return false;

		const pageEl = typeof pageNumber === "number" ? this.adapter.getPageElement(pageNumber) : null;
		const compoundRect = getCompoundMatchBoundingRect(this.adapter.containerEl, pageEl);

		if (compoundRect && (compoundRect.width > 0 || compoundRect.height > 0)) {
			this.markProgrammaticScroll();
			const forceCenter = Boolean(this.pendingTargetPage && this.pendingTargetPage === pageNumber);
			const scrolled = scrollTargetIntoViewIfNeeded(compoundRect, scrollContainer, {
				behavior: "smooth",
				forceCenter,
			});
			logDebug(
				"pdf",
				`scrollActiveMatchIntoView: pageArg=${String(pageNumber)} forceCenter=${forceCenter} match=[top ${compoundRect.top.toFixed(1)}, bottom ${compoundRect.bottom.toFixed(1)}, left ${compoundRect.left.toFixed(1)}, right ${compoundRect.right.toFixed(1)}] container=[top ${containerRect.top.toFixed(1)}, bottom ${containerRect.bottom.toFixed(1)}, left ${containerRect.left.toFixed(1)}, right ${containerRect.right.toFixed(1)}] scrollContainer=${describeElement(scrollContainer)} ${scrolled ? "SCROLLED" : "ALREADY-ON-SCREEN/SKIPPED"}`
			);
			this.cancelPendingMatchScroll();
			return true;
		}
		logDebug(
			"pdf",
			`scrollActiveMatchIntoView: no match rect found for pageArg=${String(pageNumber)} (returning false so caller can retry)`
		);
		return false;
	}

	/**
	 * Page number a mounted match fragment belongs to, derived from the page
	 * element that contains it. Returns -1 when the fragment is not inside a
	 * numbered page (e.g. plugin-injected decorations outside a page).
	 */
	getMatchPageNumber(fragment: HTMLElement): number {
		const pageEl = fragment.closest?.(".page") as HTMLElement | null;
		const attr = pageEl?.getAttribute?.("data-page-number");
		const pageNumber = attr ? parseInt(attr, 10) : NaN;
		return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : -1;
	}

	/**
	 * Selects the match an initial search starts from: the first visible match in
	 * the search direction (earliest for forward, latest for backward).
	 *
	 * Forward and backward differ only in the order matches are scanned/queued, so
	 * both directions run this one code path.
	 *
	 * This runs twice per search. First from the intercepted
	 * `findController.scrollMatchIntoView`, where `deliveredEl` is PDF.js's own
	 * choice. Then again from the text-layer update handlers: PDF.js recreates
	 * highlight spans from its internal selection on every
	 * `updatetextlayermatches`, which discards the steered selection, so the
	 * steering has to be re-asserted until the user advances or scrolls.
	 *
	 * Returns the steered match, or null when there is nothing to steer to.
	 */
	private steerInitialSearch(
		deliveredEl: HTMLElement | null,
		containerRect: BoundingRectLike
	): { el: HTMLElement; rect: BoundingRectLike; pageNumber: number } | null {
		const backward = this.state.direction === "backward";

		// Match fragments in reading order, with their layout rects. Reading order
		// is DOM order (pages are mounted in page order), which is authoritative
		// here: the viewer's visible-page API may not report a trailing page even
		// though its content is on screen, and the per-match geometry check filters
		// out anything genuinely off-screen.
		const allFragments = Array.from(
			this.adapter.containerEl.querySelectorAll<HTMLElement>(ALL_MATCHES_SELECTOR)
		)
			.filter((fragment) => typeof fragment.getBoundingClientRect === "function")
			.map((fragment) => ({ el: fragment, rect: fragment.getBoundingClientRect() }))
			.filter(({ rect }) => !isZeroSizeRect(rect));

		// Match heads (one entry per match, in reading order) and the page each
		// belongs to, used for the deferred-match queue and its indices.
		const allMatchHeads: Array<{ el: HTMLElement; pageNum: number }> = [];
		for (const { el } of allFragments) {
			if (el.classList.contains("middle") || el.classList.contains("end")) continue;
			const pageNum = this.getMatchPageNumber(el);
			if (pageNum <= 0) continue;
			allMatchHeads.push({ el, pageNum });
		}

		// Visible match fragments ordered by their position on screen: top to
		// bottom, then left to right. This must be geometry, not DOM order: PDF.js
		// appends text-layer spans in content-stream order, which for multi-column
		// pages need not match visual order, and a DOM-ordered scan can then settle
		// on a match in the wrong column.
		const candidates = allFragments
			.slice()
			.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

		// Judge "visible" against the view the user was looking at when they asked
		// for the search, not the live scroll position (see steerWindowStart).
		const hasFrozenWindow = this.steerWindowStart !== undefined && this.steerWindowEnd !== undefined;
		const frozenScrollTop = hasFrozenWindow
			? (getScrollContainer(this.adapter.containerEl)?.scrollTop ?? 0)
			: 0;
		const isVisibleForSteering = (rect: BoundingRectLike): boolean => {
			// Horizontal extent is taken from the live viewport: columns fit the
			// viewer's width, and horizontal scrolling is not modelled here.
			if (rect.right <= containerRect.left || rect.left >= containerRect.right) return false;
			if (!hasFrozenWindow) return !isTargetCompletelyOffScreen(rect, containerRect);
			// Map the live screen rect into the scroll container's document space so
			// the comparison stays valid after PDF.js scrolls the view.
			const docTop = rect.top - containerRect.top + frozenScrollTop;
			const docBottom = rect.bottom - containerRect.top + frozenScrollTop;
			return docBottom >= this.steerWindowStart! && docTop <= this.steerWindowEnd!;
		};

		// First visible match fragment in scan order: topmost for forward,
		// bottom-most for backward.
		const scanOrder = backward ? candidates.slice().reverse() : candidates;
		let visibleMatchEl: HTMLElement | null = null;
		let visibleMatchRect: BoundingRectLike | null = null;
		let visiblePageNum = -1;
		for (const { el, rect } of scanOrder) {
			if (!isVisibleForSteering(rect)) continue;
			visibleMatchEl = resolveMatchHeadElement(el);
			visibleMatchRect = rect;
			visiblePageNum = this.getMatchPageNumber(el);
			break;
		}

		const viewportSource = hasFrozenWindow ? "search-time" : "live";
		const windowSummary = hasFrozenWindow
			? `scrollTop=${frozenScrollTop}, window=[${Math.round(this.steerWindowStart!)},${Math.round(this.steerWindowEnd!)}]`
			: "no frozen window";
		const inventory = allFragments
			.slice(0, 6)
			.map(
				({ el, rect }) =>
					`p${this.getMatchPageNumber(el)}${isVisibleForSteering(rect) ? "-on" : "-off"}@${Math.round(rect.top)}`
			)
			.join(",");

		if (!visibleMatchEl || !visibleMatchRect || visibleMatchEl === deliveredEl) {
			logDebug(
				"pdf",
				`steerInitialSearch: no steering (direction=${backward ? "backward" : "forward"}, viewport=${viewportSource}: ${windowSummary}, fragments=${allFragments.length}, heads=${allMatchHeads.length}, picked=${visibleMatchEl ? describeElement(visibleMatchEl) : "<none>"}, delivered=${deliveredEl ? describeElement(deliveredEl) : "<none>"}, inventory=[${inventory}])`
			);
			return null;
		}
		logDebug(
			"pdf",
			`steerInitialSearch: steering ${backward ? "backward" : "forward"} to visible match on page ${visiblePageNum} (viewport=${viewportSource}: ${windowSummary}, fragments=${allFragments.length}, heads=${allMatchHeads.length}, delivered=${deliveredEl ? describeElement(deliveredEl) : "<none>"}, inventory=[${inventory}])`
		);

		const findController = this.findControllerRef;
		const firstIdx = allMatchHeads.findIndex((m) => m.el === visibleMatchEl);
		const deliveredIdx = deliveredEl ? allMatchHeads.findIndex((m) => m.el === deliveredEl) : -1;

		this.selectMatchHead(visibleMatchEl);

		const pageIndex = visiblePageNum - 1;
		const pageEl = this.adapter.getPageElement(visiblePageNum);
		const targetRect =
			getCompoundMatchBoundingRect(this.adapter.containerEl, pageEl) ?? visibleMatchRect;

		if (findController) {
			const pageMatches = pageEl
				? Array.from(pageEl.querySelectorAll<HTMLElement>(ALL_MATCH_HEADS_SELECTOR))
				: [];
			const matchIdx = Math.max(0, pageMatches.indexOf(visibleMatchEl));
			if (findController._selected) {
				findController._selected.pageIdx = pageIndex;
				findController._selected.matchIdx = matchIdx;
			}
			if (findController.selected) {
				findController.selected.pageIdx = pageIndex;
				findController.selected.matchIdx = matchIdx;
			}

			const pageMatchesArr =
				(findController as any)?.pageMatches || (findController as any)?._pageMatches;
			if (Array.isArray(pageMatchesArr)) {
				let countBefore = 0;
				for (let p = 0; p < pageIndex && p < pageMatchesArr.length; p++) {
					if (Array.isArray(pageMatchesArr[p])) {
						countBefore += pageMatchesArr[p].length;
					}
				}
				const baseActiveIndex = countBefore + matchIdx;
				this.state.activeIndex = baseActiveIndex;
				// PDF.js reports its own cursor in updatefindmatchescount/
				// updatefindcontrolstate; while the steering window is open the
				// steered index must win, otherwise the counter snaps back.
				this.steeredActiveIndex = baseActiveIndex;
				this.steeredPageNumber = visiblePageNum;
				this.notifyStateChange();
			}
		}

		// Build the pendingSteeredMatches queue for the matches between the steered
		// selection and the match PDF.js delivered, nearest first in the search
		// direction. The queue reconciles the plugin's selection with PDF.js's
		// internal cursor: consuming it in the search direction walks the
		// intermediate matches one by one instead of letting native find skip (or
		// repeat) them.
		this.pendingSteeredMatches = [];
		this.pendingSteeredMatchesDirection = backward ? "backward" : "forward";
		if (firstIdx !== -1) {
			const step = backward ? -1 : 1;
			const limit = backward
				? deliveredIdx !== -1 && deliveredIdx < firstIdx
					? deliveredIdx
					: 0
				: deliveredIdx > firstIdx
					? deliveredIdx
					: allMatchHeads.length - 1;
			for (let i = firstIdx + step; backward ? i >= limit : i <= limit; i += step) {
				const item = allMatchHeads[i];
				this.pendingSteeredMatches.push({
					el: item.el,
					pageNumber: item.pageNum,
					activeIndex: (this.steeredActiveIndex >= 0 ? this.steeredActiveIndex : 0) + (i - firstIdx),
				});
			}
		}

		return { el: visibleMatchEl, rect: targetRect, pageNumber: visiblePageNum };
	}

	/**
	 * Whether the initial-search steering still owns the selection: true from the
	 * start of a query until the user advances or scrolls the document.
	 */
	private shouldReassertInitialSteering(): boolean {
		return (
			this.initialSteerWindowOpen &&
			!this.userHasManuallyScrolled &&
			this.state.query.length > 0
		);
	}

	/**
	 * While the initial search is being steered the plugin owns which match is
	 * selected, and that match is already inside the view the user was looking at.
	 * PDF.js still jumps to its own, different match on every keystroke, which
	 * drags the view away from the correct match, so those jumps are suppressed
	 * until the user advances or scrolls.
	 */
	private shouldSuppressViewerPageJump(targetPageNumber?: number): boolean {
		if (!this.initialSteerWindowOpen || this.userHasManuallyScrolled) return false;
		if (this.steeredPageNumber <= 0) return false;
		if (typeof targetPageNumber !== "number" || !Number.isFinite(targetPageNumber)) {
			return true;
		}
		return targetPageNumber !== this.steeredPageNumber;
	}

	/**
	 * Brings the steered match back into view when PDF.js has scrolled somewhere
	 * else (its own match, or a page jump the plugin could not suppress). Restoring
	 * the view is what keeps incremental typing from wandering off: the steered
	 * match is in the view the user started from, so no scroll should be needed at
	 * all, and any that happened must be undone.
	 */
	private ensureSteeredMatchVisible(): void {
		if (!this.shouldReassertInitialSteering()) return;
		const scrollContainer = getScrollContainer(this.adapter.containerEl);
		if (!scrollContainer) return;
		const containerRect = scrollContainer.getBoundingClientRect();
		const selected = this.getSelectedMatchElement();
		if (!selected) return;
		const rect = selected.getBoundingClientRect();
		if (!isTargetCompletelyOffScreen(rect, containerRect)) return;
		this.markProgrammaticScroll();
		const scrolled = scrollTargetIntoViewIfNeeded(rect, scrollContainer, {
			behavior: "auto",
			forceCenter: false,
		});
		logDebug(
			"pdf",
			`ensureSteeredMatchVisible: selected match was off-screen; ${scrolled ? "scrolled back to it" : "no scroll applied"}`
		);
	}

	/**
	 * Re-applies the initial-search steering after PDF.js re-rendered text-layer
	 * highlights (which recreates the spans and restores PDF.js's own selection),
	 * so the steered match stays selected and its position stays in the counter.
	 */
	private reassertInitialSteering(): void {
		if (!this.shouldReassertInitialSteering()) {
			logDebug(
				"pdf",
				`reassertInitialSteering: skipped (windowOpen=${this.initialSteerWindowOpen}, manuallyScrolled=${this.userHasManuallyScrolled}, query="${this.state.query}")`
			);
			return;
		}
		const scrollContainer = getScrollContainer(this.adapter.containerEl);
		const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;
		if (!containerRect) {
			logDebug("pdf", "reassertInitialSteering: no scroll container rect");
			return;
		}
		const nativeSelected = this.getSelectedMatchElement();
		const steered = this.steerInitialSearch(nativeSelected, containerRect);
		this.ensureSteeredMatchVisible();
		logDebug(
			"pdf",
			`reassertInitialSteering: ran (nativeSelected=${describeElement(nativeSelected)}, steered=${steered ? `page ${steered.pageNumber}` : "no"})`
		);
	}

	/**
	 * One-shot diagnostic snapshot of the runtime state the initial-match steering
	 * depends on: which element actually is the container, the scroll element that
	 * was resolved, the pages mounted, and the match spans that exist in the DOM.
	 *
	 * It is recorded in the always-on log ring buffer
	 * (window.getIncSearchLogs()) so a single reproduction shows which assumption
	 * about the real viewer is wrong.
	 */
	private logSteeringContext(targetEl: HTMLElement | null, containerRect: BoundingRectLike | null): void {
		if (this.steeringContextLogged) return;
		this.steeringContextLogged = true;
		const container = this.adapter.containerEl;
		const scrollContainer = getScrollContainer(container);
		const pages = Array.from(container.querySelectorAll<HTMLElement>(".page[data-page-number]"));
		const fragments = Array.from(container.querySelectorAll<HTMLElement>(ALL_MATCHES_SELECTOR));
		logDebug("pdf", "steering context snapshot", {
			direction: this.state.direction,
			query: this.state.query,
			isInitialSearchPending: this.isInitialSearchPending,
			steerWindowOpen: this.initialSteerWindowOpen,
			userHasManuallyScrolled: this.userHasManuallyScrolled,
			container: describeElement(container),
			containerRect: containerRect ? rectSummary(containerRect) : null,
			scrollContainer: describeElement(scrollContainer),
			scrollRect: scrollContainer ? rectSummary(scrollContainer.getBoundingClientRect()) : null,
			visiblePagesFromAdapter: this.adapter.getVisiblePageNumbers?.() ?? null,
			pageElements: pages.length,
			pages: pages
				.slice(0, 8)
				.map((p) => ({ n: p.getAttribute("data-page-number"), ...rectSummary(p.getBoundingClientRect()) })),
			textLayers: container.querySelectorAll(".textLayer").length,
			matchFragmentCount: fragments.length,
			matchFragments: fragments.slice(0, 8).map((el) => ({
				cls: el.className,
				page: this.getMatchPageNumber(el),
				...rectSummary(el.getBoundingClientRect()),
			})),
			delivered: targetEl
				? {
						el: describeElement(targetEl),
						page: this.getMatchPageNumber(targetEl),
						...rectSummary(targetEl.getBoundingClientRect()),
					}
				: null,
		});
	}

	constructor(
		adapter: PdfViewAdapter,
		settings: IncrementalSearchSettings,
		initialDirection: SearchDirection = "forward",
		onStateChange?: (state: PdfSessionState) => void
	) {
		this.adapter = adapter;
		this.settings = settings;
		this.onStateChange = onStateChange;

		this.originAnchor = this.captureViewportAnchor();
		this.originScrollPosition = this.captureScrollPosition();
		this.originPageNumber = this.originAnchor.topPageNumber;

		this.state = {
			query: "",
			direction: initialDirection,
			activeIndex: 0,
			allMatchesDisplayMode: settings.allMatchesDisplayMode,
			isDemandPeekActive: false,
			isScanning: false,
		};

		this.setupEventListeners();
		this.setupFindControllerHook();
	}

	private setupFindControllerHook() {
		const container = this.adapter.containerEl;

		// 1. Intercept DOM scrollIntoView calls inside this PDF container
		const originalElementScrollIntoView = HTMLElement.prototype.scrollIntoView;
		this.originalElementScrollIntoView = originalElementScrollIntoView;
		const self = this;
		HTMLElement.prototype.scrollIntoView = function (
			this: HTMLElement,
			arg?: boolean | ScrollIntoViewOptions
		) {
			if (container && container.contains(this) && this !== container) {
				if (self.userHasManuallyScrolled || !self.matchScrollPending) {
					logDebug(
						"pdf",
						`scrollIntoView on <${this.tagName.toLowerCase()}.${this.className}>: user manually scrolled or no pending scroll, suppressing`
					);
					return;
				}
				const scrollContainer = getScrollContainer(container, this);
				if (scrollContainer) {
					const isMatchEl = isMatchElementCandidate(this);
					const pageEl = this.closest?.(".page") as HTMLElement | null;
					const targetRect = isMatchEl
						? (getCompoundMatchBoundingRect(container, pageEl) ?? this.getBoundingClientRect())
						: this.getBoundingClientRect();

					const targetHeight = targetRect.height ?? (targetRect.bottom - targetRect.top);
					const targetWidth = targetRect.width ?? (targetRect.right - targetRect.left);

					if (targetHeight > 0 || targetWidth > 0) {
						self.markProgrammaticScroll();
						const forceCenter = Boolean(self.pendingTargetPage);
						const scrolled = scrollTargetIntoViewIfNeeded(targetRect, scrollContainer, {
							behavior: "smooth",
							forceCenter,
						});
						if (!scrolled) {
							logDebug(
								"pdf",
								`scrollIntoView on <${this.tagName.toLowerCase()}.${this.className}>: already on-screen, suppressing scroll`
							);
						} else {
							logDebug(
								"pdf",
								`scrollIntoView on <${this.tagName.toLowerCase()}.${this.className}>: off-screen, scrolled to center`
							);
						}
						self.cancelPendingMatchScroll();
						return;
					}
				}
			}
			return originalElementScrollIntoView.call(this, arg);
		};

		// 2. Intercept PDF.js findController matching
		const findController = this.adapter.findController;
		this.findControllerRef = findController;
		const pdfViewer =
			this.adapter.pdfViewer ||
			(findController as any)?._pdfViewer ||
			(findController as any)?.pdfViewer;

		logDebug("pdf", "PDF objects inspection:", {
			hasFindController: Boolean(findController),
			findControllerKeys: findController ? Object.keys(findController).slice(0, 30) : [],
			hasPdfViewer: Boolean(pdfViewer),
			pdfViewerKeys: pdfViewer ? Object.keys(pdfViewer).slice(0, 30) : [],
			hasFindEventBus: Boolean(findController?._eventBus || findController?.eventBus),
			hasLinkService: Boolean(findController?._linkService || findController?.linkService),
			hasPdfViewerOnFindController: Boolean(findController?._pdfViewer || findController?.pdfViewer),
		});

		if (findController && typeof findController.match === "function") {
			this.originalMatch = findController.match;
			findController.match = (query: any, pageContent: string, pageIndex: number) => {
				if (this.usesPluginWildcardSearch()) {
					const wildcardMatches = findPdfWildcardMatches(
						pageContent,
						this.state.query,
						isCaseSensitive(this.state.query)
					).map((match) => ({
						index: match.from,
						length: match.to - match.from,
					}));
					return deduplicateRepeatedPdfMatches(pageContent, wildcardMatches);
				}
				return deduplicateRepeatedPdfMatches(
					pageContent,
					this.originalMatch?.call(findController, query, pageContent, pageIndex)
				);
			};
		}

		// 3. Intercept PDFFindController.scrollMatchIntoView
		if (findController && typeof findController.scrollMatchIntoView === "function") {
			this.originalScrollMatchIntoView = findController.scrollMatchIntoView;
			findController.scrollMatchIntoView = (params: any) => {
				const paramsSummary = {
					element: describeElement(params?.element),
					pageIndex: params?.pageIndex,
					matchIndex: params?.matchIndex,
					selected: params?.selected
						? { pageIdx: params.selected.pageIdx, matchIdx: params.selected.matchIdx }
						: null,
					keys: params && typeof params === "object" ? Object.keys(params).slice(0, 8) : [],
				};
				logDebug("pdf", "findController.scrollMatchIntoView called", {
					params: paramsSummary,
					direction: this.state.direction,
					query: this.state.query,
					isInitialSearchPending: this.isInitialSearchPending,
					steerWindowOpen: this.initialSteerWindowOpen,
					userHasManuallyScrolled: this.userHasManuallyScrolled,
					matchScrollPending: this.matchScrollPending,
					pendingSteeredMatches: this.pendingSteeredMatches.length,
				});
				if (this.userHasManuallyScrolled) {
					logDebug(
						"pdf",
						"findController.scrollMatchIntoView: SKIPPING (userHasManuallyScrolled=true) — steering did NOT run"
					);
					return;
				}
				// Capture before requestMatchScroll() clears it below, so the compound-match
				// branch can still honor a cross-page scroll request from advance().
				const hadPendingTargetPage = Boolean(this.pendingTargetPage);
				this.requestMatchScroll();

				const scrollContainer = getScrollContainer(this.adapter.containerEl);
				const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;
				if (!scrollContainer || !containerRect) return;

				let targetEl = (params?.element ??
					(typeof params === "object" && typeof (params as any)?.getBoundingClientRect === "function" ? params : null)) as HTMLElement | undefined;

				let pageIndex =
					typeof params === "number"
						? params
						: typeof params?.pageIndex === "number"
							? params.pageIndex
							: typeof params?.selected?.pageIdx === "number"
								? params.selected.pageIdx
								: (this.adapter.getActiveFindMatchInfo?.()?.pageIndex ?? -1);

				let pageNumber = pageIndex >= 0 ? pageIndex + 1 : -1;
				let pageEl = targetEl?.closest?.(".page") as HTMLElement | null
					?? (pageNumber > 0 ? this.adapter.getPageElement(pageNumber) : null);

				let targetRect: BoundingRectLike | null = targetEl
					? (getCompoundMatchBoundingRect(this.adapter.containerEl, pageEl) ?? targetEl.getBoundingClientRect())
					: getCompoundMatchBoundingRect(this.adapter.containerEl, pageEl);

				if (this.isInitialSearchPending) {
					this.logSteeringContext(targetEl ?? null, containerRect);
					const steered = this.steerInitialSearch(targetEl ?? null, containerRect);
					if (steered) {
						targetEl = steered.el;
						pageNumber = steered.pageNumber;
						pageIndex = steered.pageNumber - 1;
						pageEl = this.adapter.getPageElement(steered.pageNumber);
						targetRect = steered.rect;
					} else {
						logDebug(
							"pdf",
							"findController.scrollMatchIntoView: initial search did NOT steer; PDF.js's own match stands"
						);
					}
				}
				this.isInitialSearchPending = false;

				const targetHeight = targetRect ? (targetRect.height ?? (targetRect.bottom - targetRect.top)) : 0;
				const targetWidth = targetRect ? (targetRect.width ?? (targetRect.right - targetRect.left)) : 0;

				if (targetRect && (targetHeight > 0 || targetWidth > 0)) {
					logDebug(
						"pdf",
						`findController.scrollMatchIntoView: match=[${targetRect.top.toFixed(1)}, ${targetRect.bottom.toFixed(1)}, ${targetRect.left.toFixed(1)}, ${targetRect.right.toFixed(1)}], container=[${containerRect.top.toFixed(1)}, ${containerRect.bottom.toFixed(1)}, ${containerRect.left.toFixed(1)}, ${containerRect.right.toFixed(1)}]`
					);
					this.markProgrammaticScroll();
					const scrolled = scrollTargetIntoViewIfNeeded(targetRect, scrollContainer, {
						behavior: "smooth",
						forceCenter: hadPendingTargetPage,
					});
					if (!scrolled) {
						logDebug("pdf", "findController.scrollMatchIntoView: match is already on-screen, skipping scroll!");
					} else {
						logDebug("pdf", "findController.scrollMatchIntoView: match is off-screen, scrolled container");
					}
					this.cancelPendingMatchScroll();
					return;
				}

				if (pageNumber > 0) {
					const pageElForCheck = pageEl ?? this.adapter.getPageElement(pageNumber);
					if (pageElForCheck && typeof pageElForCheck.getBoundingClientRect === "function") {
						const pageBounds = pageElForCheck.getBoundingClientRect();
						const isOffScreen = isPageCompletelyOffScreen(pageBounds, containerRect);
						if (!isOffScreen) {
							this.requestMatchScroll();
							this.scheduleActiveMatchScroll(pageNumber);
							logDebug(
								"pdf",
								`findController.scrollMatchIntoView: page ${pageNumber} is already visible on-screen, scheduling active match scroll`
							);
							return;
						}
					}
					this.requestMatchScroll(pageNumber);
					// If the selected page's match is already rendered, center the match itself
					// with a single scroll. Only fall back to a page-level jump — which for a
					// tall/zoomed page can leave the match barely visible at the viewport edge —
					// plus a deferred re-center when the match rect is not yet available (e.g.
					// the page is still virtualized/rendering, so `textlayerrendered` will fire).
					if (this.scrollActiveMatchIntoView(pageNumber)) {
						return;
					}
					this.markProgrammaticScroll();
					this.adapter.scrollPageIntoView(pageNumber);
					this.scheduleActiveMatchScroll(pageNumber);
					return;
				}

				this.scheduleActiveMatchScroll();
			};
		}

		// 4. Intercept PDFViewer page changes and scrollPageIntoView across all candidate instances.
		// Only patch resolved instances, never a shared prototype: an arrow function that closes
		// over a shared prototype object would invoke the original method with `this` bound to
		// that prototype (not the real calling instance) for any other viewer sharing it, breaking
		// or crashing scrolling in unrelated PDF views.
		const candidateViewers = [
			findController?._pdfViewer,
			this.adapter.pdfViewer,
			(findController as any)?._linkService?.pdfViewer,
		].filter(Boolean);

		for (const pv of candidateViewers) {
			if (pv && typeof pv._setCurrentPageNumber === "function" && !this.originalViewerSetCurrentPageNumbers.has(pv)) {
				const origSetCurrentPageNumber = pv._setCurrentPageNumber;
				this.originalViewerSetCurrentPageNumbers.set(pv, origSetCurrentPageNumber);
				pv._setCurrentPageNumber = (val: number, resetCurrentPageView = false) => {
					if (resetCurrentPageView) {
						const pageEl = this.adapter.getPageElement(val);
						const scrollContainer = getScrollContainer(this.adapter.containerEl);
						const containerRect = scrollContainer?.getBoundingClientRect();
						if (pageEl && containerRect) {
							const pageBounds = pageEl.getBoundingClientRect();
							if (!isPageCompletelyOffScreen(pageBounds, containerRect)) {
								logDebug(
									"pdf",
									`pdfViewer._setCurrentPageNumber: page ${val} is already visible, calling with resetCurrentPageView=false to avoid left=0 jump`
								);
								return origSetCurrentPageNumber.call(pv, val, false);
							}
						}
					}
					return origSetCurrentPageNumber.call(pv, val, resetCurrentPageView);
				};
			}

			if (pv && typeof pv._scrollIntoView === "function" && !this.originalViewerScrollIntoViews.has(pv)) {
				const origScrollIntoView = pv._scrollIntoView;
				this.originalViewerScrollIntoViews.set(pv, origScrollIntoView);
				pv._scrollIntoView = (params: any) => {
					if (this.userHasManuallyScrolled) {
						logDebug("pdf", "pdfViewer._scrollIntoView: user has manually scrolled, skipping page jump");
						return;
					}
					const pageDiv = params?.pageDiv || params?.div || (params?.id ? this.adapter.getPageElement(params.id) : null);
					const targetPageAttr = pageDiv?.getAttribute?.("data-page-number");
					const targetPage = typeof params?.pageNumber === "number"
						? params.pageNumber
						: targetPageAttr
							? parseInt(targetPageAttr, 10)
							: undefined;
					if (this.shouldSuppressViewerPageJump(targetPage)) {
						logDebug(
							"pdf",
							`pdfViewer._scrollIntoView: suppressed jump to page ${String(targetPage)} (steering owns page ${this.steeredPageNumber})`
						);
						return;
					}
					const scrollContainer = getScrollContainer(this.adapter.containerEl);
					const containerRect = scrollContainer?.getBoundingClientRect();
					if (pageDiv && scrollContainer && containerRect) {
						const pageBounds = pageDiv.getBoundingClientRect();
						if (!isPageCompletelyOffScreen(pageBounds, containerRect)) {
							logDebug("pdf", "pdfViewer._scrollIntoView: page is already visible, skipping page jump");
							return;
						}
					}
					logDebug("pdf", "pdfViewer._scrollIntoView: delegating to origScrollIntoView");
					return origScrollIntoView.call(pv, params);
				};
			}

			if (pv && typeof pv.scrollPageIntoView === "function" && !this.originalViewerScrollPageIntoViews.has(pv)) {
				const origScrollPageIntoView = pv.scrollPageIntoView;
				this.originalViewerScrollPageIntoViews.set(pv, origScrollPageIntoView);
				pv.scrollPageIntoView = (params: any) => {
					if (this.userHasManuallyScrolled) {
						logDebug("pdf", "pdfViewer.scrollPageIntoView: user has manually scrolled, skipping page jump");
						return;
					}
					const pageNum = typeof params === "number" ? params : params?.pageNumber;
					if (this.shouldSuppressViewerPageJump(pageNum)) {
						logDebug(
							"pdf",
							`pdfViewer.scrollPageIntoView: suppressed jump to page ${String(pageNum)} (steering owns page ${this.steeredPageNumber})`
						);
						return;
					}
					const scrollContainer = getScrollContainer(this.adapter.containerEl);
					const containerRect = scrollContainer?.getBoundingClientRect();
					if (typeof pageNum === "number" && scrollContainer && containerRect) {
						const pageEl = this.adapter.getPageElement(pageNum);
						if (pageEl && typeof pageEl.getBoundingClientRect === "function") {
							const pageBounds = pageEl.getBoundingClientRect();
							if (!isPageCompletelyOffScreen(pageBounds, containerRect)) {
								logDebug("pdf", `pdfViewer.scrollPageIntoView: page ${pageNum} is already visible, skipping page jump`);
								return;
							}
						}
					}
					logDebug("pdf", `pdfViewer.scrollPageIntoView: delegating to origScrollPageIntoView for page ${pageNum}`);
					return origScrollPageIntoView.call(pv, params);
				};
			}
		}
	}

	captureViewportAnchor(): PdfViewportAnchor {
		if (typeof this.adapter.getViewportAnchor === "function") {
			return this.adapter.getViewportAnchor();
		}
		const visible = this.adapter.getVisiblePageNumbers();
		const topPage = visible.length > 0 ? Math.min(...visible) : 1;
		const bottomPage = visible.length > 0 ? Math.max(...visible) : topPage;
		return {
			topPageNumber: topPage,
			topPageY: 0,
			topPageX: 0,
			bottomPageNumber: bottomPage,
			bottomPageY: Infinity,
			bottomPageX: Infinity,
		};
	}

	captureScrollPosition(): PdfScrollPosition {
		if (typeof this.adapter.getScrollPosition === "function") {
			return this.adapter.getScrollPosition();
		}
		const visible = this.adapter.getVisiblePageNumbers();
		return {
			scrollTop: 0,
			scrollLeft: 0,
			pageNumber: visible.length > 0 ? visible[0] : 1,
		};
	}

	private setupEventListeners() {
		const globalScrollListener = (evt: Event) => {
			const target = evt.target as HTMLElement;
			if (target && typeof target.scrollTop === "number") {
				logDebug(
					"pdf",
					`GLOBAL scroll captured on ${describeElement(target)}: scrollTop=${target.scrollTop}, scrollLeft=${target.scrollLeft}`
				);
			}
		};
		window.addEventListener("scroll", globalScrollListener, { capture: true, passive: true });
		this.unsubscribers.push(() => {
			window.removeEventListener("scroll", globalScrollListener, { capture: true } as any);
		});

		const onUserManualScroll = () => {
			if (!this.isProgrammaticScrolling) {
				logDebug(
					"pdf",
					"onUserManualScroll: latching userHasManuallyScrolled=true (no programmatic scroll in flight); matchScrollPending was " +
						String(this.matchScrollPending)
				);
				this.markUserScrolled();
			} else {
				logDebug("pdf", "onUserManualScroll: ignoring scroll event (programmatic scroll in flight)");
			}
		};

		const container = this.adapter.containerEl;

		const onScrollCapture = (evt: Event) => {
			const target = evt.target as Node | null;
			if (target && (container.contains(target) || target === container)) {
				onUserManualScroll();
			}
		};
		window.addEventListener("scroll", onScrollCapture, { capture: true, passive: true });
		container.addEventListener("scroll", onScrollCapture, { capture: true, passive: true });
		this.unsubscribers.push(() => {
			window.removeEventListener("scroll", onScrollCapture, { capture: true } as any);
			container.removeEventListener("scroll", onScrollCapture, { capture: true } as any);
		});

		const onWheelCapture = (evt: Event) => {
			const target = evt.target as Node | null;
			if (target && (container.contains(target) || target === container)) {
				logDebug("pdf", "onWheelCapture: user wheel over PDF container, latching userHasManuallyScrolled=true");
				this.markUserScrolled();
			}
		};
		window.addEventListener("wheel", onWheelCapture, { capture: true, passive: true });
		container.addEventListener("wheel", onWheelCapture, { capture: true, passive: true });
		this.unsubscribers.push(() => {
			window.removeEventListener("wheel", onWheelCapture, { capture: true } as any);
			container.removeEventListener("wheel", onWheelCapture, { capture: true } as any);
		});

		const onPointerDownCapture = (evt: Event) => {
			const target = evt.target as Node | null;
			if (target && (container.contains(target) || target === container)) {
				this.userHasManuallyScrolled = true;
				this.cancelPendingMatchScroll();
			}
		};
		window.addEventListener("pointerdown", onPointerDownCapture, { capture: true, passive: true });
		container.addEventListener("pointerdown", onPointerDownCapture, { capture: true, passive: true });
		this.unsubscribers.push(() => {
			window.removeEventListener("pointerdown", onPointerDownCapture, { capture: true } as any);
			container.removeEventListener("pointerdown", onPointerDownCapture, { capture: true } as any);
		});

		const onTouchMoveCapture = (evt: Event) => {
			const target = evt.target as Node | null;
			if (target && (container.contains(target) || target === container)) {
				this.markUserScrolled();
			}
		};
		window.addEventListener("touchmove", onTouchMoveCapture, { capture: true, passive: true });
		container.addEventListener("touchmove", onTouchMoveCapture, { capture: true, passive: true });
		this.unsubscribers.push(() => {
			window.removeEventListener("touchmove", onTouchMoveCapture, { capture: true } as any);
			container.removeEventListener("touchmove", onTouchMoveCapture, { capture: true } as any);
		});

		const refreshNativeFragmentJoins = () => {
			window.requestAnimationFrame(() => {
				decorateNativeSelectedHighlightFragments(
					this.adapter.containerEl,
					this.state.query
				);
			});
		};

		/**
		 * While the initial-search steering owns the selection, the view is driven
		 * from the steered match: the selection is re-asserted after PDF.js's own
		 * text-layer update has run, and then brought back on screen. Letting the
		 * normal active-match scroll run here would target PDF.js's still-selected
		 * match and drag the view away mid-typing.
		 */
		const driveSteeredView = () => {
			if (this.steerViewRafPending) return;
			this.steerViewRafPending = true;
			window.requestAnimationFrame(() => {
				this.steerViewRafPending = false;
				this.reassertInitialSteering();
			});
		};

		// Listen to PDF.js text layer rendering events (when DOM spans are mounted)
		const unsubTextLayerRendered = this.adapter.on("textlayerrendered", (evt: any) => {
			const pageNumber = evt?.pageNumber || evt?.pageIndex + 1;
			if (this.shouldReassertInitialSteering()) {
				driveSteeredView();
			} else if (typeof pageNumber === "number") {
				if (!this.userHasManuallyScrolled && this.matchScrollPending) {
					this.scheduleActiveMatchScroll(pageNumber);
				}
			}
			refreshNativeFragmentJoins();
		});
		this.unsubscribers.push(unsubTextLayerRendered);

		const unsubTextLayerMatches = this.adapter.on(
			"updatetextlayermatches",
			() => {
				// PDF.js rebuilds the highlight spans from its own selection here, so
				// re-assert the steered selection after all listeners for this event
				// have run (the page's own text layer handler is one of them).
				if (this.shouldReassertInitialSteering()) {
					driveSteeredView();
				} else if (!this.userHasManuallyScrolled && this.matchScrollPending) {
					this.scheduleActiveMatchScroll();
				}
				refreshNativeFragmentJoins();
			}
		);
		this.unsubscribers.push(unsubTextLayerMatches);

		const unsubScroll = this.adapter.on("scroll", () => {
			if (!this.isProgrammaticScrolling) {
				this.markUserScrolled();
			}
		});
		this.unsubscribers.push(unsubScroll);

		// Listen to PDF.js native find controller match events
		const clampIndex = (current: number, total: number) =>
			Math.max(0, Math.min(current - 1, Math.max(0, total - 1)));

		// PDF.js reports its own cursor here. While the initial-search steering owns
		// the selection, the steered index must win, otherwise the counter snaps
		// back to the match PDF.js picked before the steering ran.
		const resolveActiveIndex = (current: number, total: number) =>
			this.shouldReassertInitialSteering() && this.steeredActiveIndex >= 0
				? Math.max(0, Math.min(this.steeredActiveIndex, Math.max(0, total - 1)))
				: clampIndex(current, total);

		// PDF.js reports its own cursor in both updatefindmatchescount and
		// updatefindcontrolstate; the two events carry the same matchesCount shape
		// and get the same treatment, so they share one handler. While the
		// initial-search steering owns the selection the steered index must win,
		// otherwise the counter snaps back to the match PDF.js picked before the
		// steering ran.
		const handleFindMatchesCount = (evt: any) => {
			if (!evt?.matchesCount) return;
			const { current, total } = evt.matchesCount;
			this.state.activeIndex = resolveActiveIndex(current, total);
			this.state.totalMatchesCount = total;
			this.notifyStateChange();
			refreshNativeFragmentJoins();
			if (this.shouldReassertInitialSteering()) {
				driveSteeredView();
			} else if (!this.userHasManuallyScrolled && this.matchScrollPending) {
				this.scheduleActiveMatchScroll();
			}
		};

		this.unsubscribers.push(this.adapter.on("updatefindmatchescount", handleFindMatchesCount));
		this.unsubscribers.push(this.adapter.on("updatefindcontrolstate", handleFindMatchesCount));
	}

	private usesPluginWildcardSearch(query = this.state.query): boolean {
		if (!this.settings.spaceAsWildcard || !query || /^\/(.+)\/[a-z]*$/.test(query)) {
			return false;
		}
		return parseWildcardQuery(query, isCaseSensitive(query)).length > 1;
	}

	/**
	 * Executes a search by delegating to the PDF.js native find controller.
	 */
	async search(query: string, direction = this.state.direction) {
		this.state.query = query;
		this.state.direction = direction;
		this.state.activeIndex = 0;
		this.state.totalMatchesCount = undefined;
		this.state.isScanning = query.length > 0;
		logDebug("pdf", `search: query="${query}" direction=${direction}`);

		clearAllPdfHighlights(this.adapter.containerEl);
		clearSecondaryHighlights(this.adapter.containerEl);

		this.pendingSteeredMatches = [];
		this.pendingSteeredMatchesDirection = "forward";
		this.steeredActiveIndex = -1;
		this.steeredPageNumber = -1;
		this.initialSteerWindowOpen = query.length > 0;
		this.steeringContextLogged = false;
		if (query.length > 0) {
			// Capture the viewport once per query session (the first keystroke after
			// the query was empty). Later keystrokes keep it, so refinements cannot
			// drift with PDF.js's own scrolling.
			if (this.steerWindowStart === undefined) {
				const steerContainer = getScrollContainer(this.adapter.containerEl);
				if (steerContainer) {
					const steerRect = steerContainer.getBoundingClientRect();
					const height = steerRect.height || steerContainer.clientHeight || 0;
					this.steerWindowStart = steerContainer.scrollTop;
					this.steerWindowEnd = steerContainer.scrollTop + height;
				}
			}
			this.isInitialSearchPending = true;
			this.requestMatchScroll();
		} else {
			this.isInitialSearchPending = false;
			this.steerWindowStart = undefined;
			this.steerWindowEnd = undefined;
			this.cancelPendingMatchScroll();
		}

		// Toggle CSS visibility class for native text layer highlights
		if (this.shouldShowAllMatches()) {
			this.adapter.containerEl.classList.remove("incsearch-pdf-hide-other-matches");
		} else {
			this.adapter.containerEl.classList.add("incsearch-pdf-hide-other-matches");
		}

		if (this.adapter.executeNativeFind) {
			this.adapter.containerEl.classList.add("incsearch-active-pdf");
			applyPdfColors(this.adapter.containerEl, this.settings);
			if (query.length === 0) {
				this.adapter.executeNativeFind({
					query: "",
					type: "",
					highlightAll: false,
				});
				this.state.totalMatchesCount = 0;
				this.state.isScanning = false;
				this.notifyStateChange();
				return;
			}

			const { processedQuery, phraseSearch } = processPdfQuery(
				query,
				this.settings.spaceAsWildcard
			);
			this.adapter.executeNativeFind({
				query: processedQuery,
				type: "",
				findPrevious: direction === "backward",
				// PDF.js only renders match spans for non-selected pages when
				// highlightAll is set (TextLayer._updateMatches returns early
				// otherwise), and the initial-match steering has nothing to choose
				// from without them. Ask for all matches so every page and column is
				// visible to the scan; what the user actually sees is governed by the
				// plugin's own CSS (incsearch-pdf-hide-other-matches) in on-demand mode.
				highlightAll: true,
				phraseSearch,
				caseSensitive: isCaseSensitive(query),
			});

			this.state.isScanning = false;
			this.notifyStateChange();
			return;
		}
	}

	shouldShowAllMatches(): boolean {
		return shouldShowAllMatches(
			this.settings.allMatchesDisplayMode ?? "on-demand",
			this.state.isDemandPeekActive
		);
	}

	setDemandPeekActive(active: boolean) {
		if (this.state.isDemandPeekActive === active) return;
		this.state.isDemandPeekActive = active;
		// Visibility is a CSS concern only: the find already rendered every match
		// (highlightAll: true), and re-dispatching a find here would make PDF.js
		// re-select its own match, discarding the initial-search steering.
		if (this.shouldShowAllMatches()) {
			this.adapter.containerEl.classList.remove("incsearch-pdf-hide-other-matches");
		} else {
			this.adapter.containerEl.classList.add("incsearch-pdf-hide-other-matches");
		}
		this.notifyStateChange();
	}

	toggleDemandHighlights() {
		const mode = this.settings.allMatchesDisplayMode ?? "on-demand";
		if (mode !== "on-demand") return;
		this.setDemandPeekActive(!this.state.isDemandPeekActive);
	}

	advance(direction: SearchDirection) {
		this.isInitialSearchPending = false;
		// The user has taken over navigation: the steered selection no longer owns
		// the match, PDF.js's own cursor drives the counter again, and the next
		// query session captures the viewport anew, wherever the user is by then.
		this.closeInitialSteering();
		logDebug(
			"pdf",
			`advance: direction=${direction} (queue=${this.pendingSteeredMatches.length}, queueDirection=${this.pendingSteeredMatchesDirection})`
		);
		this.requestMatchScroll();
		this.state.direction = direction;

		if (this.pendingSteeredMatches.length > 0) {
			if (direction === this.pendingSteeredMatchesDirection) {
				// Advancing along the queue: step to the next queued match without
				// asking PDF.js (whose internal cursor may skip or repeat matches).
				const next = this.pendingSteeredMatches.shift()!;
				this.selectAndScrollMatch(next.el, next.pageNumber);
				this.state.activeIndex = next.activeIndex;
				this.notifyStateChange();
				return;
			}

			// Advancing against the queue's direction: PDF.js's internal cursor is at
			// the delivered match, so stepping past the queued matches plus one lands
			// on the match adjacent to the steered selection.
			const steps = this.pendingSteeredMatches.length + 1;
			this.pendingSteeredMatches = [];
			if (this.adapter.executeNativeFind && this.state.query) {
				const { processedQuery, phraseSearch } = processPdfQuery(
					this.state.query,
					this.settings.spaceAsWildcard
				);
				for (let i = 0; i < steps; i++) {
					this.adapter.executeNativeFind({
						query: processedQuery,
						type: "again",
						findPrevious: direction === "backward",
						// Keep every match rendered, exactly like search() does: in
						// on-demand mode the demand-peek toggle is CSS-only, and a
						// highlightAll:false re-find would make PDF.js drop the spans
						// the peek relies on.
						highlightAll: true,
						phraseSearch,
						caseSensitive: isCaseSensitive(this.state.query),
					});
				}
				this.notifyStateChange();
			}
			return;
		}

		if (this.adapter.executeNativeFind && this.state.query) {
			const { processedQuery, phraseSearch } = processPdfQuery(
				this.state.query,
				this.settings.spaceAsWildcard
			);
			this.adapter.executeNativeFind({
				query: processedQuery,
				type: "again",
				findPrevious: direction === "backward",
				// See the matching comment in the queued-steps branch above.
				highlightAll: true,
				phraseSearch,
				caseSensitive: isCaseSensitive(this.state.query),
			});
			this.notifyStateChange();
			window.requestAnimationFrame(() => {
				if (!this.userHasManuallyScrolled && this.matchScrollPending) {
					this.scheduleActiveMatchScroll();
				}
			});
			return;
		}
	}

	private notifyStateChange() {
		if (this.onStateChange) {
			this.onStateChange({ ...this.state });
		}
	}

	accept() {
		logDebug("pdf", "PdfMatchController accept called");
		this.destroy();
	}

	cancel() {
		logDebug("pdf", "PdfMatchController cancel called");
		if (typeof this.adapter.restoreScrollPosition === "function" && this.originScrollPosition) {
			this.adapter.restoreScrollPosition(this.originScrollPosition);
		} else if (this.originPageNumber) {
			this.adapter.scrollPageIntoView(this.originPageNumber);
		}
		this.destroy();
	}

	destroy() {
		logDebug("pdf", "PdfMatchController destroy called");
		this.cancelPendingMatchScroll();
		this.pendingSteeredMatches = [];
		this.pendingSteeredMatchesDirection = "forward";
		this.closeInitialSteering();
		this.steeringContextLogged = false;
		this.steerViewRafPending = false;
		this.findControllerRef = undefined;
		if (this.programmaticScrollTimeout) {
			window.clearTimeout(this.programmaticScrollTimeout);
			this.programmaticScrollTimeout = undefined;
		}
		this.isProgrammaticScrolling = false;
		this.adapter.containerEl.classList.remove("incsearch-pdf-hide-other-matches");
		this.adapter.containerEl.classList.remove("incsearch-active-pdf");
		clearPdfColors(this.adapter.containerEl);
		if (this.originalElementScrollIntoView) {
			HTMLElement.prototype.scrollIntoView = this.originalElementScrollIntoView;
			this.originalElementScrollIntoView = undefined;
		}
		if (this.adapter.findController && this.originalMatch) {
			this.adapter.findController.match = this.originalMatch;
			this.originalMatch = undefined;
		}
		if (this.adapter.findController && this.originalScrollMatchIntoView) {
			this.adapter.findController.scrollMatchIntoView = this.originalScrollMatchIntoView;
			this.originalScrollMatchIntoView = undefined;
		}
		for (const [pv, orig] of this.originalViewerSetCurrentPageNumbers.entries()) {
			pv._setCurrentPageNumber = orig;
		}
		this.originalViewerSetCurrentPageNumbers.clear();
		for (const [pv, orig] of this.originalViewerScrollIntoViews.entries()) {
			pv._scrollIntoView = orig;
		}
		this.originalViewerScrollIntoViews.clear();
		for (const [pv, orig] of this.originalViewerScrollPageIntoViews.entries()) {
			pv.scrollPageIntoView = orig;
		}
		this.originalViewerScrollPageIntoViews.clear();
		if (this.adapter.executeNativeFind) {
			this.adapter.executeNativeFind({
				query: "",
				type: "find",
				highlightAll: false,
			});
		}
		clearSecondaryHighlights(this.adapter.containerEl);
		clearAllPdfHighlights(this.adapter.containerEl);
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
	}
}
