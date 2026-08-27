import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	parseColor,
	getRelativeLuminance,
	getContrastRatio,
	resolveOutlineColor,
	applyPdfColors,
	clearPdfColors,
} from "../src/utils/colors";
import {
	computePdfSecondaryStyle,
	parseCssColor,
} from "../src/utils/adaptive-highlight";

describe("colors utility", () => {
	it("calculates relative luminance correctly", () => {
		expect(getRelativeLuminance([0, 0, 0])).toBeCloseTo(0, 4);
		expect(getRelativeLuminance([255, 255, 255])).toBeCloseTo(1, 4);
		expect(getRelativeLuminance([255, 0, 0])).toBeCloseTo(0.2126, 4);
	});

	it("calculates contrast ratio correctly", () => {
		const whiteLum = getRelativeLuminance([255, 255, 255]);
		const blackLum = getRelativeLuminance([0, 0, 0]);
		expect(getContrastRatio(whiteLum, blackLum)).toBeCloseTo(21, 2);
		expect(getContrastRatio(whiteLum, whiteLum)).toBeCloseTo(1, 2);
	});

	it("parses color strings into RGB tuples", () => {
		expect(parseColor("#ffffff")).toEqual([255, 255, 255]);
		expect(parseColor("#000000")).toEqual([0, 0, 0]);
		expect(parseColor("rgb(100, 150, 200)")).toEqual([100, 150, 200]);
		expect(parseColor("transparent")).toBeNull();
	});

	it("resolves outline color with contrast awareness", () => {
		expect(resolveOutlineColor()).toBeDefined();
	});
});

