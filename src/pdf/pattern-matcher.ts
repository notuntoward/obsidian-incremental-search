import { findMatchesInText, isWholeWord, isWithinMaxGap } from "../engine";
import { PageTextModel, NormalizedMatch, PdfSearchOptions } from "./types";

export { isWholeWord, isWithinMaxGap };

/**
 * Searches a single PageTextModel for matches matching the given query and options.
 */
export function findPageMatches(
	pageModel: PageTextModel,
	query: string,
	options: PdfSearchOptions
): NormalizedMatch[] {
	if (!query || query.length === 0) return [];
	const text = pageModel.normalizedText;
	if (!text || text.length === 0) return [];

	const matches = findMatchesInText(text, query, options, 0);

	return matches.map((m) => ({
		pageNumber: pageModel.pageNumber,
		from: m.from,
		to: m.to,
		start: m.from,
		end: m.to,
		chars: m.chars,
	}));
}
