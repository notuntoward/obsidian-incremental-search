import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	PdfMatchController,
	processPdfQuery,
	isMatchAtOrAfterTop,
	isMatchAtOrBeforeBottom,
	findInitialPdfActiveIndex,
	findPdfWildcardMatches,
	joinNativeSelectedHighlightFragments,
} from "../src/pdf/pdf-match-controller";
import { PdfViewAdapter } from "../src/pdf/pdf-view-adapter";
import { DEFAULT_SETTINGS } from "../src/types";
import { PdfMatch, PdfViewportAnchor } from "../src/pdf/types";

describe("processPdfQuery (Space-as-wildcard for PDF)", () => {
	it("treats single space as multi-token wildcard words (phraseSearch: false)", () => {
		const res = processPdfQuery("quick fox dog", true);
		expect(res.phraseSearch).toBe(false);
		expect(res.processedQuery).toBe("quick fox dog");
	});

	it("treats 2 spaces as exactly 1 literal space (phraseSearch: true)", () => {
		const res = processPdfQuery("the  KAN", true);
		expect(res.phraseSearch).toBe(true);
		expect(res.processedQuery).toBe("the KAN");
	});

	it("treats 3 spaces as exactly 2 literal spaces (phraseSearch: true)", () => {
		const res = processPdfQuery("the   KAN", true);
		expect(res.phraseSearch).toBe(true);
		expect(res.processedQuery).toBe("the  KAN");
	});

	it("always uses phraseSearch: true when spaceAsWildcard is disabled", () => {
		const res = processPdfQuery("quick fox dog", false);
		expect(res.phraseSearch).toBe(true);
		expect(res.processedQuery).toBe("quick fox dog");
	});
});

describe("findPdfWildcardMatches", () => {
	it("keeps wildcard token sequences within PDF.js line boundaries", () => {
		const pageContent = [
			"PEDro criteria apply across intervention modalities.",
			"interventions, for which PEDro is widely accepted.",
			"instrument across all intervention types was preferred.",
			"exercise modality and intensity were analyzed.",
		].join("\n");

		const matches = findPdfWildcardMatches(pageContent, "intervention modalit", false);

		expect(matches).toHaveLength(1);
		expect(pageContent.slice(matches[0].from, matches[0].to)).toBe(
			"intervention modalit"
		);
	});

	it("skips distant first tokens after PDF.js removes visual line boundaries", () => {
		const pageContent = [
			"contributors to heterogeneity, particularly caloric restriction",
			"populations. To address this, primary analyses were conducted",
			"x".repeat(300),
			"compensatory behaviors to better understand long-term relevance",
		].join(" ");

		const matches = findPdfWildcardMatches(pageContent, "to better", false);

		expect(matches).toHaveLength(1);
		const matchedText = pageContent.slice(matches[0].from, matches[0].to);
		expect(matchedText).toBe("to better");
	});
});

describe("joinNativeSelectedHighlightFragments", () => {
	it("joins touching same-line fragments but preserves real line breaks", () => {
		const container = document.createElement("div");
		container.innerHTML = `<div class="textLayer">
			<span id="a" class="highlight begin selected"></span>
			<span id="b" class="highlight middle selected"></span>
			<span id="c" class="highlight end selected"></span>
		</div>`;
		const a = container.querySelector<HTMLElement>("#a")!;
		const b = container.querySelector<HTMLElement>("#b")!;
		const c = container.querySelector<HTMLElement>("#c")!;
		a.getBoundingClientRect = () => ({
			left: 10, right: 50, top: 10, bottom: 30, width: 40, height: 20,
		} as DOMRect);
		b.getBoundingClientRect = () => ({
			left: 60, right: 100, top: 10, bottom: 30, width: 40, height: 20,
		} as DOMRect);
		c.getBoundingClientRect = () => ({
			left: 10, right: 60, top: 35, bottom: 55, width: 50, height: 20,
		} as DOMRect);

		joinNativeSelectedHighlightFragments(container);

		expect(a.classList.contains("incsearch-join-next")).toBe(true);
		expect(b.classList.contains("incsearch-join-prev")).toBe(true);
		expect(b.classList.contains("incsearch-join-next")).toBe(false);
		expect(c.classList.contains("incsearch-join-prev")).toBe(false);
	});
});

