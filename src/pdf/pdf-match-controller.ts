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
export function findPdfWildcardMatches(
	pageContent: string,
	query: string,
	caseSensitive: boolean
) {
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

/** Joins touching PDF.js fragments from the selected match on the same visual line. */
export function joinNativeSelectedHighlightFragments(containerEl: HTMLElement) {
	const fragments = Array.from(
		containerEl.querySelectorAll<HTMLElement>(
			".textLayer .highlight.selected, .text-layer .highlight.selected"
		)
	);
	for (const fragment of fragments) {
		fragment.classList.remove("incsearch-join-prev", "incsearch-join-next");
	}

	for (let i = 0; i < fragments.length - 1; i++) {
		const current = fragments[i];
		const next = fragments[i + 1];
		const currentRect = current.getBoundingClientRect();
		const nextRect = next.getBoundingClientRect();
		const verticalOverlap =
			Math.min(currentRect.bottom, nextRect.bottom) -
			Math.max(currentRect.top, nextRect.top);
		const minHeight = Math.min(currentRect.height, nextRect.height);
		const edgeGap = Math.min(
			Math.abs(nextRect.left - currentRect.right),
			Math.abs(currentRect.left - nextRect.right)
		);
		const joinTolerance = Math.max(4, minHeight * 0.75);

		if (
			minHeight > 0 &&
			verticalOverlap >= minHeight * 0.6 &&
			edgeGap <= joinTolerance
		) {
			current.classList.add("incsearch-join-next");
			next.classList.add("incsearch-join-prev");
		}
	}
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
	originalMatch?: (query: any, pageContent: string, pageIndex: number) => any;

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
		const findController = this.adapter.findController;
		if (!findController || typeof findController.match !== "function") return;

		this.originalMatch = findController.match;
		findController.match = (query: any, pageContent: string, pageIndex: number) => {
			if (this.usesPluginWildcardSearch()) {
				return findPdfWildcardMatches(
					pageContent,
					this.state.query,
					isCaseSensitive(this.state.query)
				).map((match) => ({
					index: match.from,
					length: match.to - match.from,
				}));
			}
			return this.originalMatch?.call(findController, query, pageContent, pageIndex);
		};
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
		const refreshNativeFragmentJoins = () => {
			window.requestAnimationFrame(() => {
				joinNativeSelectedHighlightFragments(this.adapter.containerEl);
			});
		};

		// Listen to PDF.js text layer rendering events (when DOM spans are mounted)
		const unsubTextLayerRendered = this.adapter.on("textlayerrendered", (evt: any) => {
			const pageNumber = evt?.pageNumber || evt?.pageIndex + 1;
			if (typeof pageNumber === "number") {
				this.refreshPageHighlights(pageNumber);
			}
			refreshNativeFragmentJoins();
		});
		this.unsubscribers.push(unsubTextLayerRendered);

		const unsubTextLayerMatches = this.adapter.on(
			"updatetextlayermatches",
			refreshNativeFragmentJoins
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

		// Toggle CSS visibility class for native text layer highlights
		if (this.shouldShowAllMatches()) {
			this.adapter.containerEl.classList.remove("incsearch-pdf-hide-other-matches");
		} else {
			this.adapter.containerEl.classList.add("incsearch-pdf-hide-other-matches");
		}

		if (this.adapter.executeNativeFind) {
			this.adapter.containerEl.classList.add("incsearch-active-pdf");
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
			const { rects } = computeMatchGeometry(
				pageEl,
				textLayerEl,
				itemSpans,
				model,
				viewport
			);

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

		// If rects already computed, scroll to rect; otherwise scroll page into view
		if (match.rects && match.rects.length > 0) {
			this.adapter.scrollToRect(match.pageNumber, match.rects[0]);
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
		this.destroy();
	}

	cancel() {
		if (
			typeof this.adapter.restoreScrollPosition === "function" &&
			this.originScrollPosition
		) {
			this.adapter.restoreScrollPosition(this.originScrollPosition);
		} else if (this.originPageNumber) {
			this.adapter.scrollPageIntoView(this.originPageNumber);
		}
		this.destroy();
	}

	destroy() {
		this.scanGeneration++;
		this.adapter.containerEl.classList.remove("incsearch-pdf-hide-other-matches");
		this.adapter.containerEl.classList.remove("incsearch-active-pdf");
		if (this.adapter.findController && this.originalMatch) {
			this.adapter.findController.match = this.originalMatch;
			this.originalMatch = undefined;
		}
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
