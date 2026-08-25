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

	it("computes exact DOM Range geometry when textLayer is rendered", () => {
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

		expect(result.isFallback).toBe(false);
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

	it("falls back to PDF transform matrix projection when textLayer is absent", () => {
		const items: PdfTextItem[] = [
			{
				str: "Hello World",
				transform: [1, 0, 0, 1, 50, 100],
				width: 200,
				height: 14,
			},
		];
		const model = buildPageTextModel(1, items);

		const mockViewport = {
			convertToViewportRectangle: (pdfRect: number[]) => [
				pdfRect[0] * 1.5,
				pdfRect[1] * 1.5,
				pdfRect[2] * 1.5,
				pdfRect[3] * 1.5,
			],
			width: 600,
			height: 800,
		};

		const result = computeMatchGeometry(
			pageEl,
			null, // no textLayer
			[{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
			model,
			mockViewport
		);

		expect(result.isFallback).toBe(true);
		expect(result.rects).toHaveLength(1);
		expect(result.rects[0].width).toBeGreaterThan(0);
		expect(result.rects[0].height).toBeGreaterThan(0);
	});
});
