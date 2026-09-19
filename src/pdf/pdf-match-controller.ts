import { SearchDirection, IncrementalSearchSettings, shouldShowAllMatches } from "../types";
import { isCaseSensitive, findWildcardMatches, parseWildcardQuery } from "../engine";
import {
	PdfMatch,
	PdfSessionState,
	PageTextModel,
	MatchRect,
	PdfViewportAnchor,
	PdfScrollPosition,
} from "./types";
import { PdfViewAdapter } from "./pdf-view-adapter";
import { buildPageTextModel, mapNormalizedRangeToItemSpans } from "./text-model";
import { findPageMatches } from "./pattern-matcher";
import { computeMatchGeometry } from "./match-geometry";
import { renderPageHighlights, clearAllPdfHighlights } from "./highlight-layer";
import { clearSecondaryHighlights } from "./text-layer-highlighter";
import { applyPdfColors, clearPdfColors } from "../utils/colors";
import { logDebug, describeElement } from "../utils/logger";
import { getScrollContainer } from "./pdf-view-adapter";
import {
	isPageCompletelyOffScreen,
	scrollTargetIntoViewIfNeeded,
	getCompoundMatchBoundingRect,
} from "../utils/scroll";

/**
 * Determines whether a PDF match is positioned at or after the top edge of the visible viewport.
 */
export function isMatchAtOrAfterTop(match: PdfMatch, anchor: PdfViewportAnchor): boolean {
	if (match.pageNumber > anchor.topPageNumber) {
		return true;
	}
	if (match.pageNumber < anchor.topPageNumber) {
		return false;
	}
	// On topmost visible page:
	const matchY = match.rects && match.rects.length > 0 ? match.rects[0].top : 0;
	const matchHeight = match.rects && match.rects.length > 0 ? match.rects[0].height : 14;
	const matchX = match.rects && match.rects.length > 0 ? match.rects[0].left : 0;
	const matchRight =
		match.rects && match.rects.length > 0 ? match.rects[0].left + match.rects[0].width : matchX;

	// Below or on top visible line
	if (matchY >= anchor.topPageY - 2) {
		return true;
	}
	// Overlaps top visible line and is at or to the right of horizontal visible boundary
	if (matchY + matchHeight >= anchor.topPageY && matchRight >= anchor.topPageX - 2) {
		return true;
	}
	return false;
}

/**
 * Determines whether a PDF match is positioned at or before the bottom edge of the visible viewport.
 */
export function isMatchAtOrBeforeBottom(match: PdfMatch, anchor: PdfViewportAnchor): boolean {
	if (match.pageNumber < anchor.bottomPageNumber) {
		return true;
	}
	if (match.pageNumber > anchor.bottomPageNumber) {
		return false;
	}
	// On bottommost visible page:
	const matchY = match.rects && match.rects.length > 0 ? match.rects[0].top : 0;
	return matchY <= anchor.bottomPageY + 2;
}

/**
 * Selects the initial active index in a list of PDF matches based on search direction
 * and the visible viewport anchor at search invocation:
 * - Forward search: First match at or after top of visible content (wraps to 0 if all are above).
 * - Backward search: Last match at or before bottom of visible content (wraps to last if all are below).
 */
export function findInitialPdfActiveIndex(
	matches: PdfMatch[],
	direction: SearchDirection,
	anchor: PdfViewportAnchor
): number {
	if (matches.length === 0) return 0;

	if (direction === "forward") {
		const idx = matches.findIndex((m) => isMatchAtOrAfterTop(m, anchor));
		return idx === -1 ? 0 : idx;
	} else {
		let idx = -1;
		for (let i = matches.length - 1; i >= 0; i--) {
			if (isMatchAtOrBeforeBottom(matches[i], anchor)) {
				idx = i;
				break;
			}
		}
		return idx === -1 ? matches.length - 1 : idx;
	}
}

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
 * Applies markdown's line-scoped wildcard semantics to PDF.js page text while
 * preserving the page-relative offsets expected by the native find controller.
 */
