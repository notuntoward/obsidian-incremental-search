import { describe, it, expect } from "vitest";
import { buildPageTextModel, mapNormalizedRangeToItemSpans } from "../src/pdf/text-model";
import { PdfTextItem } from "../src/pdf/types";

describe("PDF Text Model & Normalization", () => {
	it("normalizes standard ligatures to separate characters while preserving mapping", () => {
		// "ﬁrst ﬂow eﬀect oﬃce aﬄuent"
		const items: PdfTextItem[] = [
			{ str: "\uFB01rst \uFB02ow e\uFB00ect o\uFB03ce a\uFB04uent", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		expect(model.normalizedText).toBe("first flow effect office affluent");

		// Search for "first" (indices 0..5 in normalized text)
		const spans = mapNormalizedRangeToItemSpans(model, 0, 5);
		expect(spans).toHaveLength(1);
		expect(spans[0].itemIndex).toBe(0);
		expect(spans[0].startOffset).toBe(0);
		// In the original string, "ﬁrst" is 4 chars (ﬁ, r, s, t)
		expect(spans[0].endOffset).toBe(4);
	});

	it("normalizes historical ligatures ﬅ and ﬆ", () => {
		const items: PdfTextItem[] = [{ str: "fa\uFB05 fa\uFB06", dir: "ltr" }];
		const model = buildPageTextModel(1, items);
		expect(model.normalizedText).toBe("fast fast");
	});

	it("normalizes smart quotes and dash variants", () => {
		const items: PdfTextItem[] = [
			{ str: "‘hello’ “world” em—dash en–dash minus−dash", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		expect(model.normalizedText).toBe("'hello' \"world\" em-dash en-dash minus-dash");
	});

	it("normalizes Unicode spaces to standard ASCII spaces", () => {
		const items: PdfTextItem[] = [
			{ str: "word1\u00A0word2\u2003word3\u3000word4", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		expect(model.normalizedText).toBe("word1 word2 word3 word4");
	});

	it("omits soft hyphens and zero-width spaces while preserving subsequent char offsets", () => {
		// "hy-phen" with soft-hyphen \u00AD inside "hyphen"
		const items: PdfTextItem[] = [
			{ str: "hy\u00ADphen and ze\u200Bro", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		expect(model.normalizedText).toBe("hyphen and zero");

		// "phen" in normalized string is at index 2..6
		const spans = mapNormalizedRangeToItemSpans(model, 2, 6);
		expect(spans).toHaveLength(1);
		expect(spans[0].itemIndex).toBe(0);
		// In original string "hy\u00ADphen": 'p' is at index 3, 'n' is at index 6 -> endOffset 7
		expect(spans[0].startOffset).toBe(3);
		expect(spans[0].endOffset).toBe(7);
	});

	it("inserts synthetic space between separate text items that do not have whitespace", () => {
		const items: PdfTextItem[] = [
			{ str: "Hello", hasEOL: false },
			{ str: "World", hasEOL: false },
		];
		const model = buildPageTextModel(1, items);

		expect(model.normalizedText).toBe("Hello World");
		expect(model.charMapping[5]).toBeNull(); // synthetic space

		// Match across "Hello World" (0..11)
		const spans = mapNormalizedRangeToItemSpans(model, 0, 11);
		expect(spans).toHaveLength(2);
		expect(spans[0]).toEqual({ itemIndex: 0, startOffset: 0, endOffset: 5 });
		expect(spans[1]).toEqual({ itemIndex: 1, startOffset: 0, endOffset: 5 });
	});

	it("handles EOL line breaks cleanly", () => {
		const items: PdfTextItem[] = [
			{ str: "First line", hasEOL: true },
			{ str: "Second line", hasEOL: true },
		];
		const model = buildPageTextModel(1, items);

		expect(model.normalizedText).toBe("First line Second line ");
	});

	it("sorts items into visual reading order top-to-bottom and left-to-right", () => {
		// Out-of-order items: Body text at y=400, Header at y=750, Title at y=600, Footer at y=50
		const rawItems: PdfTextItem[] = [
			{ str: "Body paragraph", transform: [1, 0, 0, 1, 50, 400], height: 12, width: 100 },
			{ str: "Title banner", transform: [1, 0, 0, 1, 50, 600], height: 24, width: 150 },
			{ str: "Top header", transform: [1, 0, 0, 1, 50, 750], height: 10, width: 80 },
			{ str: "Bottom footer", transform: [1, 0, 0, 1, 50, 50], height: 10, width: 80 },
		];

		const model = buildPageTextModel(1, rawItems);

		// Visual order should be: Top header (y=750) -> Title banner (y=600) -> Body paragraph (y=400) -> Bottom footer (y=50)
		expect(model.items[0].str).toBe("Top header");
		expect(model.items[0].domIndex).toBe(2);

		expect(model.items[1].str).toBe("Title banner");
		expect(model.items[1].domIndex).toBe(1);

		expect(model.items[2].str).toBe("Body paragraph");
		expect(model.items[2].domIndex).toBe(0);

		expect(model.items[3].str).toBe("Bottom footer");
		expect(model.items[3].domIndex).toBe(3);

		expect(model.normalizedText).toBe("Top header Title banner Body paragraph Bottom footer");
	});

	it("skips empty string items and correctly assigns domIndex 1:1 with non-empty DOM spans", () => {
		const rawItems: PdfTextItem[] = [
			{ str: "First span", transform: [1, 0, 0, 1, 50, 700] },
			{ str: "", transform: [1, 0, 0, 1, 50, 650] }, // Empty item, PDF.js creates no DOM span
			{ str: "", transform: [1, 0, 0, 1, 50, 600] }, // Empty item
			{ str: "Second span", transform: [1, 0, 0, 1, 50, 500] },
			{ str: "", transform: [1, 0, 0, 1, 50, 450] }, // Empty item
			{ str: "Third span", transform: [1, 0, 0, 1, 50, 400] },
		];

		const model = buildPageTextModel(1, rawItems);
		expect(model.items).toHaveLength(3);

		expect(model.items[0].str).toBe("First span");
		expect(model.items[0].domIndex).toBe(0);

		expect(model.items[1].str).toBe("Second span");
		expect(model.items[1].domIndex).toBe(1); // Maps to DOM span 1, NOT raw index 3

		expect(model.items[2].str).toBe("Third span");
		expect(model.items[2].domIndex).toBe(2); // Maps to DOM span 2, NOT raw index 5
	});

	it("deduplicates identical text items at the same position (drop shadows, double strikes)", () => {
		const rawItems: PdfTextItem[] = [
			{ str: "Title Header", transform: [1, 0, 0, 1, 50, 700], width: 100, height: 14 },
			// Exact duplicate of Title Header at (50, 700)
			{ str: "Title Header", transform: [1, 0, 0, 1, 50.1, 700.1], width: 100, height: 14 },
			{ str: "Body paragraph", transform: [1, 0, 0, 1, 50, 500], width: 200, height: 12 },
			// Exact duplicate of Body paragraph at (50, 500)
			{ str: "Body paragraph", transform: [1, 0, 0, 1, 50, 500], width: 200, height: 12 },
		];

		const model = buildPageTextModel(1, rawItems);
		expect(model.items).toHaveLength(2);
		expect(model.items[0].str).toBe("Title Header");
		expect(model.items[1].str).toBe("Body paragraph");
		expect(model.normalizedText).toBe("Title Header Body paragraph");
	});
});
