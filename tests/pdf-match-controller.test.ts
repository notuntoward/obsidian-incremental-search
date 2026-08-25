import { describe, it, expect, beforeEach, vi } from "vitest";
import { PdfMatchController } from "../src/pdf/pdf-match-controller";
import { PdfViewAdapter } from "../src/pdf/pdf-view-adapter";
import { DEFAULT_SETTINGS } from "../src/types";

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

		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
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
		const page2Overlay = pageElements.get(2)!.querySelector(".incsearch-pdf-overlay");
		expect(page2Overlay).not.toBeNull();
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
});
