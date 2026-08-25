import { SearchDirection, IncrementalSearchSettings } from "../types";
import { PdfMatch, PdfSessionState, PageTextModel, MatchRect } from "./types";
import { PdfViewAdapter } from "./pdf-view-adapter";
import { buildPageTextModel, mapNormalizedRangeToItemSpans } from "./text-model";
import { findPageMatches } from "./pattern-matcher";
import { computeMatchGeometry } from "./match-geometry";
import { renderPageHighlights, clearAllPdfHighlights } from "./highlight-layer";

export class PdfMatchController {
	adapter: PdfViewAdapter;
	settings: IncrementalSearchSettings;
	cache: Map<number, PageTextModel> = new Map();
	state: PdfSessionState;
	scanGeneration = 0;
	originPageNumber: number;
	unsubscribers: (() => void)[] = [];
	onStateChange?: (state: PdfSessionState) => void;

	constructor(
		adapter: PdfViewAdapter,
		settings: IncrementalSearchSettings,
		initialDirection: SearchDirection = "forward",
		onStateChange?: (state: PdfSessionState) => void
	) {
		this.adapter = adapter;
		this.settings = settings;
		this.onStateChange = onStateChange;

		const visible = adapter.getVisiblePageNumbers();
		this.originPageNumber = visible.length > 0 ? visible[0] : 1;

		this.state = {
			query: "",
			direction: initialDirection,
			matches: [],
			activeIndex: 0,
			highlightAllMatches: settings.highlightAllMatches,
			isScanning: false,
			totalPages: adapter.numPages,
			scannedPages: 0,
		};

		this.setupEventListeners();
	}

	private setupEventListeners() {
		// Listen to PDF.js text layer rendering events (when DOM spans are mounted)
		const unsubTextLayerRendered = this.adapter.on("textlayerrendered", (evt: any) => {
			const pageNumber = evt?.pageNumber || evt?.pageIndex + 1;
			if (typeof pageNumber === "number") {
				this.refreshPageHighlights(pageNumber);
			}
		});
		this.unsubscribers.push(unsubTextLayerRendered);

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
		const unsubFindCount = this.adapter.on("updatefindmatchescount", (evt: any) => {
			if (evt?.matchesCount) {
				const { current, total } = evt.matchesCount;
				this.state.activeIndex = Math.max(0, current - 1);
				this.notifyStateChange();
			}
		});
		this.unsubscribers.push(unsubFindCount);

		const unsubFindState = this.adapter.on("updatefindcontrolstate", (evt: any) => {
			if (evt?.matchesCount) {
				const { current, total } = evt.matchesCount;
				this.state.activeIndex = Math.max(0, current - 1);
				this.notifyStateChange();
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
		this.notifyStateChange();

		if (this.adapter.executeNativeFind) {
			const handled = this.adapter.executeNativeFind({
				query,
				type: "",
				findPrevious: direction === "backward",
				highlightAll: this.state.highlightAllMatches,
			});
			if (handled) {
				this.state.isScanning = false;
				this.notifyStateChange();
				return;
			}
		}

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

		// Scroll to first match if found on visible pages
		if (this.state.matches.length > 0) {
			this.scrollToMatch(this.state.matches[this.state.activeIndex]);
		}

		// 2. Scan remaining pages in background batches
		for (const pageNum of remainingPages) {
			if (this.scanGeneration !== generation) return;
			await new Promise((resolve) => window.setTimeout(resolve, 0));
			if (this.scanGeneration !== generation) return;

			await this.scanPage(pageNum, query, generation);
			this.state.scannedPages++;
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
			fuzzy: this.settings.fuzzyMode,
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
			renderPageHighlights(pageEl, pageMatches, activeId, this.state.highlightAllMatches);
		}
	}

	refreshPageHighlights(pageNumber: number) {
		const pageEl = this.adapter.getPageElement(pageNumber);
		if (!pageEl) return;

		const pageMatches = this.state.matches.filter((m) => m.pageNumber === pageNumber);
		if (pageMatches.length === 0) {
			renderPageHighlights(pageEl, [], null, this.state.highlightAllMatches);
			return;
		}

		const textLayerEl = this.adapter.getTextLayerElement(pageNumber);
		const model = this.cache.get(pageNumber);
		const viewport = this.adapter.getPageViewport(pageNumber);

		if (model) {
			for (const match of pageMatches) {
				const { rects } = computeMatchGeometry(pageEl, textLayerEl, match.itemSpans, model, viewport);
				if (rects.length > 0) {
					match.rects = rects;
				}
			}
		}

		const activeId = this.getActiveMatch()?.id ?? null;
		renderPageHighlights(pageEl, pageMatches, activeId, this.state.highlightAllMatches);
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
		if (this.adapter.executeNativeFind && this.state.query) {
			const handled = this.adapter.executeNativeFind({
				query: this.state.query,
				type: "again",
				findPrevious: direction === "backward",
				highlightAll: this.state.highlightAllMatches,
			});
			if (handled) {
				this.state.direction = direction;
				return;
			}
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
		if (this.originPageNumber) {
			this.adapter.scrollPageIntoView(this.originPageNumber);
		}
		this.destroy();
	}

	destroy() {
		this.scanGeneration++;
		if (this.adapter.executeNativeFind) {
			this.adapter.executeNativeFind({
				query: "",
				type: "",
				highlightAll: false,
			});
		}
		clearAllPdfHighlights(this.adapter.containerEl);
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.cache.clear();
	}
}
