import {
	isCaseSensitive,
	parseWildcardQuery,
	findWildcardMatches,
	findLiteralMatches,
} from "../engine";
import { PageTextModel, NormalizedMatch, PdfSearchOptions } from "./types";

/**
 * Checks if a match range aligns with whole-word boundaries.
 */
function isWholeWord(text: string, start: number, end: number): boolean {
	const prevChar = start > 0 ? text[start - 1] : " ";
	const nextChar = end < text.length ? text[end] : " ";
	const wordCharRegex = /\w/;
	return !wordCharRegex.test(prevChar) && !wordCharRegex.test(nextChar);
}

/**
 * Checks if gaps between wildcard tokens in a match exceed maxGapChars.
 */
function isWithinMaxGap(
	chars: { from: number; to: number }[] | undefined,
	maxGapChars?: number
): boolean {
	if (!chars || chars.length <= 1 || maxGapChars === undefined || maxGapChars <= 0) {
		return true;
	}
	for (let i = 0; i < chars.length - 1; i++) {
		const gap = chars[i + 1].from - chars[i].to;
		if (gap > maxGapChars) {
			return false;
		}
	}
	return true;
}

/**
 * Executes regular-expression matching on normalized text with safety guards.
 */
export function findRegexMatches(
	text: string,
	pattern: string,
	flags: string,
	offset = 0
): { from: number; to: number }[] {
	const results: { from: number; to: number }[] = [];
	try {
		const safeFlags = flags.includes("g") ? flags : flags + "g";
		const regex = new RegExp(pattern, safeFlags);
		let match: RegExpExecArray | null = null;
		let count = 0;
		const maxMatches = 5000;

		while ((match = regex.exec(text)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			results.push({
				from: offset + match.index,
				to: offset + match.index + match[0].length,
			});
			count++;
			if (count >= maxMatches) break;
		}
	} catch {
		// Invalid regex pattern
		return [];
	}
	return results;
}

/**
 * Searches a single PageTextModel for matches matching the given query and options.
 */
export function findPageMatches(
	pageModel: PageTextModel,
	query: string,
	options: PdfSearchOptions
): NormalizedMatch[] {
	if (!query || query.length === 0) {
		return [];
	}

	const text = pageModel.normalizedText;
	if (text.length === 0) {
		return [];
	}

	const caseSensitive = options.caseSensitive ?? isCaseSensitive(query);
	const results: NormalizedMatch[] = [];

	// Check if query is formatted as a regular expression /regex/flags
	const regexMatch = query.match(/^\/(.+)\/([a-z]*)$/);
	if (options.regexMode || regexMatch) {
		const pattern = regexMatch ? regexMatch[1] : query;
		const flags = regexMatch ? regexMatch[2] : caseSensitive ? "" : "i";
		const rawMatches = findRegexMatches(text, pattern, flags, 0);

		for (const m of rawMatches) {
			if (options.wholeWord && !isWholeWord(text, m.from, m.to)) {
				continue;
			}
			results.push({
				pageNumber: pageModel.pageNumber,
				start: m.from,
				end: m.to,
			});
		}
		return results;
	}

	const useWildcard = options.spaceAsWildcard ?? options.wildcard ?? options.fuzzy ?? true;

	if (useWildcard) {
		const rawMatches = findWildcardMatches(text, query, 0, caseSensitive);
		for (const m of rawMatches) {
			if (options.wholeWord && !isWholeWord(text, m.from, m.to)) {
				continue;
			}
			if (!isWithinMaxGap(m.chars, options.maxGapChars)) {
				continue;
			}
			results.push({
				pageNumber: pageModel.pageNumber,
				start: m.from,
				end: m.to,
				chars: m.chars,
			});
		}
	} else {
		const rawMatches = findLiteralMatches(text, query, 0, caseSensitive);
		for (const m of rawMatches) {
			if (options.wholeWord && !isWholeWord(text, m.from, m.to)) {
				continue;
			}
			results.push({
				pageNumber: pageModel.pageNumber,
				start: m.from,
				end: m.to,
			});
		}
	}

	return results;
}