export function findPdfWildcardMatches(pageContent: string, query: string, caseSensitive: boolean) {
	const tokens = parseWildcardQuery(query, caseSensitive);
	if (tokens.length === 0) return [];
	const haystack = caseSensitive ? pageContent : pageContent.toLowerCase();
	const matches = [];
	let lineStart = 0;
	const findTokenStart = (token: string, from: number, lineEnd: number) => {
		let tokenStart = haystack.indexOf(token, from);
		while (tokenStart !== -1 && tokenStart < lineEnd) {
			if (tokenStart === 0 || !/[\p{L}\p{N}_]/u.test(haystack[tokenStart - 1])) {
				return tokenStart;
			}
			tokenStart = haystack.indexOf(token, tokenStart + 1);
		}
		return -1;
	};

	while (lineStart <= pageContent.length) {
		const newlineIndex = pageContent.indexOf("\n", lineStart);
		const lineEnd = newlineIndex === -1 ? pageContent.length : newlineIndex;
		let firstTokenStart = findTokenStart(tokens[0], lineStart, lineEnd);
		while (firstTokenStart !== -1 && firstTokenStart < lineEnd) {
			const chars = [{ from: firstTokenStart, to: firstTokenStart + tokens[0].length }];
			let previousEnd = chars[0].to;
			let valid = true;

			for (let i = 1; i < tokens.length; i++) {
				const tokenStart = findTokenStart(tokens[i], previousEnd, lineEnd);
				// PDF.js removes EOL markers during normalization. Bound each wildcard
				// gap to prevent a token on one visual line consuming later paragraphs.
				if (tokenStart === -1 || tokenStart >= lineEnd || tokenStart - previousEnd > 256) {
					valid = false;
					break;
				}
				const tokenEnd = tokenStart + tokens[i].length;
				chars.push({ from: tokenStart, to: tokenEnd });
				previousEnd = tokenEnd;
			}

			if (valid) {
				matches.push({ from: firstTokenStart, to: previousEnd, chars });
			}
			firstTokenStart = findTokenStart(tokens[0], firstTokenStart + 1, lineEnd);
		}
		if (newlineIndex === -1) break;
		lineStart = newlineIndex + 1;
	}

	const nonOverlappingMatches = [];
	let previousEnd = -1;
	for (const match of matches) {
		if (match.from < previousEnd) continue;
		nonOverlappingMatches.push(match);
		previousEnd = match.to;
	}
	return nonOverlappingMatches;
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
		containerEl.querySelectorAll<HTMLElement>(
			".textLayer .highlight.selected, .text-layer .highlight.selected"
		)
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

export class PdfMatchController {
	adapter: PdfViewAdapter;
	settings: IncrementalSearchSettings;
	cache: Map<number, PageTextModel> = new Map();
	state: PdfSessionState;
	scanGeneration = 0;
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
	isProgrammaticScrolling = false;
	pendingTargetPage?: number;
	private matchScrollTimeout?: number;
	private programmaticScrollTimeout?: number;

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

	scheduleActiveMatchScroll(pageNumber?: number) {
		if (this.userHasManuallyScrolled || !this.matchScrollPending) {
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
			if (!scrolled) {
				logDebug("pdf", "scrollActiveMatchIntoView: match is already on-screen, skipping scroll");
			} else {
				logDebug("pdf", "scrollActiveMatchIntoView: match is off-screen, scrolled container");
			}
			this.cancelPendingMatchScroll();
			return true;
		}
		return false;
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
			matches: [],
			activeIndex: 0,
			allMatchesDisplayMode: settings.allMatchesDisplayMode,
			isDemandPeekActive: false,
			isScanning: false,
			totalPages: adapter.numPages,
			scannedPages: 0,
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
					const isMatchEl =
						this.classList.contains("highlight") ||
						this.classList.contains("selected") ||
						this.classList.contains("incsearch-pdf-match");
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
				logDebug("pdf", "findController.scrollMatchIntoView called:", params);
				if (this.userHasManuallyScrolled) {
					logDebug("pdf", "findController.scrollMatchIntoView: user has manually scrolled, skipping scroll!");
					return;
				}
				// Capture before requestMatchScroll() clears it below, so the compound-match
				// branch can still honor a cross-page scroll request from advance().
				const hadPendingTargetPage = Boolean(this.pendingTargetPage);
				this.requestMatchScroll();

				const scrollContainer = getScrollContainer(this.adapter.containerEl);
				const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;
				if (!scrollContainer || !containerRect) return;

				const targetEl = (params?.element ?? (typeof params === "object" ? params : null)) as HTMLElement | undefined;
				if (targetEl && typeof targetEl.getBoundingClientRect === "function") {
					const pageEl = targetEl.closest?.(".page") as HTMLElement | null;
					const targetRect =
						getCompoundMatchBoundingRect(this.adapter.containerEl, pageEl) ??
						targetEl.getBoundingClientRect();
					const targetHeight = targetRect.height ?? (targetRect.bottom - targetRect.top);
					const targetWidth = targetRect.width ?? (targetRect.right - targetRect.left);
					if (targetHeight > 0 || targetWidth > 0) {
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
				}

				const pageIndex =
					typeof params === "number"
						? params
						: typeof params?.pageIndex === "number"
							? params.pageIndex
							: typeof params?.selected?.pageIdx === "number"
								? params.selected.pageIdx
								: (this.adapter.getActiveFindMatchInfo?.()?.pageIndex ?? -1);

				const pageNumber = pageIndex >= 0 ? pageIndex + 1 : -1;
				if (pageNumber > 0) {
					const pageEl = this.adapter.getPageElement(pageNumber);
					if (pageEl && typeof pageEl.getBoundingClientRect === "function") {
						const pageBounds = pageEl.getBoundingClientRect();
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
					this.markProgrammaticScroll();
					this.adapter.scrollPageIntoView(pageNumber);
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
			(this.adapter as any).view?.viewer?.child?.pdfViewer?.pdfViewer,
			(this.adapter as any).view?.viewer?.child?.pdfViewer,
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
				this.userHasManuallyScrolled = true;
				this.cancelPendingMatchScroll();
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
				this.userHasManuallyScrolled = true;
				this.cancelPendingMatchScroll();
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
				this.userHasManuallyScrolled = true;
				this.cancelPendingMatchScroll();
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

		// Listen to PDF.js text layer rendering events (when DOM spans are mounted)
		const unsubTextLayerRendered = this.adapter.on("textlayerrendered", (evt: any) => {
			const pageNumber = evt?.pageNumber || evt?.pageIndex + 1;
			if (typeof pageNumber === "number") {
				this.refreshPageHighlights(pageNumber);
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
				refreshNativeFragmentJoins();
				if (!this.userHasManuallyScrolled && this.matchScrollPending) {
					this.scheduleActiveMatchScroll();
				}
			}
		);
		this.unsubscribers.push(unsubTextLayerMatches);

		// Listen to PDF.js page rendering and zoom events
		const unsubPageRendered = this.adapter.on("pagerendered", (evt: any) => {
			const pageNumber = evt?.pageNumber || evt?.pageIndex + 1;
			if (typeof pageNumber === "number") {
				this.refreshPageHighlights(pageNumber);
			}
		});
		this.unsubscribers.push(unsubPageRendered);

		const unsubPagesLoaded = this.adapter.on("pagesloaded", () => {
			this.refreshAllVisibleHighlights();
		});
		this.unsubscribers.push(unsubPagesLoaded);

		const unsubScale = this.adapter.on("scalechanging", () => {
			this.refreshAllVisibleHighlights();
		});
		this.unsubscribers.push(unsubScale);

		const unsubRotation = this.adapter.on("rotationchanging", () => {
			this.refreshAllVisibleHighlights();
		});
		this.unsubscribers.push(unsubRotation);

		const unsubScroll = this.adapter.on("scroll", () => {
			if (!this.isProgrammaticScrolling) {
				this.userHasManuallyScrolled = true;
				this.cancelPendingMatchScroll();
			}
			this.refreshAllVisibleHighlights();
		});
		this.unsubscribers.push(unsubScroll);

		// Listen to PDF.js native find controller match events
		const clampIndex = (current: number, total: number) =>
			Math.max(0, Math.min(current - 1, Math.max(0, total - 1)));

		const unsubFindCount = this.adapter.on("updatefindmatchescount", (evt: any) => {
			if (evt?.matchesCount) {
				const { current, total } = evt.matchesCount;
				this.state.activeIndex = clampIndex(current, total);
				this.state.totalMatchesCount = total;
				this.notifyStateChange();
				refreshNativeFragmentJoins();
				if (!this.userHasManuallyScrolled && this.matchScrollPending) {
					this.scheduleActiveMatchScroll();
				}
			}
		});
		this.unsubscribers.push(unsubFindCount);

		const unsubFindState = this.adapter.on("updatefindcontrolstate", (evt: any) => {
			if (evt?.matchesCount) {
				const { current, total } = evt.matchesCount;
				this.state.activeIndex = clampIndex(current, total);
				this.state.totalMatchesCount = total;
				this.notifyStateChange();
				refreshNativeFragmentJoins();
				if (!this.userHasManuallyScrolled && this.matchScrollPending) {
					this.scheduleActiveMatchScroll();
				}
			}
		});
		this.unsubscribers.push(unsubFindState);
	}

	private usesPluginWildcardSearch(query = this.state.query): boolean {
		if (!this.settings.spaceAsWildcard || !query || /^\/(.+)\/[a-z]*$/.test(query)) {
			return false;
		}
		return parseWildcardQuery(query, isCaseSensitive(query)).length > 1;
	}

	/**
	 * Extracts or retrieves cached PageTextModel for a given page number.
	 */
	async getPageTextModel(pageNumber: number): Promise<PageTextModel | null> {
		if (this.cache.has(pageNumber)) {
			return this.cache.get(pageNumber)!;
		}

		const page = await this.adapter.getPage(pageNumber);
		if (!page) return null;

		try {
			const textContent = await page.getTextContent();
			const model = buildPageTextModel(pageNumber, textContent.items || []);
			this.cache.set(pageNumber, model);
			return model;
		} catch (e) {
			console.error(`Incremental Search: failed to extract text for page ${pageNumber}`, e);
			return null;
		}
	}

	/**
	 * Executes search across all pages with progressive scanning.
	 */
	async search(query: string, direction = this.state.direction) {
		const generation = ++this.scanGeneration;

		this.state.query = query;
		this.state.direction = direction;
		this.state.matches = [];
		this.state.activeIndex = 0;
		this.state.totalMatchesCount = undefined;
		this.state.isScanning = query.length > 0;
		this.state.scannedPages = 0;

		clearAllPdfHighlights(this.adapter.containerEl);
		clearSecondaryHighlights(this.adapter.containerEl);

		if (query.length > 0) {
			this.requestMatchScroll();
		} else {
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
				highlightAll: this.shouldShowAllMatches(),
				phraseSearch,
				caseSensitive: isCaseSensitive(query),
			});

			this.state.isScanning = false;
			this.notifyStateChange();
			return;
		}

		this.notifyStateChange();

		if (query.length === 0) {
			this.state.isScanning = false;
			this.notifyStateChange();
			return;
		}

		const totalPages = this.adapter.numPages;
		const visiblePages = this.adapter.getVisiblePageNumbers();
		const remainingPages: number[] = [];

		for (let p = 1; p <= totalPages; p++) {
			if (!visiblePages.includes(p)) {
				remainingPages.push(p);
			}
		}

		// 1. Scan visible pages first
		for (const pageNum of visiblePages) {
			if (this.scanGeneration !== generation) return;
			await this.scanPage(pageNum, query, generation);
			this.state.scannedPages++;
			this.notifyStateChange();
		}

		// Determine initial active index relative to viewport anchor
		if (this.state.matches.length > 0) {
			this.state.activeIndex = findInitialPdfActiveIndex(
				this.state.matches,
				this.state.direction,
				this.originAnchor
			);
			this.refreshAllVisibleHighlights();
			this.scrollToMatch(this.state.matches[this.state.activeIndex]);
			this.notifyStateChange();
		}

		// 2. Scan remaining pages in background batches
		for (const pageNum of remainingPages) {
			if (this.scanGeneration !== generation) return;
			await new Promise((resolve) => window.setTimeout(resolve, 0));
			if (this.scanGeneration !== generation) return;

			const prevActiveId = this.getActiveMatch()?.id ?? null;
			await this.scanPage(pageNum, query, generation);
			this.state.scannedPages++;

			if (prevActiveId) {
				const newIdx = this.state.matches.findIndex((m) => m.id === prevActiveId);
				if (newIdx !== -1) {
					this.state.activeIndex = newIdx;
				}
			} else if (this.state.matches.length > 0) {
				this.state.activeIndex = findInitialPdfActiveIndex(
					this.state.matches,
					this.state.direction,
					this.originAnchor
				);
				this.refreshAllVisibleHighlights();
				this.scrollToMatch(this.state.matches[this.state.activeIndex]);
			}

			this.notifyStateChange();
		}

		if (this.scanGeneration === generation) {
			this.state.isScanning = false;
			this.notifyStateChange();
		}
	}

	private async scanPage(pageNumber: number, query: string, generation: number) {
		const model = await this.getPageTextModel(pageNumber);
		if (!model || this.scanGeneration !== generation) return;

		const normalizedMatches = findPageMatches(model, query, {
			spaceAsWildcard: this.settings.spaceAsWildcard,
			caseSensitive: undefined,
		});

		if (normalizedMatches.length === 0) return;

		const pageEl = this.adapter.getPageElement(pageNumber);
		const textLayerEl = this.adapter.getTextLayerElement(pageNumber);
		const viewport = this.adapter.getPageViewport(pageNumber);

		const newPdfMatches: PdfMatch[] = [];

		for (let i = 0; i < normalizedMatches.length; i++) {
			const nm = normalizedMatches[i];
			const itemSpans = mapNormalizedRangeToItemSpans(model, nm.start, nm.end);
			const { rects } = computeMatchGeometry(pageEl, textLayerEl, itemSpans, model, viewport);

			const isDuplicate = newPdfMatches.some((m) => m.from === nm.start && m.to === nm.end);
			if (!isDuplicate) {
				newPdfMatches.push({
					id: `p${pageNumber}-m${i}-${nm.start}-${nm.end}`,
					pageNumber,
					from: nm.start,
					to: nm.end,
					chars: nm.chars,
					itemSpans,
					rects,
				});
			}
		}

		// Insert matches in sorted page and offset order
		this.state.matches.push(...newPdfMatches);
		this.state.matches.sort((a, b) => a.pageNumber - b.pageNumber || a.from - b.from);

		// Render highlights for this page if rendered
		if (pageEl) {
			const activeId = this.getActiveMatch()?.id ?? null;
			const pageMatches = this.state.matches.filter((m) => m.pageNumber === pageNumber);
			renderPageHighlights(pageEl, pageMatches, activeId, this.shouldShowAllMatches());
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
		const highlightAll = this.shouldShowAllMatches();
		if (highlightAll) {
			this.adapter.containerEl.classList.remove("incsearch-pdf-hide-other-matches");
		} else {
			this.adapter.containerEl.classList.add("incsearch-pdf-hide-other-matches");
		}
		if (this.adapter.executeNativeFind && this.state.query) {
			const { processedQuery, phraseSearch } = processPdfQuery(
				this.state.query,
				this.settings.spaceAsWildcard
			);
			this.adapter.executeNativeFind({
				query: processedQuery,
				type: "",
				findPrevious: false,
				highlightAll,
				phraseSearch,
				caseSensitive: isCaseSensitive(this.state.query),
			});
		}
		this.refreshAllVisibleHighlights();
		this.notifyStateChange();
	}

	toggleDemandHighlights() {
		const mode = this.settings.allMatchesDisplayMode ?? "on-demand";
		if (mode !== "on-demand") return;
		this.setDemandPeekActive(!this.state.isDemandPeekActive);
	}

	refreshPageHighlights(pageNumber: number) {
		const pageEl = this.adapter.getPageElement(pageNumber);
		if (!pageEl) return;

		const pageMatches = this.state.matches.filter((m) => m.pageNumber === pageNumber);
		if (pageMatches.length === 0) {
			renderPageHighlights(pageEl, [], null, this.shouldShowAllMatches());
			return;
		}

		const textLayerEl = this.adapter.getTextLayerElement(pageNumber);
		const model = this.cache.get(pageNumber);
		const viewport = this.adapter.getPageViewport(pageNumber);

		if (model) {
			for (const match of pageMatches) {
				const { rects } = computeMatchGeometry(
					pageEl,
					textLayerEl,
					match.itemSpans,
					model,
					viewport
				);
				if (rects.length > 0) {
					match.rects = rects;
				}
			}
		}

		const activeId = this.getActiveMatch()?.id ?? null;
		renderPageHighlights(pageEl, pageMatches, activeId, this.shouldShowAllMatches());
	}

	refreshAllVisibleHighlights() {
		const visible = this.adapter.getVisiblePageNumbers();
		for (const pageNum of visible) {
			this.refreshPageHighlights(pageNum);
		}
	}

	getActiveMatch(): PdfMatch | null {
		if (this.state.matches.length === 0) return null;
		const index = Math.max(0, Math.min(this.state.activeIndex, this.state.matches.length - 1));
		return this.state.matches[index];
	}

	advance(direction: SearchDirection) {
		this.requestMatchScroll();
		this.state.direction = direction;

		if (this.adapter.executeNativeFind && this.state.query) {
			const { processedQuery, phraseSearch } = processPdfQuery(
				this.state.query,
				this.settings.spaceAsWildcard
			);
			this.adapter.executeNativeFind({
				query: processedQuery,
				type: "again",
				findPrevious: direction === "backward",
				highlightAll: this.shouldShowAllMatches(),
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

		const matches = this.state.matches;
		if (matches.length === 0) return;

		let nextIndex: number;
		if (direction === "forward") {
			nextIndex = this.state.activeIndex + 1;
			if (nextIndex >= matches.length) nextIndex = 0;
		} else {
			nextIndex = this.state.activeIndex - 1;
			if (nextIndex < 0) nextIndex = matches.length - 1;
		}

		this.state.direction = direction;
		this.state.activeIndex = nextIndex;
		this.notifyStateChange();

		const activeMatch = matches[nextIndex];
		this.refreshAllVisibleHighlights();
		if (activeMatch) {
			this.refreshPageHighlights(activeMatch.pageNumber);
		}
		this.scrollToMatch(activeMatch);
	}

	setActiveIndex(index: number) {
		if (index < 0 || index >= this.state.matches.length) return;
		this.requestMatchScroll();
		this.state.activeIndex = index;
		this.notifyStateChange();

		const activeMatch = this.state.matches[index];
		this.refreshAllVisibleHighlights();
		if (activeMatch) {
			this.refreshPageHighlights(activeMatch.pageNumber);
		}
		this.scrollToMatch(activeMatch);
	}

	scrollToMatch(match: PdfMatch | null) {
		if (!match) return;
		this.requestMatchScroll(match.pageNumber);

		// If rects already computed, scroll to union of rects; otherwise scroll page into view
		if (match.rects && match.rects.length > 0) {
			const unionRect = match.rects.reduce(
				(acc, r) => ({
					top: Math.min(acc.top, r.top),
					left: Math.min(acc.left, r.left),
					width: Math.max(acc.left + acc.width, r.left + r.width) - Math.min(acc.left, r.left),
					height: Math.max(acc.top + acc.height, r.top + r.height) - Math.min(acc.top, r.top),
				}),
				{ ...match.rects[0] }
			);
			this.adapter.scrollToRect(match.pageNumber, unionRect);
		} else {
			this.adapter.scrollPageIntoView(match.pageNumber);
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
		if (this.programmaticScrollTimeout) {
			window.clearTimeout(this.programmaticScrollTimeout);
			this.programmaticScrollTimeout = undefined;
		}
		this.scanGeneration++;
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
		this.cache.clear();
	}
}
