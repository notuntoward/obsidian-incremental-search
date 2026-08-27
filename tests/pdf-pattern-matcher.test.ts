import { describe, it, expect } from "vitest";
import { findPageMatches } from "../src/pdf/pattern-matcher";
import { buildPageTextModel } from "../src/pdf/text-model";
import { PdfTextItem } from "../src/pdf/types";

describe("PDF Pattern Matcher", () => {
	it("finds literal matches with smart-case sensitivity", () => {
		const items: PdfTextItem[] = [{ str: "Apple apple APPLE", dir: "ltr" }];
		const model = buildPageTextModel(1, items);

		// Lowercase query -> case-insensitive
		const lowerMatches = findPageMatches(model, "apple", { spaceAsWildcard: false });
		expect(lowerMatches).toHaveLength(3);

		// Uppercase query -> case-sensitive
		const upperMatches = findPageMatches(model, "Apple", { spaceAsWildcard: false });
		expect(upperMatches).toHaveLength(1);
		expect(upperMatches[0].start).toBe(0);
		expect(upperMatches[0].end).toBe(5);
	});

	it("finds word-sequence wildcard matches with wildcard gaps", () => {
		const items: PdfTextItem[] = [
			{ str: "The quick brown fox jumps over the lazy dog", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		// Query "quick fox dog"
		const matches = findPageMatches(model, "quick fox dog", { spaceAsWildcard: true });
		expect(matches).toHaveLength(1);
		expect(matches[0].start).toBe(4); // "quick"
		expect(matches[0].end).toBe(43); // "dog"
		expect(matches[0].chars).toHaveLength(3);
	});

	it("matches three-token PDF wildcards without promoting standalone tokens", () => {
		const items: PdfTextItem[] = [
			{ str: "Third, despite the advantages. Despite another result.", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		const matches = findPageMatches(model, "third, despite a", {
			spaceAsWildcard: true,
		});

		expect(matches).toHaveLength(1);
		expect(model.normalizedText.slice(matches[0].start, matches[0].end)).toBe(
			"Third, despite the a"
		);
		expect(matches[0].chars?.map((range) =>
			model.normalizedText.slice(range.from, range.to)
		)).toEqual(["Third,", "despite", "a"]);
	});

	it("respects maxGapChars limit for wildcard matches", () => {
		const items: PdfTextItem[] = [
			{ str: "alpha 12345 beta 1234567890 gamma", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		// Gap between beta and gamma is 10 chars
		const allowedMatches = findPageMatches(model, "alpha beta gamma", {
			spaceAsWildcard: true,
			maxGapChars: 15,
		});
		expect(allowedMatches).toHaveLength(1);

		const rejectedMatches = findPageMatches(model, "alpha beta gamma", {
			spaceAsWildcard: true,
			maxGapChars: 8,
		});
		expect(rejectedMatches).toHaveLength(0);
	});

	it("finds regex matches safely", () => {
		const items: PdfTextItem[] = [
			{ str: "Order #12345 placed on 2026-08-25, Order #67890", dir: "ltr" },
		];
		const model = buildPageTextModel(1, items);

		const matches = findPageMatches(model, "/Order #\\d+/", { spaceAsWildcard: false });
		expect(matches).toHaveLength(2);
		expect(model.normalizedText.slice(matches[0].start, matches[0].end)).toBe("Order #12345");
		expect(model.normalizedText.slice(matches[1].start, matches[1].end)).toBe("Order #67890");
	});

	it("handles whole-word matching option", () => {
		const items: PdfTextItem[] = [{ str: "cat concatenate catalog cat", dir: "ltr" }];
		const model = buildPageTextModel(1, items);

		const allMatches = findPageMatches(model, "cat", { spaceAsWildcard: false, wholeWord: false });
		expect(allMatches).toHaveLength(4);

		const wordMatches = findPageMatches(model, "cat", { spaceAsWildcard: false, wholeWord: true });
		expect(wordMatches).toHaveLength(2);
		expect(wordMatches[0].start).toBe(0);
		expect(wordMatches[1].start).toBe(24);
	});
});
