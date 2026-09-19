import { describe, it, expect, vi } from "vitest";
import { clearAllPdfHighlights } from "../src/pdf/highlight-layer";

describe("PDF Highlight Layer", () => {
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