describe("PDF colors against a white page", () => {
	beforeEach(() => {
		document.body.className = "theme-dark";
		document.body.style.setProperty("--interactive-accent", "rgb(185, 165, 255)");
		document.body.style.setProperty("--background-primary", "#1e1e1e");
		document.body.style.setProperty("--text-normal", "#dcddde");
	});

	afterEach(() => {
		document.body.className = "";
		document.body.style.removeProperty("--interactive-accent");
		document.body.style.removeProperty("--background-primary");
		document.body.style.removeProperty("--text-normal");
		document.documentElement.style.removeProperty("--incsearch-pdf-secondary-fill");
	});

	it("reuses outline contrast logic against white instead of the dark theme background", () => {
		const markdownOutline = resolveOutlineColor();
		const pdfOutline = resolveOutlineColor("#ffffff", "#2e3338");
		expect(markdownOutline).toBe("rgb(185, 165, 255)");
		expect(pdfOutline).not.toBe(markdownOutline);
		expect(pdfOutline).toBe("#2e3338");
	});

	it("uses the light-theme pipeline when the PDF looks light", () => {
		const style = computePdfSecondaryStyle(
			parseCssColor("#ffffff"),
			parseCssColor("#2e3338")
		);
		expect(style.mode).toBe("light");
		expect(style.fillCss).not.toBe("rgba(185, 165, 255, 0.38)");
	});

	it("uses the dark-theme pipeline when the PDF looks dark", () => {
		const style = computePdfSecondaryStyle(
			parseCssColor("#000000"),
			parseCssColor("#dcddde")
		);
		expect(style.mode).toBe("dark");
		expect(style.fillCss).not.toBe("rgba(185, 165, 255, 0.38)");
	});

	it("applies and clears the white-page colors on the PDF container", () => {
		const el = document.createElement("div");
		const expected = computePdfSecondaryStyle(
			parseCssColor("#ffffff"),
			parseCssColor("#2e3338")
		);

		applyPdfColors(el);

		expect(el.style.getPropertyValue("--incsearch-secondary-fill")).toBe(expected.fillCss);
		expect(el.style.getPropertyValue("--incsearch-secondary-edge")).toBe(expected.edgeCss);
		expect(el.style.getPropertyValue("--incsearch-current-outline-resolved")).toBe(
			resolveOutlineColor("#ffffff", "rgb(46, 51, 56)")
		);
		expect(document.documentElement.style.getPropertyValue("--incsearch-pdf-secondary-fill")).toBe(
			expected.fillCss
		);

		clearPdfColors(el);

		expect(el.style.getPropertyValue("--incsearch-secondary-fill")).toBe("");
		expect(document.documentElement.style.getPropertyValue("--incsearch-pdf-secondary-fill")).toBe(
			""
		);
	});

	it("uses the detected PDF background instead of assuming white", () => {
		const lightEl = document.createElement("div");
		lightEl.innerHTML = `<div class="pdfViewer"><div class="page" style="background-color: rgb(255, 255, 255);"></div></div>`;
		const darkEl = document.createElement("div");
		darkEl.innerHTML = `<div class="pdfViewer"><div class="page" style="background-color: rgb(0, 0, 0);"></div></div>`;

		applyPdfColors(lightEl);
		applyPdfColors(darkEl);

		const lightFill = lightEl.style.getPropertyValue("--incsearch-secondary-fill");
		const darkFill = darkEl.style.getPropertyValue("--incsearch-secondary-fill");
		expect(lightFill).not.toBe("");
		expect(darkFill).not.toBe("");
		expect(darkFill).not.toBe(lightFill);

		const darkOutline = darkEl.style.getPropertyValue("--incsearch-current-outline-resolved");
		expect(darkOutline).not.toBe("#2e3338");
	});

	it("defaults to white when the PDF has no explicit page styling", () => {
		const el = document.createElement("div");
		el.style.backgroundColor = "rgb(30, 30, 30)";
		el.innerHTML = `<div class="pdfViewer"><div class="page"></div></div>`;

		applyPdfColors(el);

		const outline = el.style.getPropertyValue("--incsearch-current-outline-resolved");
		expect(outline).toBe(
			resolveOutlineColor("#ffffff", "rgb(46, 51, 56)")
		);
	});

	it("treats a canvas-rendered PDF as light even when the container has a dark background", () => {
		// Regression: canvas paints its own white bitmap, so a dark theme background
		// on the container/page wrapper must not be mistaken for the PDF's page color.
		const el = document.createElement("div");
		el.style.backgroundColor = "rgb(30, 30, 30)";
		el.innerHTML = `<div class="pdfViewer"><div class="page"><canvas></canvas></div></div>`;

		applyPdfColors(el);

		const outline = el.style.getPropertyValue("--incsearch-current-outline-resolved");
		expect(outline).toBe(resolveOutlineColor("#ffffff", "rgb(46, 51, 56)"));
	});

	it("treats a canvas-rendered PDF as dark when an invert filter is applied to it or an ancestor", () => {
		// Regression: themes that render PDFs dark (e.g. Minimal's PDF dark mode) do
		// so via a CSS invert filter on the canvas/page, not a background-color change.
		const el = document.createElement("div");
		el.innerHTML = `<div class="pdfViewer"><div class="page" style="filter: invert(1) hue-rotate(180deg);"><canvas></canvas></div></div>`;

		applyPdfColors(el);

		const outline = el.style.getPropertyValue("--incsearch-current-outline-resolved");
		expect(outline).toBe(resolveOutlineColor("rgb(0, 0, 0)", "rgb(220, 221, 222)"));
		expect(outline).not.toBe(resolveOutlineColor("#ffffff", "rgb(46, 51, 56)"));
	});

	it("ignores a light invert amount that does not represent a dark-mode inversion", () => {
		const el = document.createElement("div");
		el.innerHTML = `<div class="pdfViewer"><div class="page" style="filter: invert(0.1);"><canvas></canvas></div></div>`;

		applyPdfColors(el);

		const outline = el.style.getPropertyValue("--incsearch-current-outline-resolved");
		expect(outline).toBe(resolveOutlineColor("#ffffff", "rgb(46, 51, 56)"));
	});
});
