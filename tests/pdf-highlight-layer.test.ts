import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	renderPageHighlights,
	clearPageHighlights,
	clearAllPdfHighlights,
	getOrCreatePageOverlay,
} from "../src/pdf/highlight-layer";
import { PdfMatch } from "../src/pdf/types";

describe("PDF Highlight Layer", () => {
	let pageEl: HTMLDivElement;

	beforeEach(() => {
		pageEl = document.createElement("div");
		pageEl.className = "page";
	});

	it("creates an overlay and renders highlight rects", () => {
		const matches: PdfMatch[] = [
			{
				id: "m1",
				pageNumber: 1,
				from: 0,
				to: 5,
				itemSpans: [{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
				rects: [{ left: 10, top: 20, width: 50, height: 15 }],
			},
			{
				id: "m2",
				pageNumber: 1,
				from: 10,
				to: 15,
				itemSpans: [{ itemIndex: 0, startOffset: 10, endOffset: 15 }],
				rects: [{ left: 70, top: 20, width: 50, height: 15 }],
			},
		];

		renderPageHighlights(pageEl, matches, "m1", true);

		const overlay = pageEl.querySelector(".incsearch-pdf-overlay");
		expect(overlay).not.toBeNull();

		const highlightDivs = overlay?.querySelectorAll(".incsearch-pdf-match");
		expect(highlightDivs).toHaveLength(2);

		// First highlight is active match -> has is-current class
		expect(highlightDivs?.[0].classList.contains("is-current")).toBe(true);
		expect(highlightDivs?.[1].classList.contains("is-current")).toBe(false);
	});

	it("renders only active match when highlightAll is false", () => {
		const matches: PdfMatch[] = [
			{
				id: "m1",
				pageNumber: 1,
				from: 0,
				to: 5,
				itemSpans: [{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
				rects: [{ left: 10, top: 20, width: 50, height: 15 }],
			},
			{
				id: "m2",
				pageNumber: 1,
				from: 10,
				to: 15,
				itemSpans: [{ itemIndex: 0, startOffset: 10, endOffset: 15 }],
				rects: [{ left: 70, top: 20, width: 50, height: 15 }],
			},
		];

		renderPageHighlights(pageEl, matches, "m2", false);

		const overlay = pageEl.querySelector(".incsearch-pdf-overlay");
		const highlightDivs = overlay?.querySelectorAll(".incsearch-pdf-match");
		expect(highlightDivs).toHaveLength(1);
		expect(highlightDivs?.[0].getAttribute("data-match-id")).toBe("m2");
	});

	it("clears highlights from page and container cleanly", () => {
		getOrCreatePageOverlay(pageEl);
		expect(pageEl.querySelector(".incsearch-pdf-overlay")).not.toBeNull();

		clearPageHighlights(pageEl);
		expect(pageEl.querySelector(".incsearch-pdf-overlay")).toBeNull();

		const container = document.createElement("div");
		const page1 = document.createElement("div");
		const page2 = document.createElement("div");
		container.appendChild(page1);
		container.appendChild(page2);

		getOrCreatePageOverlay(page1);
		getOrCreatePageOverlay(page2);
		expect(container.querySelectorAll(".incsearch-pdf-overlay")).toHaveLength(2);

		clearAllPdfHighlights(container);
		expect(container.querySelectorAll(".incsearch-pdf-overlay")).toHaveLength(0);
	});

	it("clears native current envelope state and selected fragments", () => {
		const container = document.createElement("div");
		const page = document.createElement("div");
		page.className = "page incsearch-pdf-native-envelope-active";
		const selected = document.createElement("span");
		selected.className = "highlight selected";
		const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		overlay.classList.add("incsearch-pdf-native-current-overlay");
		page.append(selected, overlay);
		container.appendChild(page);
		const deleteHighlight = vi.fn();
		Object.defineProperty(window, "CSS", {
			configurable: true,
			value: { highlights: { delete: deleteHighlight, set: vi.fn() } },
		});

		clearAllPdfHighlights(container);

		expect(container.querySelector(".incsearch-pdf-native-current-overlay")).toBeNull();
		expect(container.querySelector(".highlight.selected")).toBeNull();
		expect(page.classList.contains("incsearch-pdf-native-envelope-active")).toBe(false);
		expect(deleteHighlight).toHaveBeenCalledWith("incsearch-pdf-current-token");
	});
});
