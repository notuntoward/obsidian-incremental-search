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

	it("cleans up overlays and listeners on destroy", async () => {
		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		await controller.search("algorithm");

		expect(containerEl.querySelectorAll(".incsearch-pdf-overlay").length).toBeGreaterThan(0);

		controller.destroy();
		expect(containerEl.querySelectorAll(".incsearch-pdf-overlay").length).toBe(0);
	});
});
