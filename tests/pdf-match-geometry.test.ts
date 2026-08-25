import { describe, it, expect, beforeEach } from "vitest";
import { computeMatchGeometry } from "../src/pdf/match-geometry";
import { buildPageTextModel } from "../src/pdf/text-model";
import { PdfTextItem } from "../src/pdf/types";

describe("PDF Match Geometry", () => {
	let pageEl: HTMLDivElement;
	let textLayerEl: HTMLDivElement;

	beforeEach(() => {
		pageEl = document.createElement("div");
		pageEl.style.width = "600px";
		pageEl.style.height = "800px";
		pageEl.getBoundingClientRect = () => ({
			left: 100,
			top: 100,
			right: 700,
			bottom: 900,
			width: 600,
			height: 800,
			x: 100,
			y: 100,
			toJSON: () => {},
		});

		textLayerEl = document.createElement("div");
		pageEl.appendChild(textLayerEl);
	});

	it("computes exact DOM Range geometry when textLayer is fully rendered", () => {
		const span1 = document.createElement("span");
		span1.textContent = "Hello World";
		textLayerEl.appendChild(span1);

		// Mock Range.getClientRects() for jsdom
		const originalCreateRange = document.createRange;
		document.createRange = () => {
			const range = originalCreateRange.call(document);
			range.getClientRects = () =>
				[
					{
						left: 120,
						top: 150,
						right: 180,
						bottom: 170,
						width: 60,
						height: 20,
						x: 120,
						y: 150,
						toJSON: () => {},
					},
				] as any;
			return range;
		};

		const items: PdfTextItem[] = [{ str: "Hello World" }];
		const model = buildPageTextModel(1, items);

		const result = computeMatchGeometry(
			pageEl,
			textLayerEl,
			[{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
			model
		);

		expect(result.rects).toHaveLength(1);
		// Translated relative to pageEl (left: 120 - 100 = 20, top: 150 - 100 = 50)
		expect(result.rects[0]).toEqual({
			left: 20,
			top: 50,
			width: 60,
			height: 20,
		});

		document.createRange = originalCreateRange;
	});

	it("uses transform matrix convertToViewportPoint when textLayer is absent or incomplete", () => {
		const items: PdfTextItem[] = [
			{
				str: "Hello World",
				transform: [1, 0, 0, 1, 50, 100],
				width: 200,
				height: 14,
			},
			{
				str: "Second Item",
				transform: [1, 0, 0, 1, 50, 200],
				width: 200,
				height: 14,
			},
		];
		const model = buildPageTextModel(1, items);

		// Partial textLayer with only 1 child out of 2
		const span1 = document.createElement("span");
		span1.textContent = "Hello World";
		textLayerEl.appendChild(span1);

		const mockViewport = {
			convertToViewportPoint: (x: number, y: number) => [x * 1.5, 800 - y * 1.5],
			width: 600,
			height: 800,
		};

		const result = computeMatchGeometry(
			pageEl,
			textLayerEl, // incomplete text layer (1 child < 2 items)
			[{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
			model,
			mockViewport
		);

		expect(result.rects).toHaveLength(1);
		expect(result.rects[0].left).toBe(75); // 50 * 1.5
		expect(result.rects[0].width).toBeGreaterThan(0);
		expect(result.rects[0].height).toBeGreaterThan(0);
	});

	it("uses viewport.transform matrix when convertToViewportPoint is absent", () => {
		const items: PdfTextItem[] = [
			{
				str: "Better Reading",
				transform: [1, 0, 0, 1, 80, 300],
				width: 150,
				height: 12,
			},
		];
		const model = buildPageTextModel(1, items);

		const mockViewport = {
			transform: [1.2, 0, 0, -1.2, 0, 800],
			width: 600,
			height: 800,
		};

		const result = computeMatchGeometry(
			pageEl,
			null,
			[{ itemIndex: 0, startOffset: 0, endOffset: 6 }],
			model,
			mockViewport
		);

		expect(result.rects).toHaveLength(1);
		expect(result.rects[0].left).toBeCloseTo(80 * 1.2, 1);
		expect(result.rects[0].width).toBeGreaterThan(0);
	});
});
