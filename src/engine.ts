import { EditorState } from "@codemirror/state";
import { MatchRange } from "./types";

/**
 * Determines case sensitivity using smart-case:
 * If the query contains any uppercase letters, matching is case-sensitive.
 * Otherwise, matching is case-insensitive.
 */
export function isCaseSensitive(query: string): boolean {
	return /[A-Z]/.test(query);
}

/**
 * Parses a fuzzy query string into literal string tokens according to
 * Emacs space-as-wildcard rules:
 * - 1 space: Wildcard separator (unbounded gap between tokens)
 * - 2 spaces: Exactly 1 literal space required
 * - 3 spaces: Exactly 2 literal spaces required
 * - N spaces: Exactly N - 1 literal spaces required
 */
export function parseFuzzyQuery(query: string, caseSensitive: boolean): string[] {
	if (query.length === 0) return [];

	const tokens: string[] = [];
	const parts = query.split(/( +)/);
	let currentToken = "";

	for (const part of parts) {
		if (part.startsWith(" ")) {
			if (part.length === 1) {
				if (currentToken.length > 0) {
					tokens.push(caseSensitive ? currentToken : currentToken.toLowerCase());
					currentToken = "";
				}
			} else {
				currentToken += " ".repeat(part.length - 1);
			}
		} else if (part.length > 0) {
			currentToken += part;
		}
	}

	if (currentToken.length > 0) {
		tokens.push(caseSensitive ? currentToken : currentToken.toLowerCase());
	}

	return tokens;
}

/**
 * Finds all fuzzy matches in a single line of text.
 * Sequential tokens are searched in order with wildcards in between.
 */
export function findFuzzyMatches(
	text: string,
	query: string,
	offset: number,
	caseSensitive: boolean
): MatchRange[] {
	if (query.length === 0) return [];
	const haystack = caseSensitive ? text : text.toLowerCase();
	const tokens = parseFuzzyQuery(query, caseSensitive);

	if (tokens.length === 0) return [];
	const results: MatchRange[] = [];

	let searchStart = 0;
	while (searchStart < haystack.length) {
		let currentStart = searchStart;
		const chars: { from: number; to: number }[] = [];
		let matchValid = true;
		let firstTokenIdx = -1;
		let lastTokenEnd = -1;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.length === 0) continue;

			const idx = haystack.indexOf(token, currentStart);
			if (idx === -1) {
				matchValid = false;
				break;
			}

			if (firstTokenIdx === -1) {
				firstTokenIdx = idx;
			}

			chars.push({ from: offset + idx, to: offset + idx + token.length });
			currentStart = idx + token.length;
			lastTokenEnd = currentStart;
		}

		if (matchValid && firstTokenIdx !== -1) {
			results.push({
				from: offset + firstTokenIdx,
				to: offset + lastTokenEnd,
				chars,
			});
			searchStart = firstTokenIdx + 1;
		} else {
			break;
		}
	}

	return results;
}

/**
 * Finds all literal substring matches in a single line of text.
 */
export function findLiteralMatches(
	text: string,
	query: string,
	offset: number,
	caseSensitive: boolean
): MatchRange[] {
	const results: MatchRange[] = [];
	const haystack = caseSensitive ? text : text.toLowerCase();
	const needle = caseSensitive ? query : query.toLowerCase();
	if (needle.length === 0) return results;

	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		results.push({ from: offset + idx, to: offset + idx + needle.length });
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return results;
}

/**
 * Computes all matches across all lines of an EditorState document.
 */
export function computeMatches(state: EditorState, query: string, fuzzy: boolean): MatchRange[] {
	if (!query) return [];
	const caseSensitive = isCaseSensitive(query);
	const results: MatchRange[] = [];

	const doc = state.doc;
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		if (fuzzy) {
			results.push(...findFuzzyMatches(line.text, query, line.from, caseSensitive));
		} else {
			results.push(...findLiteralMatches(line.text, query, line.from, caseSensitive));
		}
	}
	return results;
}
