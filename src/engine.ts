import { EditorState } from "@codemirror/state";
import { CachedMetadata, ReferenceCache } from "obsidian";
import { MatchRange, SearchQueryOptions, CompiledQuery } from "./types";

/**
 * Determines case sensitivity using smart-case:
 * If the query contains any uppercase letters, matching is case-sensitive.
 * Otherwise, matching is case-insensitive.
 */
export function isCaseSensitive(query: string): boolean {
	return /[A-Z]/.test(query);
}

/**
 * Splits a query into unquoted and quoted segments.
 * Inside quotes:
 * - \" is an escaped literal quote.
 * - Any other backslash is a literal backslash.
 * - All spaces are literal.
 * - Unterminated quotes at end-of-input are treated permissively as in-progress literal tokens.
 */
interface QueryChunk {
	type: "quoted" | "unquoted";
	text: string;
}

export function splitIntoChunks(query: string): QueryChunk[] {
	const chunks: QueryChunk[] = [];
	let i = 0;
	let currentUnquoted = "";

	while (i < query.length) {
		if (query[i] === '"') {
			if (currentUnquoted.length > 0) {
				chunks.push({ type: "unquoted", text: currentUnquoted });
				currentUnquoted = "";
			}
			// Scan quoted segment
			i++; // skip opening quote
			let quotedContent = "";
			while (i < query.length) {
				if (query[i] === "\\" && i + 1 < query.length && query[i + 1] === '"') {
					quotedContent += '"';
					i += 2;
				} else if (query[i] === '"') {
					i++; // skip closing quote
					break;
				} else {
					quotedContent += query[i];
					i++;
				}
			}
			chunks.push({ type: "quoted", text: quotedContent });
		} else {
			currentUnquoted += query[i];
			i++;
		}
	}

	if (currentUnquoted.length > 0) {
		chunks.push({ type: "unquoted", text: currentUnquoted });
	}

	return chunks;
}

/**
 * Parses a query string into literal string tokens according to
 * Emacs space-as-wildcard rules and composable double-quoted literal segments:
 * - Double-quoted segments ("...") are matched literally with all internal spaces preserved.
 * - Outside quotes:
 *   - 1 space: Wildcard separator (unbounded gap between tokens)
 *   - 2 spaces: Exactly 1 literal space required
 *   - 3 spaces: Exactly 2 literal spaces required
 *   - N spaces: Exactly N - 1 literal spaces required
 */
export function parseWildcardQuery(query: string, caseSensitive: boolean): string[] {
	if (query.length === 0) return [];

	const chunks = splitIntoChunks(query);
	const tokens: string[] = [];
	let currentToken = "";

	for (const chunk of chunks) {
		if (chunk.type === "quoted") {
			currentToken += chunk.text;
		} else {
			const parts = chunk.text.split(/( +)/);
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
		}
	}

	if (currentToken.length > 0) {
		tokens.push(caseSensitive ? currentToken : currentToken.toLowerCase());
	}

	return tokens;
}

export const parseFuzzyQuery = parseWildcardQuery;

/**
 * Checks if a match range aligns with whole-word boundaries in a text string.
 */
export function isWholeWord(text: string, start: number, end: number): boolean {
	const prevChar = start > 0 ? text[start - 1] : " ";
	const nextChar = end < text.length ? text[end] : " ";
	const wordCharRegex = /\w/;
	return !wordCharRegex.test(prevChar) && !wordCharRegex.test(nextChar);
}

/**
 * Checks if gaps between wildcard tokens in a match exceed maxGapChars.
 */
export function isWithinMaxGap(
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
 * Compiles a raw query string and options into an optimized CompiledQuery object.
 */
export function compileQuery(
	query: string,
	options: SearchQueryOptions = {}
): CompiledQuery | null {
	if (!query || query.length === 0) return null;

	const caseSensitive = options.caseSensitive ?? isCaseSensitive(query);
	const wholeWord = Boolean(options.wholeWord);
	const maxGapChars = options.maxGapChars;

	const useWildcard = options.spaceAsWildcard ?? options.wildcard ?? options.fuzzy ?? true;
	if (useWildcard) {
		const tokens = parseWildcardQuery(query, caseSensitive);
		if (tokens.length === 0) return null;
		return {
			rawQuery: query,
			type: "wildcard",
			caseSensitive,
			wholeWord,
			maxGapChars,
			tokens,
		};
	}

	return {
		rawQuery: query,
		type: "literal",
		caseSensitive,
		wholeWord,
		maxGapChars,
		needle: caseSensitive ? query : query.toLowerCase(),
	};
}

/**
 * Finds all space-as-wildcard matches in a string.
 * Sequential tokens are searched in order; earlier tokens are tightened (non-greedy)
 * to minimize gaps, and the search advances past the match to prevent overlapping duplicates.
 */
export function findWildcardMatches(
	text: string,
	queryOrTokens: string | string[],
	offset = 0,
	caseSensitive = false
): MatchRange[] {
	if (!text || text.length === 0) return [];
	const haystack = caseSensitive ? text : text.toLowerCase();
	const tokens = Array.isArray(queryOrTokens)
		? queryOrTokens
		: parseWildcardQuery(queryOrTokens, caseSensitive);

	if (tokens.length === 0) return [];
	const results: MatchRange[] = [];

	let searchStart = 0;
	while (searchStart < haystack.length) {
		// 1. Forward pass: find the earliest occurrence of all tokens in sequence
		let currentStart = searchStart;
		const tokenPositions: number[] = [];
		let matchFound = true;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.length === 0) continue;

			const idx = haystack.indexOf(token, currentStart);
			if (idx === -1) {
				matchFound = false;
				break;
			}
			tokenPositions.push(idx);
			currentStart = idx + token.length;
		}

		if (!matchFound || tokenPositions.length === 0) {
			break;
		}

		// 2. Backward tightening pass: minimize gaps by finding the latest occurrence of each earlier token
		// that still occurs before the subsequent token (non-greedy / shortest match)
		for (let i = tokenPositions.length - 2; i >= 0; i--) {
			const token = tokens[i];
			const nextTokenPos = tokenPositions[i + 1];
			const prevTokenEnd = i > 0 ? tokenPositions[i - 1] + tokens[i - 1].length : searchStart;
			const latestIdx = haystack.lastIndexOf(token, nextTokenPos - token.length);
			if (latestIdx !== -1 && latestIdx >= prevTokenEnd) {
				tokenPositions[i] = latestIdx;
			}
		}

		const firstTokenIdx = tokenPositions[0];
		const lastTokenIdx = tokenPositions[tokenPositions.length - 1];
		const lastTokenEnd = lastTokenIdx + tokens[tokens.length - 1].length;

		const chars: { from: number; to: number }[] = tokenPositions.map((pos, idx) => ({
			from: offset + pos,
			to: offset + pos + tokens[idx].length,
		}));

		results.push({
			from: offset + firstTokenIdx,
			to: offset + lastTokenEnd,
			chars,
		});

		// Advance past the last matched token to avoid overlapping/duplicate matches
		searchStart = lastTokenEnd;
	}

	return results;
}

