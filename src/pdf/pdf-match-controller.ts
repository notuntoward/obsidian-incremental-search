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
import { injectSecondaryHighlights, clearSecondaryHighlights } from "./text-layer-highlighter";

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

	private setupFindControllerHook() {
		const fc = this.adapter.findController;
		if (!fc) return;

		if (typeof fc.match === "function") {
			this.originalMatch = fc.match.bind(fc);
		}

		fc.match = (query: any, pageContent: string, pageIndex: number) => {
			if (
				this.settings.spaceAsWildcard &&
				this.state.query &&
				this.state.query.trim().length > 0
			) {
				const q = this.state.query;
				// If query has space separation between words (wildcard gap or literal spaces)
				if (q.includes(" ")) {
					const caseSensitive = isCaseSensitive(q);
					const wildcardMatches = findWildcardMatches(pageContent, q, 0, caseSensitive);
					return wildcardMatches.map((m) => ({
						index: m.from,
						length: m.to - m.from,
					}));
				}
			}

			if (this.originalMatch) {
				return this.originalMatch(query, pageContent, pageIndex);
			}
			return undefined;
		};
	}

	private setupEventListeners() {
		// Listen to PDF.js text layer rendering events (when DOM spans are mounted)
		const unsubTextLayerRendered = this.adapter.on("textlayerrendered", (evt: any) => {
			const pageNumber = evt?.pageNumber || evt?.pageIndex + 1;
			if (typeof pageNumber === "number") {
				this.refreshPageHighlights(pageNumber);
				if (this.state.query) {
					this.scheduleSecondaryHighlightInjection(this.state.query);
				}
			}
		});
		this.unsubscribers.push(unsubTextLayerRendered);

		// Listen to PDF.js page rendering and zoom events
		const unsubPageRendered = this.adapter.on("pagerendered", (evt: any) => {
			const pageNumber = evt?.pageNumber || evt?.pageIndex + 1;
			if (typeof pageNumber === "number") {
				this.refreshPageHighlights(pageNumber);
				if (this.state.query) {
					this.scheduleSecondaryHighlightInjection(this.state.query);
				}
			}
		});
		this.unsubscribers.push(unsubPageRendered);

		const unsubPagesLoaded = this.adapter.on("pagesloaded", () => {
			this.refreshAllVisibleHighlights();
			if (this.state.query) {
				this.scheduleSecondaryHighlightInjection(this.state.query);
			}
		});
		this.unsubscribers.push(unsubPagesLoaded);

		const unsubScale = this.adapter.on("scalechanging", () => {
			this.refreshAllVisibleHighlights();
			if (this.state.query) {
				this.scheduleSecondaryHighlightInjection(this.state.query);
			}
		});
		this.unsubscribers.push(unsubScale);

		const unsubRotation = this.adapter.on("rotationchanging", () => {
			this.refreshAllVisibleHighlights();
			if (this.state.query) {
				this.scheduleSecondaryHighlightInjection(this.state.query);
			}
		});
		this.unsubscribers.push(unsubRotation);

		const unsubScroll = this.adapter.on("scroll", () => {
			this.refreshAllVisibleHighlights();
			if (this.state.query) {
				this.scheduleSecondaryHighlightInjection(this.state.query);
			}
		});
		this.unsubscribers.push(unsubScroll);

		// Listen to PDF.js native find controller match events
		const unsubFindCount = this.adapter.on("updatefindmatchescount", (evt: any) => {
			if (evt?.matchesCount) {
				const { current, total } = evt.matchesCount;
				this.state.activeIndex = Math.max(0, current - 1);
				this.state.totalMatchesCount = total;
				this.notifyStateChange();
				if (this.state.query) {
					this.scheduleSecondaryHighlightInjection(this.state.query);
				}
			}
		});
		this.unsubscribers.push(unsubFindCount);

		const unsubFindState = this.adapter.on("updatefindcontrolstate", (evt: any) => {
			if (evt?.matchesCount) {
				const { current, total } = evt.matchesCount;
				this.state.activeIndex = Math.max(0, current - 1);
				this.state.totalMatchesCount = total;
				this.notifyStateChange();
				if (this.state.query) {
					this.scheduleSecondaryHighlightInjection(this.state.query);
				}
			}
		});
		this.unsubscribers.push(unsubFindState);
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

			this.scheduleSecondaryHighlightInjection(query, generation);

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
			if (this.state.query) {
				this.scheduleSecondaryHighlightInjection(this.state.query);
			}
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

	/**
	 * Inject inline highlight spans into visible text layers.
	 * These are inline elements within the text layer's own spans,
	 * so their geometry matches the text exactly — no coordinate math.
	 */
	injectSecondaryHighlightsOnVisiblePages(query = this.state.query) {
		if (!query || query.trim().length === 0) return;
		const caseSens = isCaseSensitive(query);
		const spaceWildcard = this.settings.spaceAsWildcard;
		const activeInfo = this.adapter.getActiveFindMatchInfo?.() ?? null;

		// 1. Try visible pages via adapter
		const visible = this.adapter.getVisiblePageNumbers();
		const processedLayers = new Set<HTMLElement>();

		for (const pageNum of visible) {
			const textLayerEl = this.adapter.getTextLayerElement(pageNum);
			if (textLayerEl) {
				processedLayers.add(textLayerEl);
				const isPageActive = Boolean(
					activeInfo && activeInfo.pageIndex === pageNum - 1
				);
				const activeIdxOnPage = isPageActive
					? activeInfo!.matchIndex
					: activeInfo
					? -1
					: undefined;
				injectSecondaryHighlights(
					textLayerEl,
					query,
					caseSens,
					spaceWildcard,
					activeIdxOnPage
				);
			}
		}

		// 2. Also sweep any mounted textLayer elements in the container that weren't processed
		const allTextLayers = this.adapter.containerEl.querySelectorAll(
			".textLayer, .text-layer, [class*='textLayer'], [class*='text-layer']"
		);
		for (let i = 0; i < allTextLayers.length; i++) {
			const el = allTextLayers[i] as HTMLElement;
			if (
				!processedLayers.has(el) &&
				(el.offsetWidth > 0 || el.offsetHeight > 0 || el.children.length > 0)
			) {
				injectSecondaryHighlights(el, query, caseSens, spaceWildcard);
			}
		}
	}

	/**
	 * Multi-stage secondary highlight injection: runs immediately, on the next animation frame,
	 * and after micro-delays to handle PDF.js's asynchronous text layer rendering lifecycle.
	 */
	scheduleSecondaryHighlightInjection(query: string, generation = this.scanGeneration) {
		if (!query || query.trim().length === 0) return;

		// Pass 1: Immediate
		this.injectSecondaryHighlightsOnVisiblePages(query);

		// Pass 2: Next animation frame
		window.requestAnimationFrame(() => {
			if (this.scanGeneration !== generation) return;
			this.injectSecondaryHighlightsOnVisiblePages(query);
		});

		// Pass 3: Micro-delays across PDF.js async rendering pipeline
		const delays = [60, 180, 350, 600];
		for (const delay of delays) {
			window.setTimeout(() => {
				if (this.scanGeneration !== generation) return;
				this.injectSecondaryHighlightsOnVisiblePages(query);
			}, delay);
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
			this.scheduleSecondaryHighlightInjection(this.state.query);
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
				type: "",
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
