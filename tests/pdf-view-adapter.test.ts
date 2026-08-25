import { describe, it, expect, beforeEach } from "vitest";
import { isPdfView, createPdfViewAdapter } from "../src/pdf/pdf-view-adapter";

describe("PDF View Adapter", () => {
	beforeEach(() => {
		delete (window as any).pdfPlus;
	});

	it("identifies PDF view by getViewType or internal viewer properties", () => {
		expect(isPdfView(null)).toBe(false);
		expect(isPdfView({})).toBe(false);
		expect(isPdfView({ getViewType: () => "markdown" })).toBe(false);
		expect(isPdfView({ getViewType: () => "pdf" })).toBe(true);
		expect(isPdfView({ viewer: {} })).toBe(true);
		expect(isPdfView({ pdfViewer: {} })).toBe(true);
	});

	it("creates adapter from native Obsidian PDF view structure", async () => {
		const mockDoc = {
			numPages: 3,
			getPage: async (pageNumber: number) => ({
				pageNumber,
				getTextContent: async () => ({
					items: [{ str: `Page ${pageNumber} content` }],
				}),
				getViewport: () => ({ width: 600, height: 800 }),
			}),
		};

		const containerEl = document.createElement("div");
		const page1El = document.createElement("div");
		page1El.className = "page";
		page1El.setAttribute("data-page-number", "1");
		containerEl.appendChild(page1El);

		const mockView = {
			getViewType: () => "pdf",
			contentEl: containerEl,
			viewer: {
				child: {
					pdfViewer: {
						pdfViewer: {
							pdfDocument: mockDoc,
							pagesCount: 3,
						},
					},
				},
			},
		};

		const adapter = createPdfViewAdapter(mockView);
		expect(adapter).not.toBeNull();
		expect(adapter?.numPages).toBe(3);

		const page1 = await adapter?.getPage(1);
		expect(page1).not.toBeNull();
		const text = await page1?.getTextContent();
		expect(text?.items[0].str).toBe("Page 1 content");

		expect(adapter?.getPageElement(1)).toBe(page1El);
	});

	it("detects PDF++ plugin API when available", async () => {
		const mockDoc = {
			numPages: 5,
			getPage: async (num: number) => ({
				pageNumber: num,
				getTextContent: async () => ({ items: [] }),
				getViewport: () => ({}),
			}),
		};

		(window as any).pdfPlus = {
			lib: {
				getPDFDocument: () => mockDoc,
				getPDFViewer: () => ({ pagesCount: 5 }),
			},
		};

		const mockView = {
			getViewType: () => "pdf",
			containerEl: document.createElement("div"),
		};

		const adapter = createPdfViewAdapter(mockView);
		expect(adapter).not.toBeNull();
		expect(adapter?.numPages).toBe(5);
	});

	it("returns null gracefully when viewer is uninitialized", () => {
		const uninitializedView = {
			getViewType: () => "pdf",
			viewer: { child: null },
		};

		const adapter = createPdfViewAdapter(uninitializedView);
		expect(adapter).toBeNull();
	});
});