export const findFuzzyMatches = findWildcardMatches;

/**
 * Finds all literal substring matches in a string.
 */
export function findLiteralMatches(
	text: string,
	query: string,
	offset = 0,
	caseSensitive = false
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
 * Unified matching engine: finds all matches for a query against a string of text,
 * applying regex, wildcard, or literal matching, as well as whole-word and max-gap post-filters.
 */
export function findMatchesInText(
	text: string,
	queryOrCompiled: string | CompiledQuery,
	options: SearchQueryOptions = {},
	offset = 0
): MatchRange[] {
	if (!text || text.length === 0) return [];
	const compiled =
		typeof queryOrCompiled === "string"
			? compileQuery(queryOrCompiled, options)
			: queryOrCompiled;

	if (!compiled) return [];

	let rawMatches: MatchRange[] = [];

	if (compiled.type === "wildcard" && compiled.tokens) {
		rawMatches = findWildcardMatches(text, compiled.tokens, offset, compiled.caseSensitive);
	} else if (compiled.type === "literal" && compiled.needle) {
		const haystack = compiled.caseSensitive ? text : text.toLowerCase();
		const needle = compiled.needle;
		let idx = haystack.indexOf(needle);
		while (idx !== -1) {
			rawMatches.push({ from: offset + idx, to: offset + idx + needle.length });
			idx = haystack.indexOf(needle, idx + needle.length);
		}
	}

	// Apply post-filters
	if (compiled.wholeWord || compiled.maxGapChars !== undefined) {
		rawMatches = rawMatches.filter((m) => {
			if (compiled.wholeWord && !isWholeWord(text, m.from - offset, m.to - offset)) {
				return false;
			}
			if (
				compiled.maxGapChars !== undefined &&
				!isWithinMaxGap(m.chars, compiled.maxGapChars)
			) {
				return false;
			}
			return true;
		});
	}

	return rawMatches;
}

/**
 * Delegates link-syntax and frontmatter parsing to Obsidian's MetadataCache.
 * Frontmatter is always non-visible metadata and is always excluded.
 * Link destinations/URLs are excluded when filterHiddenLinks is true.
 */
function getHiddenRangesFromCache(
	cache: CachedMetadata,
	filterHiddenLinks: boolean
): { from: number; to: number }[] {
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
		const allLinks: ReferenceCache[] = [...(cache.links || []), ...(cache.embeds || [])];
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

function findCellBoundaries(lineText: string, matchStart: number, matchEnd: number) {
	let cellStart = 0;
	let colIndex = 0;
	for (let i = 0; i <= matchStart; i++) {
		if (lineText[i] === "|" && (i === 0 || lineText[i - 1] !== "\\")) {
			cellStart = i + 1;
			colIndex++;
		}
	}
	const normalizedColIndex = Math.max(0, colIndex - 1);

	let cellEnd = lineText.length;
	for (let i = matchEnd; i < lineText.length; i++) {
		if (lineText[i] === "|" && (i === 0 || lineText[i - 1] !== "\\")) {
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
	linkCache?: CachedMetadata,
	options?: SearchQueryOptions
): MatchRange[] {
	if (!query) return [];
	const searchOptions: SearchQueryOptions = {
		spaceAsWildcard,
		...options,
	};
	const compiled = compileQuery(query, searchOptions);
	if (!compiled) return [];

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
		let lineMatches = findMatchesInText(line.text, compiled, searchOptions, line.from);

		if (lineMatches.length > 0 && hiddenRanges.length > 0) {
			lineMatches = lineMatches.filter((m) => !isMatchHidden(m, hiddenRanges));
		}

		if (lineMatches.length > 0 && tableRanges.length > 0) {
			for (const m of lineMatches) {
				const tableRange = tableRanges.find((r) => m.from < r.to && m.to > r.from);
				if (tableRange) {
					m.inTable = true;
					const { cellText, cellStartOffset, colIndex } = findCellBoundaries(
						line.text,
						m.from - line.from,
						m.to - line.from
					);
					const tableStartLine = doc.lineAt(tableRange.from).number;
					const lineOffsetInTable = line.number - tableStartLine;
					const rowIndex =
						lineOffsetInTable === 0 ? 0 : Math.max(0, lineOffsetInTable - 1);
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