describe("PDF Match Controller (Native Find & Built-in Geometry)", () => {
	let nativeAdapter: PdfViewAdapter;
	let containerEl: HTMLDivElement;
	let nativeFindCommands: any[];

	beforeEach(() => {
		containerEl = document.createElement("div");
		nativeFindCommands = [];

		nativeAdapter = {
			numPages: 5,
			containerEl,
			getPage: async () => null,
			getPageElement: () => null,
			getTextLayerElement: () => null,
			getPageViewport: () => ({ width: 600, height: 800 }),
			getVisiblePageNumbers: () => [1],
			on: (_event: string, _handler: any) => () => {},
			scrollToRect: vi.fn(),
			scrollPageIntoView: vi.fn(),
			executeNativeFind: (cmd: any) => {
				nativeFindCommands.push(cmd);
				return true;
			},
		};
	});

	it("delegates literal search to native find and applies CSS class in on-demand mode", async () => {
		const controller = new PdfMatchController(nativeAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "on-demand",
			spaceAsWildcard: true,
		});

		await controller.search("algorithm");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0].query).toBe("algorithm");
		expect(nativeFindCommands[0].phraseSearch).toBe(true);
		expect(nativeFindCommands[0].highlightAll).toBe(false);

		// Container has CSS class to hide non-selected native highlights until peeked
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(true);

		// Press Ctrl+Enter -> toggleDemandHighlights
		controller.toggleDemandHighlights();
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(false);
		expect(nativeFindCommands[1].highlightAll).toBe(true);

		// Press Ctrl+Enter again -> hide other matches
		controller.toggleDemandHighlights();
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(true);
	});

	it("feeds markdown wildcard ranges to native PDF find and keeps native navigation", async () => {
		const text = "Third, despite the advantages. Third, despite an issue.";
		const originalMatch = vi.fn((_query: any, _pageContent: string, _pageIndex: number) => [
			{ index: 99, length: 1 },
		]);
		const findController = { match: originalMatch };
		const adapter: PdfViewAdapter = {
			...nativeAdapter,
			findController,
		};
		const controller = new PdfMatchController(adapter, {
			...DEFAULT_SETTINGS,
			spaceAsWildcard: true,
			allMatchesDisplayMode: "always",
		});

		await controller.search("third, despite a");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0]).toMatchObject({
			query: "third, despite a",
			phraseSearch: false,
			highlightAll: true,
		});
		expect(findController.match("third, despite a", text, 0)).toEqual([
			{ index: 0, length: 20 },
			{ index: text.lastIndexOf("Third"), length: 16 },
		]);

		controller.advance("forward");
		expect(nativeFindCommands[1]).toMatchObject({
			type: "again",
			query: "third, despite a",
			findPrevious: false,
		});

		controller.destroy();
		expect(findController.match).toBe(originalMatch);
	});

	it("delegates double-space literal phrase to native find with phraseSearch: true", async () => {
		const controller = new PdfMatchController(nativeAdapter, {
			...DEFAULT_SETTINGS,
			spaceAsWildcard: true,
		});

		await controller.search("the  KAN");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0].query).toBe("the KAN");
		expect(nativeFindCommands[0].phraseSearch).toBe(true);
		expect(nativeFindCommands[0].caseSensitive).toBe(true); // smart case on uppercase KAN
	});

	it("delegates advance forward and backward with type: again", async () => {
		const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);

		await controller.search("algorithm");
		controller.advance("forward");

		expect(nativeFindCommands).toHaveLength(2);
		expect(nativeFindCommands[1].type).toBe("again");
		expect(nativeFindCommands[1].findPrevious).toBe(false);

		controller.advance("backward");
		expect(nativeFindCommands).toHaveLength(3);
		expect(nativeFindCommands[2].type).toBe("again");
		expect(nativeFindCommands[2].findPrevious).toBe(true);
	});

	it("cleans up CSS class and clears native find on destroy", async () => {
		const controller = new PdfMatchController(nativeAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "on-demand",
		});

		await controller.search("test");
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(true);
		expect(containerEl.classList.contains("incsearch-active-pdf")).toBe(true);

		controller.destroy();
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(false);
		expect(containerEl.classList.contains("incsearch-active-pdf")).toBe(false);
		expect(nativeFindCommands[nativeFindCommands.length - 1]).toEqual({
			query: "",
			type: "",
			highlightAll: false,
		});
	});

	it("delegates to executeNativeFind when available with highlightAll: true", async () => {
		// Add page element to container
		const pageEl = document.createElement("div");
		pageEl.className = "page";
		pageEl.setAttribute("data-page-number", "1");
		const textLayer = document.createElement("div");
		textLayer.className = "textLayer";
		pageEl.appendChild(textLayer);
		containerEl.appendChild(pageEl);

		const adapterWithPage: PdfViewAdapter = {
			...nativeAdapter,
			numPages: 1,
			getPageElement: () => pageEl,
			getTextLayerElement: () => textLayer,
		};

		const controller = new PdfMatchController(adapterWithPage, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "always",
		});
		await controller.search("MetS");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0].query).toBe("MetS");
		expect(nativeFindCommands[0].highlightAll).toBe(true);

		controller.destroy();
	});
});

