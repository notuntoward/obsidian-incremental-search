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
import { isOffScreenVertically, isPageCompletelyOffScreen } from "../utils/scroll";

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
	originalMatch?: (query: any, pageContent: string, pageIndex: number) => any;
	originalPdfViewerScrollPageIntoView?: (...args: any[]) => any;
	originalScrollMatchIntoView?: (params: any) => any;
	originalViewerScrollIntoViews: Map<any, (...args: any[]) => any> = new Map();
	originalElementScrollIntoView?: typeof HTMLElement.prototype.scrollIntoView;
	cleanupScrollProperty?: () => void;

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
		this.setupScrollInterception();
	}

	private setupScrollInterception() {
		const scrollContainer = getScrollContainer(this.adapter.containerEl);
		if (scrollContainer) {
			const origScrollTo = scrollContainer.scrollTo;
			const origScrollBy = scrollContainer.scrollBy;
			const origScroll = scrollContainer.scroll;

			if (origScrollTo) {
				scrollContainer.scrollTo = function (...args: any[]) {
					logDebug("pdf", `scrollContainer.scrollTo called with args=${JSON.stringify(args)}`, new Error().stack);
					return origScrollTo.apply(this, args as any);
				};
			}

			if (origScrollBy) {
				scrollContainer.scrollBy = function (...args: any[]) {
					logDebug("pdf", `scrollContainer.scrollBy called with args=${JSON.stringify(args)}`, new Error().stack);
					return origScrollBy.apply(this, args as any);
				};
			}

			if (origScroll) {
				scrollContainer.scroll = function (...args: any[]) {
					logDebug("pdf", `scrollContainer.scroll called with args=${JSON.stringify(args)}`, new Error().stack);
					return origScroll.apply(this, args as any);
				};
			}

			const protoDesc =
				Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") ||
				Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
			if (protoDesc && protoDesc.set && protoDesc.get) {
				const origSet = protoDesc.set;
				const origGet = protoDesc.get;
				try {
					Object.defineProperty(scrollContainer, "scrollTop", {
						configurable: true,
						get() {
							return origGet.call(this);
						},
						set(val: number) {
							const currentVal = origGet.call(this);
							const stack = new Error().stack || "";

							// Suppress internal PDF.js page-switch / pageDiv scroll routines during active search
							if (
								stack.includes("_resetCurrentPageView") ||
								stack.includes("_setCurrentPageNumber") ||
								stack.includes("currentPageNumber") ||
								stack.includes("_updatePage") ||
								stack.includes("_scrollIntoView")
							) {
								logDebug(
									"pdf",
									`scrollContainer.scrollTop SETTER suppressed (page-switch routine): requested=${val}, current=${currentVal}`
								);
								return;
							}

							logDebug(
								"pdf",
								`scrollContainer.scrollTop SETTER applied: val=${val}, current=${currentVal}`
							);
							origSet.call(this, val);
						},
					});
				} catch {
					// Ignore if property is non-configurable
				}
			}

			this.cleanupScrollProperty = () => {
				try {
					delete (scrollContainer as any).scrollTop;
				} catch {}
				if (origScrollTo) scrollContainer.scrollTo = origScrollTo;
				if (origScrollBy) scrollContainer.scrollBy = origScrollBy;
				if (origScroll) scrollContainer.scroll = origScroll;
			};
		}
	}

	private setupFindControllerHook() {
		const container = this.adapter.containerEl;

		// 1. Intercept DOM scrollIntoView calls inside this PDF container
		const originalElementScrollIntoView = HTMLElement.prototype.scrollIntoView;
		this.originalElementScrollIntoView = originalElementScrollIntoView;
		HTMLElement.prototype.scrollIntoView = function (
			this: HTMLElement,
			arg?: boolean | ScrollIntoViewOptions
		) {
			if (container && container.contains(this) && this !== container) {
				const scrollContainer = getScrollContainer(container, this);
				if (scrollContainer) {
					const containerRect = scrollContainer.getBoundingClientRect();
					const targetRect = this.getBoundingClientRect();

					if (targetRect.height > 0 || targetRect.width > 0) {
						const isOffScreen = isOffScreenVertically(targetRect, containerRect);
						logDebug(
							"pdf",
							`scrollIntoView on <${this.tagName.toLowerCase()}.${this.className}>: target=[${targetRect.top.toFixed(1)}, ${targetRect.bottom.toFixed(1)}], container=[${containerRect.top.toFixed(1)}, ${containerRect.bottom.toFixed(1)}], isOffScreen=${isOffScreen}`
						);
						if (!isOffScreen) {
							logDebug(
								"pdf",
								`scrollIntoView on <${this.tagName.toLowerCase()}.${this.className}>: already on-screen, suppressing scroll`
							);
							return;
						}
						logDebug(
							"pdf",
							`scrollIntoView on <${this.tagName.toLowerCase()}.${this.className}>: off-screen, centering vertically`
						);
						return originalElementScrollIntoView.call(this, {
							block: "center",
							inline: "nearest",
							behavior: "smooth",
						});
					}
				}
			}
			return originalElementScrollIntoView.call(this, arg);
		};

		// 2. Intercept PDF.js findController matching
		const findController = this.adapter.findController;
		logDebug("pdf", "PDF objects inspection:", {
			hasFindController: Boolean(findController),
			findControllerKeys: findController ? Object.keys(findController).slice(0, 30) : [],
			hasPdfViewer: Boolean(this.adapter.pdfViewer),
			pdfViewerKeys: this.adapter.pdfViewer ? Object.keys(this.adapter.pdfViewer).slice(0, 30) : [],
			hasFindEventBus: Boolean(findController?._eventBus || findController?.eventBus),
			hasLinkService: Boolean(findController?._linkService || findController?.linkService),
			hasPdfViewerOnFindController: Boolean(findController?._pdfViewer || findController?.pdfViewer),
		});
		if (findController && typeof findController.match === "function") {
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

		// 3. Intercept PDFFindController.scrollMatchIntoView
		if (findController && typeof findController.scrollMatchIntoView === "function") {
			this.originalScrollMatchIntoView = findController.scrollMatchIntoView;
			findController.scrollMatchIntoView = (params: any) => {
				logDebug("pdf", "findController.scrollMatchIntoView called:", params);
				const scrollContainer = getScrollContainer(this.adapter.containerEl);
				const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;
				if (!scrollContainer || !containerRect) return;

				const pageIndex = typeof params?.pageIndex === "number" ? params.pageIndex : -1;
				const pageEl = pageIndex >= 0 ? this.adapter.getPageElement(pageIndex + 1) : null;
				const matchesOnPage = pageEl?.querySelectorAll(".highlight");
				const matchIndex = typeof params?.matchIndex === "number" ? params.matchIndex : -1;

				const targetEl =
					params?.element ||
					pageEl?.querySelector(".highlight.selected, .highlight.is-selected, .incsearch-pdf-match.is-current") ||
					(matchesOnPage && matchIndex >= 0 && matchesOnPage[matchIndex]) ||
					this.adapter.containerEl.querySelector(
						".highlight.selected, .highlight.is-selected, .incsearch-pdf-match.is-current"
					) as HTMLElement | null;

				if (targetEl && typeof targetEl.getBoundingClientRect === "function") {
					const hlRect = targetEl.getBoundingClientRect();
					if (hlRect.height > 0 || hlRect.width > 0) {
						const isOffScreen = isOffScreenVertically(hlRect, containerRect);
						logDebug(
							"pdf",
							`findController.scrollMatchIntoView: match=[${hlRect.top.toFixed(1)}, ${hlRect.bottom.toFixed(1)}], container=[${containerRect.top.toFixed(1)}, ${containerRect.bottom.toFixed(1)}], isOffScreen=${isOffScreen}`
						);
						if (!isOffScreen) {
							logDebug("pdf", "findController.scrollMatchIntoView: match is already on-screen, skipping scroll!");
							return;
						}
						logDebug("pdf", "findController.scrollMatchIntoView: match is off-screen, centering match!");
						targetEl.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
						return;
					}
				}

				if (pageEl && typeof pageEl.getBoundingClientRect === "function") {
					const pageBounds = pageEl.getBoundingClientRect();
					const isPageOffScreen = isPageCompletelyOffScreen(pageBounds, containerRect);
					logDebug(
						"pdf",
						`findController.scrollMatchIntoView (page fallback): pageBounds=[${pageBounds.top.toFixed(1)}, ${pageBounds.bottom.toFixed(1)}], container=[${containerRect.top.toFixed(1)}, ${containerRect.bottom.toFixed(1)}], isPageOffScreen=${isPageOffScreen}`
					);
					if (!isPageOffScreen) {
						logDebug("pdf", "findController.scrollMatchIntoView: page is already partially on-screen, skipping scroll!");
						return;
					}
					logDebug("pdf", "findController.scrollMatchIntoView: page is completely off-screen, centering page!");
					pageEl.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
					return;
				}

				return this.originalScrollMatchIntoView?.call(findController, params);
			};
		}

		// 4. Intercept PDFViewer._scrollIntoView
		const candidateViewers = [
			findController?._pdfViewer,
			this.adapter.pdfViewer,
			(findController as any)?._linkService?.pdfViewer,
			(this.adapter as any).view?.viewer?.child?.pdfViewer?.pdfViewer,
			(this.adapter as any).view?.viewer?.child?.pdfViewer,
		].filter(Boolean);

		const allViewersAndPrototypes: any[] = [];
		for (const pv of candidateViewers) {
			allViewersAndPrototypes.push(pv);
			const proto = Object.getPrototypeOf(pv);
			if (proto && proto !== Object.prototype) {
				allViewersAndPrototypes.push(proto);
			}
		}

		for (const pv of allViewersAndPrototypes) {
			if (pv && typeof pv._scrollIntoView === "function" && !this.originalViewerScrollIntoViews.has(pv)) {
				const origScrollIntoView = pv._scrollIntoView;
				this.originalViewerScrollIntoViews.set(pv, origScrollIntoView);
				pv._scrollIntoView = (params: any) => {
					logDebug("pdf", "pdfViewer._scrollIntoView called (suppressed during search):", params);
					// Suppress pageDiv scrolling during search; match positioning is handled by scrollMatchIntoView
					return;
				};
			}
		}

		// 5. Intercept PDF.js viewer scrollPageIntoView
		const pdfViewer = findController?._pdfViewer || this.adapter.pdfViewer;
		if (pdfViewer && typeof pdfViewer.scrollPageIntoView === "function") {
			this.originalPdfViewerScrollPageIntoView = pdfViewer.scrollPageIntoView;
			pdfViewer.scrollPageIntoView = (params: any) => {
				logDebug("pdf", "pdfViewer.scrollPageIntoView called (suppressed during search):", params);
				// Suppress pageDiv scrolling during search; match positioning is handled by scrollMatchIntoView
				return;
			};
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
		this.scanGeneration++;
		this.adapter.containerEl.classList.remove("incsearch-pdf-hide-other-matches");
		this.adapter.containerEl.classList.remove("incsearch-active-pdf");
		clearPdfColors(this.adapter.containerEl);
		if (this.cleanupScrollProperty) {
			this.cleanupScrollProperty();
			this.cleanupScrollProperty = undefined;
		}
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
		for (const [pv, orig] of this.originalViewerScrollIntoViews.entries()) {
			pv._scrollIntoView = orig;
		}
		this.originalViewerScrollIntoViews.clear();
		const pdfViewer = this.adapter.findController?._pdfViewer || this.adapter.pdfViewer;
		if (pdfViewer && this.originalPdfViewerScrollPageIntoView) {
			pdfViewer.scrollPageIntoView = this.originalPdfViewerScrollPageIntoView;
			this.originalPdfViewerScrollPageIntoView = undefined;
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
