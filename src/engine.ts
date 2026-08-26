import { EditorState } from "@codemirror/state";
import { CachedMetadata, ReferenceCache } from "obsidian";
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
 * Parses a wildcard query string into literal string tokens according to
 * Emacs space-as-wildcard rules:
 * - 1 space: Wildcard separator (unbounded gap between tokens)
 * - 2 spaces: Exactly 1 literal space required
 * - 3 spaces: Exactly 2 literal spaces required
 * - N spaces: Exactly N - 1 literal spaces required
 */
export function parseWildcardQuery(query: string, caseSensitive: boolean): string[] {
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

export const parseFuzzyQuery = parseWildcardQuery;

/**
 * This function delegates link-syntax and frontmatter parsing to Obsidian's MetadataCache.
 * Frontmatter is always non-visible metadata and is always excluded.
 * Link destinations/URLs are excluded when filterHiddenLinks is true.
 */
function getHiddenRangesFromCache(cache: CachedMetadata, filterHiddenLinks: boolean): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];

	// 1. Frontmatter Position / YAML sections (Always hidden)
	if (cache.frontmatterPosition) {
		ranges.push({
			from: cache.frontmatterPosition.start.offset,
			to: cache.frontmatterPosition.end.offset,
		});
	}
	if (cache.frontmatter && (cache.frontmatter as any).position) {
		const pos = (cache.frontmatter as any).position;
		if (!ranges.some((r) => r.from === pos.start.offset && r.to === pos.end.offset)) {
			ranges.push({ from: pos.start.offset, to: pos.end.offset });
		}
	}
	if (cache.sections) {
		for (const sec of cache.sections) {
			if (sec.type === "yaml") {
				const from = sec.position.start.offset;
				const to = sec.position.end.offset;
				if (!ranges.some((r) => r.from === from && r.to === to)) {
					ranges.push({ from, to });
				}
			}
		}
	}

	// 2. Hidden Links / Destinations (Filtered when filterHiddenLinks is true)
	if (filterHiddenLinks) {
		const allLinks: ReferenceCache[] = [
			...(cache.links || []),
			...(cache.embeds || []),
		];
		for (const link of allLinks) {
			const start = link.position.start.offset;
			const end = link.position.end.offset;
			const original = link.original;
			const displayText = link.displayText;

			if (!displayText || displayText === original) continue;

			if (original.startsWith("![[") || original.startsWith("[[")) {
				const lastPipeIndex = original.lastIndexOf("|");
				if (lastPipeIndex !== -1 && lastPipeIndex > 0) {
					ranges.push({ from: start, to: start + lastPipeIndex + 1 });
					if (original.endsWith("]]")) {
						ranges.push({ from: end - 2, to: end });
					}
				}
			} else if (original.startsWith("[")) {
				const aliasEndIndex = original.indexOf("](");
				if (aliasEndIndex !== -1) {
					ranges.push({ from: start, to: start + 1 });
					ranges.push({ from: start + aliasEndIndex, to: end });
				} else {
					const refEndIndex = original.indexOf("][");
					if (refEndIndex !== -1) {
						ranges.push({ from: start, to: start + 1 });
						ranges.push({ from: start + refEndIndex, to: end });
					}
				}
			}
		}
	}

	return ranges;
}

function isMatchHidden(m: MatchRange, hiddenRanges: { from: number; to: number }[]): boolean {
	const checkOverlap = (start: number, end: number) => {
		for (const hr of hiddenRanges) {
			if (start < hr.to && end > hr.from) return true;
		}
		return false;
	};

	if (m.chars && m.chars.length > 0) {
		for (const c of m.chars) {
			if (checkOverlap(c.from, c.to)) return true;
		}
		return false;
	}

	return checkOverlap(m.from, m.to);
}

/**
 * Finds all space-as-wildcard matches in a single line of text.
 * Sequential tokens are searched in order with wildcards in between.
 */
export function findWildcardMatches(
	text: string,
	query: string,
	offset: number,
	caseSensitive: boolean
): MatchRange[] {
	if (query.length === 0) return [];
	const haystack = caseSensitive ? text : text.toLowerCase();
	const tokens = parseWildcardQuery(query, caseSensitive);

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

export const findFuzzyMatches = findWildcardMatches;

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

function findCellBoundaries(lineText: string, matchStart: number, matchEnd: number) {
	let cellStart = 0;
	let colIndex = 0;
	for (let i = 0; i <= matchStart; i++) {
		if (lineText[i] === '|' && (i === 0 || lineText[i - 1] !== '\\')) {
			cellStart = i + 1;
			colIndex++;
		}
	}
	const normalizedColIndex = Math.max(0, colIndex - 1);

	let cellEnd = lineText.length;
	for (let i = matchEnd; i < lineText.length; i++) {
		if (lineText[i] === '|' && (i === 0 || lineText[i - 1] !== '\\')) {
			cellEnd = i;
			break;
		}
	}
	return {
		cellText: lineText.substring(cellStart, cellEnd),
		cellStartOffset: cellStart,
		colIndex: normalizedColIndex,
	};
}

/**
 * Computes all matches across all lines of an EditorState document.
 */
export function computeMatches(
	state: EditorState,
	query: string,
	spaceAsWildcard: boolean,
	matchOnlyVisibleLinks: boolean,
	linkCache?: CachedMetadata
): MatchRange[] {
	if (!query) return [];
	const caseSensitive = isCaseSensitive(query);
	const results: MatchRange[] = [];

	const hiddenRanges = linkCache 
		? getHiddenRangesFromCache(linkCache, matchOnlyVisibleLinks) 
		: [];

	const tableRanges: { from: number; to: number }[] = [];
	if (linkCache && (linkCache as any).sections) {
		for (const sec of (linkCache as any).sections) {
			if (sec.type === "table") {
				tableRanges.push({ from: sec.position.start.offset, to: sec.position.end.offset });
			}
		}
	}

	const doc = state.doc;
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		let lineMatches: MatchRange[] = [];
		if (spaceAsWildcard) {
			lineMatches = findWildcardMatches(line.text, query, line.from, caseSensitive);
		} else {
			lineMatches = findLiteralMatches(line.text, query, line.from, caseSensitive);
		}

		if (lineMatches.length > 0 && hiddenRanges.length > 0) {
			lineMatches = lineMatches.filter((m) => !isMatchHidden(m, hiddenRanges));
		}

		if (lineMatches.length > 0 && tableRanges.length > 0) {
			for (const m of lineMatches) {
				const tableRange = tableRanges.find((r) => m.from < r.to && m.to > r.from);
				if (tableRange) {
					m.inTable = true;
					const { cellText, cellStartOffset, colIndex } = findCellBoundaries(line.text, m.from - line.from, m.to - line.from);
					const tableStartLine = doc.lineAt(tableRange.from).number;
					const lineOffsetInTable = line.number - tableStartLine;
					const rowIndex = lineOffsetInTable === 0 ? 0 : Math.max(0, lineOffsetInTable - 1);
					m.tableMatchData = {
						sectionStart: tableRange.from,
						cellText,
						matchStartInCell: m.from - line.from - cellStartOffset,
						matchEndInCell: m.to - line.from - cellStartOffset,
						rowIndex,
						colIndex,
					};
				}
			}
		}

		results.push(...lineMatches);
	}
	return results;
}