describe("PDF Match Controller", () => {
	let mockAdapter: PdfViewAdapter;
	let containerEl: HTMLDivElement;
	let pageElements: Map<number, HTMLDivElement>;

	beforeEach(() => {
		containerEl = document.createElement("div");
		pageElements = new Map();

		for (let p = 1; p <= 3; p++) {
			const pageDiv = document.createElement("div");
			pageDiv.className = "page";
			pageDiv.setAttribute("data-page-number", String(p));
			const textLayer = document.createElement("div");
			textLayer.className = "textLayer";
			pageDiv.appendChild(textLayer);
			containerEl.appendChild(pageDiv);
			pageElements.set(p, pageDiv);
		}

		mockAdapter = {
			numPages: 3,
			containerEl,
			getPage: async (pageNumber: number) => {
				const sampleTexts: Record<number, string> = {
					1: "Introduction to algorithm design and analysis",
					2: "Chapter 1: Sorting algorithm fundamentals",
					3: "Chapter 2: Graph algorithm applications",
				};
				return {
					pageNumber,
					getTextContent: async () => ({
						items: [{ str: sampleTexts[pageNumber] || "" }],
					}),
					getViewport: () => ({ width: 600, height: 800 }),
				};
			},
			getPageElement: (pageNumber: number) => pageElements.get(pageNumber) || null,
			getTextLayerElement: (pageNumber: number) => {
				const page = pageElements.get(pageNumber);
				return page?.querySelector(".textLayer") as HTMLElement | null;
			},
			getPageViewport: () => ({ width: 600, height: 800 }),
			getVisiblePageNumbers: () => [1], // Page 1 visible initially
			on: (_event: string, _handler: any) => () => {},
			scrollToRect: vi.fn(),
			scrollPageIntoView: vi.fn(),
		};
	});

	it("performs progressive scanning: scans visible page 1 first, then background pages", async () => {
		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

		await controller.search("algorithm");

		// "algorithm" appears on all 3 pages
		expect(controller.state.matches).toHaveLength(3);
		expect(controller.state.matches[0].pageNumber).toBe(1);
		expect(controller.state.matches[1].pageNumber).toBe(2);
		expect(controller.state.matches[2].pageNumber).toBe(3);
		expect(controller.state.activeIndex).toBe(0);
	});

	it("advances forward and backward with wrap-around", async () => {
		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		await controller.search("algorithm");

		expect(controller.state.activeIndex).toBe(0);

		// Advance forward
		controller.advance("forward");
		expect(controller.state.activeIndex).toBe(1);

		controller.advance("forward");
		expect(controller.state.activeIndex).toBe(2);

		// Wrap around to 0
		controller.advance("forward");
		expect(controller.state.activeIndex).toBe(0);

		// Advance backward from 0 -> wraps to last (2)
		controller.advance("backward");
		expect(controller.state.activeIndex).toBe(2);
		expect(mockAdapter.scrollToRect).toHaveBeenCalledWith(3, expect.anything());
	});

	it("cancels previous in-flight scans when query updates rapidly", async () => {
		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

		const search1 = controller.search("algorithm");
		const search2 = controller.search("graph");

		await Promise.all([search1, search2]);

		// Only the last search results ("graph", on page 3) should be active
		expect(controller.state.query).toBe("graph");
		expect(controller.state.matches).toHaveLength(1);
		expect(controller.state.matches[0].pageNumber).toBe(3);
	});

	it("orders matches on a page in top-to-bottom visual order when items are scrambled in stream order", async () => {
		// Scrambled items in raw stream: Body text first (y=300), Watermark second (y=600), Title third (y=750)
		mockAdapter.getPage = async (pageNumber: number) => {
			if (pageNumber === 1) {
				return {
					pageNumber: 1,
					getTextContent: async () => ({
						items: [
							{ str: "Body paragraph mentioning keyword", transform: [1, 0, 0, 1, 50, 300], width: 200, height: 12 },
							{ str: "Watermark keyword logo", transform: [1, 0, 0, 1, 50, 600], width: 150, height: 24 },
							{ str: "Header keyword title", transform: [1, 0, 0, 1, 50, 750], width: 100, height: 14 },
						],
					}),
					getViewport: () => ({ width: 600, height: 800 }),
				};
			}
			return null;
		};

		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		await controller.search("keyword");

		expect(controller.state.matches).toHaveLength(3);
		// Visual order: Header (y=750) -> Watermark (y=600) -> Body (y=300)
		expect(controller.state.matches[0].itemSpans[0].itemIndex).toBe(0); // Top Header
		expect(controller.state.matches[1].itemSpans[0].itemIndex).toBe(1); // Watermark
		expect(controller.state.matches[2].itemSpans[0].itemIndex).toBe(2); // Body

		// Forward advances in top-to-bottom visual order
		expect(controller.state.activeIndex).toBe(0);
		controller.advance("forward");
		expect(controller.state.activeIndex).toBe(1);
		controller.advance("forward");
		expect(controller.state.activeIndex).toBe(2);
	});

	it("handles off-screen pages with unrendered text layers and refreshes when textlayerrendered fires", async () => {
		const listeners = new Map<string, ((...args: any[]) => void)[]>();
		mockAdapter.on = (event: string, handler: any) => {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event)!.push(handler);
			return () => {};
		};

		// Page 2 has unrendered textLayer initially (0 children in textLayer)
		const page2TextLayer = pageElements.get(2)!.querySelector(".textLayer") as HTMLElement;
		page2TextLayer.innerHTML = "";

		mockAdapter.getPageViewport = (pageNum: number) => ({
			convertToViewportPoint: (x: number, y: number) => [x * 1.2, 800 - y * 1.2],
			transform: [1.2, 0, 0, -1.2, 0, 800],
			width: 600,
			height: 800,
		});

		const controller = new PdfMatchController(mockAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "always",
		});
		await controller.search("algorithm");

		// Page 2 match initially computed via fallback transform matrix
		const page2Match = controller.state.matches.find((m) => m.pageNumber === 2);
		expect(page2Match).toBeDefined();
		expect(page2Match?.rects).toBeDefined();
		expect(page2Match?.rects![0].width).toBeGreaterThan(0);

		// Now simulate PDF.js rendering the text layer for Page 2
		const span = document.createElement("span");
		span.textContent = "Chapter 1: Sorting algorithm fundamentals";
		page2TextLayer.appendChild(span);

		// Fire textlayerrendered event
		const textLayerRenderedHandlers = listeners.get("textlayerrendered") || [];
		for (const h of textLayerRenderedHandlers) {
			h({ pageNumber: 2 });
		}

		// Highlights should now be refreshed for Page 2
		const page2Highlight = pageElements.get(2)!.querySelector(".incsearch-pdf-match");
		expect(page2Highlight).not.toBeNull();
	});

	it("deduplicates identical text items at the same coordinates so forward search never requires double-stepping", async () => {
		mockAdapter.getPage = async (pageNumber: number) => {
			if (pageNumber === 1) {
				return {
					pageNumber: 1,
					getTextContent: async () => ({
						items: [
							{ str: "First section item", transform: [1, 0, 0, 1, 50, 700], width: 100, height: 14 },
							// Exact duplicate of Myndex Research at (50, 500)
							{ str: "Myndex Research", transform: [1, 0, 0, 1, 50, 500], width: 120, height: 14 },
							{ str: "Myndex Research", transform: [1, 0, 0, 1, 50, 500], width: 120, height: 14 },
							{ str: "Last footer item", transform: [1, 0, 0, 1, 50, 200], width: 100, height: 14 },
						],
					}),
					getViewport: () => ({ width: 600, height: 800 }),
				};
			}
			return null;
		};

		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		await controller.search("Myndex");

		// Must deduplicate to exactly 1 match (not 2)
		expect(controller.state.matches).toHaveLength(1);
		expect(controller.state.activeIndex).toBe(0);

		// Advancing forward wraps to 0 directly without getting stuck on duplicate
		controller.advance("forward");
		expect(controller.state.activeIndex).toBe(0);
	});

	it("cleans up overlays and listeners on destroy", async () => {
		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		await controller.search("algorithm");

		expect(containerEl.querySelectorAll(".incsearch-pdf-overlay").length).toBeGreaterThan(0);

		controller.destroy();
		expect(containerEl.querySelectorAll(".incsearch-pdf-overlay").length).toBe(0);
	});

	it("restores origin page on cancel() and preserves current page on accept()", async () => {
		let scrolledPage: number | null = null;
		mockAdapter.scrollPageIntoView = (pageNumber: number) => {
			scrolledPage = pageNumber;
		};
		mockAdapter.getVisiblePageNumbers = () => [1];

		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		expect(controller.originPageNumber).toBe(1);

		// Advance to page 2 match
		await controller.search("algorithm");
		controller.advance("forward");

		// Cancel should scroll back to origin page 1
		controller.cancel();
		expect(scrolledPage).toBe(1);
	});

	it("respects allMatchesDisplayMode and toggles demand highlights in PDF controller", async () => {
		const controller = new PdfMatchController(mockAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "on-demand",
		});

		expect(controller.shouldShowAllMatches()).toBe(false);

		controller.toggleDemandHighlights();
		expect(controller.shouldShowAllMatches()).toBe(true);

		controller.toggleDemandHighlights();
		expect(controller.shouldShowAllMatches()).toBe(false);
	});

	it("renders only current match in on-demand mode and toggles DOM highlights on demand", async () => {
		mockAdapter.getVisiblePageNumbers = () => [1, 2, 3];
		mockAdapter.getPageViewport = () => ({
			convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
			transform: [1, 0, 0, -1, 0, 800],
			width: 600,
			height: 800,
		});

		const controller = new PdfMatchController(mockAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "on-demand",
		});

		await controller.search("algorithm");
		expect(controller.state.matches).toHaveLength(3);

		// Page 1 has the active match (activeIndex = 0)
		const page1 = pageElements.get(1)!;
		const page2 = pageElements.get(2)!;

		// On-demand mode before toggle: only page 1 (active) has 1 highlight with is-current; page 2 has 0
		const p1HighlightsInitial = page1.querySelectorAll(".incsearch-pdf-match");
		const p2HighlightsInitial = page2.querySelectorAll(".incsearch-pdf-match");
		expect(p1HighlightsInitial.length).toBe(1);
		expect(p1HighlightsInitial[0].classList.contains("is-current")).toBe(true);
		expect(p2HighlightsInitial.length).toBe(0);

		// Toggle on demand (Ctrl+Enter)
		controller.toggleDemandHighlights();

		const p1HighlightsPeek = page1.querySelectorAll(".incsearch-pdf-match");
		const p2HighlightsPeek = page2.querySelectorAll(".incsearch-pdf-match");
		expect(p1HighlightsPeek.length).toBe(1);
		expect(p2HighlightsPeek.length).toBe(1);

		// Toggle off again
		controller.toggleDemandHighlights();
		const p2HighlightsOff = page2.querySelectorAll(".incsearch-pdf-match");
		expect(p2HighlightsOff.length).toBe(0);
	});

	describe("Viewport-Relative Starting Position & Geometry", () => {
		const dummyMatch = (id: string, pageNumber: number, top: number, height = 16): PdfMatch => ({
			id,
			pageNumber,
			from: 0,
			to: 5,
			itemSpans: [{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
			rects: [{ left: 50, top, width: 100, height }],
		});

		it("evaluates isMatchAtOrAfterTop correctly across pages and pixel offsets", () => {
			const anchor: PdfViewportAnchor = {
				topPageNumber: 2,
				topPageY: 300,
				topPageX: 0,
				bottomPageNumber: 2,
				bottomPageY: 800,
				bottomPageX: 600,
			};

			// Page 1 is before top visible page
			expect(isMatchAtOrAfterTop(dummyMatch("m1", 1, 500), anchor)).toBe(false);

			// Page 2, match at y=200 (scrolled above topPageY=300)
			expect(isMatchAtOrAfterTop(dummyMatch("m2", 2, 200, 16), anchor)).toBe(false);

			// Page 2, match at y=350 (at/below topPageY=300)
			expect(isMatchAtOrAfterTop(dummyMatch("m3", 2, 350, 16), anchor)).toBe(true);

			// Page 3 is after top visible page
			expect(isMatchAtOrAfterTop(dummyMatch("m4", 3, 50), anchor)).toBe(true);
		});

		it("evaluates isMatchAtOrBeforeBottom correctly across pages and pixel offsets", () => {
			const anchor: PdfViewportAnchor = {
				topPageNumber: 2,
				topPageY: 300,
				topPageX: 0,
				bottomPageNumber: 2,
				bottomPageY: 700,
				bottomPageX: 600,
			};

			// Page 1 is before bottom visible page
			expect(isMatchAtOrBeforeBottom(dummyMatch("m1", 1, 500), anchor)).toBe(true);

			// Page 2, match at y=650 (at/above bottomPageY=700)
			expect(isMatchAtOrBeforeBottom(dummyMatch("m2", 2, 650, 16), anchor)).toBe(true);

			// Page 2, match at y=750 (scrolled below bottomPageY=700)
			expect(isMatchAtOrBeforeBottom(dummyMatch("m3", 2, 750, 16), anchor)).toBe(false);

			// Page 3 is after bottom visible page
			expect(isMatchAtOrBeforeBottom(dummyMatch("m4", 3, 50), anchor)).toBe(false);
		});

		it("findInitialPdfActiveIndex selects first visible match for forward search and wraps if needed", () => {
			const anchor: PdfViewportAnchor = {
				topPageNumber: 2,
				topPageY: 400,
				topPageX: 0,
				bottomPageNumber: 2,
				bottomPageY: 800,
				bottomPageX: 600,
			};

			const matches: PdfMatch[] = [
				dummyMatch("m1", 1, 100), // Page 1
				dummyMatch("m2", 2, 200), // Page 2 above viewport
				dummyMatch("m3", 2, 450), // Page 2 inside viewport (first visible match!)
				dummyMatch("m4", 2, 600), // Page 2 inside viewport
				dummyMatch("m5", 3, 100), // Page 3
			];

			// Forward search starts at top of visible content (index 2: m3)
			const forwardIdx = findInitialPdfActiveIndex(matches, "forward", anchor);
			expect(forwardIdx).toBe(2);
			expect(matches[forwardIdx].id).toBe("m3");

			// Backward search starts at bottom of visible content (index 3: m4)
			const backwardIdx = findInitialPdfActiveIndex(matches, "backward", anchor);
			expect(backwardIdx).toBe(3);
			expect(matches[backwardIdx].id).toBe("m4");

			// Wrap-around forward: when all matches are above top of viewport
			const aboveOnly: PdfMatch[] = [dummyMatch("m1", 1, 100), dummyMatch("m2", 2, 200)];
			expect(findInitialPdfActiveIndex(aboveOnly, "forward", anchor)).toBe(0);

			// Wrap-around backward: when all matches are below bottom of viewport
			const belowOnly: PdfMatch[] = [dummyMatch("m5", 3, 100), dummyMatch("m6", 3, 500)];
			expect(findInitialPdfActiveIndex(belowOnly, "backward", anchor)).toBe(1); // last match
		});

		it("starts forward search at top of visible PDF content when scrolled down", async () => {
			// Page 2 is visible, scrolled such that topPageY is 400
			mockAdapter.getVisiblePageNumbers = () => [2];
			mockAdapter.getViewportAnchor = () => ({
				topPageNumber: 2,
				topPageY: 400,
				topPageX: 0,
				bottomPageNumber: 2,
				bottomPageY: 800,
				bottomPageX: 600,
			});

			mockAdapter.getPage = async (pageNumber: number) => {
				if (pageNumber === 1) {
					return {
						pageNumber: 1,
						getTextContent: async () => ({
							items: [{ str: "keyword on page 1", transform: [1, 0, 0, 1, 50, 700], width: 100, height: 14 }],
						}),
						getViewport: () => ({ width: 600, height: 800 }),
					};
				}
				if (pageNumber === 2) {
					return {
						pageNumber: 2,
						getTextContent: async () => ({
							items: [
								// Inverted transform coordinates: y=700 in PDF is near top (rect.top ~ 100)
								{ str: "keyword scrolled off top", transform: [1, 0, 0, 1, 50, 700], width: 100, height: 14 },
								// y=350 in PDF is near middle (rect.top ~ 450)
								{ str: "keyword visible at top of viewport", transform: [1, 0, 0, 1, 50, 350], width: 100, height: 14 },
								// y=200 in PDF is lower (rect.top ~ 600)
								{ str: "keyword visible lower down", transform: [1, 0, 0, 1, 50, 200], width: 100, height: 14 },
							],
						}),
						getViewport: () => ({ width: 600, height: 800 }),
					};
				}
				return null;
			};

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS, "forward");
			await controller.search("keyword");

			// Should have matches on Page 2 and Page 1
			expect(controller.state.matches.length).toBeGreaterThanOrEqual(3);

			// Active match should be the first one visible on Page 2 at or below topPageY=400 (not page 1, not scrolled off top)
			const activeMatch = controller.getActiveMatch();
			expect(activeMatch).not.toBeNull();
			expect(activeMatch?.pageNumber).toBe(2);
			expect(activeMatch?.rects![0].top).toBeGreaterThanOrEqual(390); // ~436px
		});

		it("starts reverse search at bottom of visible PDF content when scrolled down", async () => {
			mockAdapter.getVisiblePageNumbers = () => [2];
			mockAdapter.getViewportAnchor = () => ({
				topPageNumber: 2,
				topPageY: 200,
				topPageX: 0,
				bottomPageNumber: 2,
				bottomPageY: 500, // viewport bottom cuts off at y=500
				bottomPageX: 600,
			});

			mockAdapter.getPage = async (pageNumber: number) => {
				if (pageNumber === 2) {
					return {
						pageNumber: 2,
						getTextContent: async () => ({
							items: [
								// rect.top ~ 100 (y=700 in PDF)
								{ str: "item at top", transform: [1, 0, 0, 1, 50, 700], width: 100, height: 14 },
								// rect.top ~ 450 (y=350 in PDF) - inside viewport (<= 500)
								{ str: "item at bottom of view", transform: [1, 0, 0, 1, 50, 350], width: 100, height: 14 },
								// rect.top ~ 700 (y=100 in PDF) - below viewport (> 500)
								{ str: "item cut off below", transform: [1, 0, 0, 1, 50, 100], width: 100, height: 14 },
							],
						}),
						getViewport: () => ({ width: 600, height: 800 }),
					};
				}
				return null;
			};

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS, "backward");
			await controller.search("item", "backward");

			const activeMatch = controller.getActiveMatch();
			expect(activeMatch).not.toBeNull();
			expect(activeMatch?.pageNumber).toBe(2);
			// Should select the last match at or above bottomPageY=500 ("item at bottom of view", rect.top ~ 436)
			expect(activeMatch?.rects![0].top).toBeLessThanOrEqual(500);
			expect(activeMatch?.rects![0].top).toBeGreaterThan(200);
		});

		it("restores original scroll position on cancel", async () => {
			const restoreFn = vi.fn();
			mockAdapter.restoreScrollPosition = restoreFn;
			mockAdapter.getScrollPosition = () => ({
				scrollTop: 450,
				scrollLeft: 20,
				pageNumber: 2,
			});

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
			await controller.search("algorithm");

			controller.cancel();
			expect(restoreFn).toHaveBeenCalledWith({
				scrollTop: 450,
				scrollLeft: 20,
				pageNumber: 2,
			});
		});
	});
});

