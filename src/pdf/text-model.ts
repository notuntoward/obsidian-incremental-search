import { PdfTextItem, PageTextModel, CharSourceMapping, ItemMatchSpan } from "./types";

const LIGATURE_MAP: Record<string, string> = {
	"\uFB00": "ff",
	"\uFB01": "fi",
	"\uFB02": "fl",
	"\uFB03": "ffi",
	"\uFB04": "ffl",
	"\uFB05": "st",
	"\uFB06": "st",
};

const SMART_QUOTES_MAP: Record<string, string> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201A": "'",
	"\u201B": "'",
	"\u2032": "'",
	"\u2035": "'",
	"\u0060": "'",
	"\u201C": '"',
	"\u201D": '"',
	"\u201E": '"',
	"\u201F": '"',
	"\u2033": '"',
	"\u2036": '"',
	"\u00AB": '"',
	"\u00BB": '"',
};

const DASH_VARIANTS: Record<string, string> = {
	"\u2014": "-", // Em dash
	"\u2013": "-", // En dash
	"\u2212": "-", // Minus sign
	"\u2010": "-", // Hyphen
	"\u2011": "-", // Non-breaking hyphen
	"\u2012": "-", // Figure dash
	"\u2015": "-", // Horizontal bar
};

const UNICODE_SPACES = new Set([
	"\u00A0", // No-break space
	"\u2000", // En quad
	"\u2001", // Em quad
	"\u2002", // En space
	"\u2003", // Em space
	"\u2004", // Three-per-em space
	"\u2005", // Four-per-em space
	"\u2006", // Six-per-em space
	"\u2007", // Figure space
	"\u2008", // Punctuation space
	"\u2009", // Thin space
	"\u200A", // Hair space
	"\u202F", // Narrow no-break space
	"\u205F", // Medium mathematical space
	"\u3000", // Ideographic space
]);

const ZERO_WIDTH_CHARS = new Set([
	"\u00AD", // Soft hyphen
	"\u200B", // Zero-width space
	"\u200C", // Zero-width non-joiner
	"\u200D", // Zero-width joiner
	"\uFEFF", // Zero-width no-break space (BOM)
]);

/**
 * Normalizes a single character or ligature, returning the normalized string
 * and tracking its length.
 */
function normalizeCharacter(ch: string): string {
	if (ZERO_WIDTH_CHARS.has(ch)) {
		return "";
	}
	if (LIGATURE_MAP[ch]) {
		return LIGATURE_MAP[ch];
	}
	if (SMART_QUOTES_MAP[ch]) {
		return SMART_QUOTES_MAP[ch];
	}
	if (DASH_VARIANTS[ch]) {
		return DASH_VARIANTS[ch];
	}
	if (UNICODE_SPACES.has(ch)) {
		return " ";
	}
	return ch.normalize("NFKC");
}

/**
 * Filters out empty string items and deduplicates identical text items at the exact same coordinates
 * (e.g. from drop shadows, faux bolding, or duplicate PDF content streams).
 */
export function deduplicateRawItems(rawItems: PdfTextItem[]): PdfTextItem[] {
	if (!rawItems || rawItems.length === 0) return [];
	const filtered: PdfTextItem[] = [];
	for (let i = 0; i < rawItems.length; i++) {
		const it = rawItems[i];
		if (!it.str || it.str.length === 0) continue;

		// Check if there is already an identical item at the exact same location
		const isDuplicate = filtered.some((prev) => {
			if (prev.str !== it.str) return false;
			const pTf = prev.transform || [1, 0, 0, 1, 0, 0];
			const iTf = it.transform || [1, 0, 0, 1, 0, 0];
			return (
				Math.abs(pTf[4] - iTf[4]) < 0.5 &&
				Math.abs(pTf[5] - iTf[5]) < 0.5 &&
				Math.abs((prev.width || 0) - (it.width || 0)) < 1
			);
		});

		if (!isDuplicate) {
			filtered.push(it);
		}
	}
	return filtered;
}

/**
 * Sorts PDF text items into visual reading order (top-to-bottom, left-to-right)
 * while preserving the original DOM index for exact textLayer element lookup.
 * Note: Empty string items and identical position duplicates are omitted.
 */
export function sortItemsReadingOrder(rawItems: PdfTextItem[]): PdfTextItem[] {
	if (!rawItems || rawItems.length === 0) {
		return [];
	}

	const nonDuplicates = deduplicateRawItems(rawItems);
	let currentDomIndex = 0;
	const indexedItems: PdfTextItem[] = nonDuplicates.map((item) => ({
		...item,
		domIndex: item.domIndex ?? currentDomIndex++,
	}));

	indexedItems.sort((a, b) => {
		const tfA = a.transform || [1, 0, 0, 1, 0, 0];
		const tfB = b.transform || [1, 0, 0, 1, 0, 0];
		const xA = tfA[4] || 0;
		const yA = tfA[5] || 0;
		const xB = tfB[4] || 0;
		const yB = tfB[5] || 0;

		const hA = a.height || Math.abs(tfA[3]) || Math.abs(tfA[0]) || 10;
		const hB = b.height || Math.abs(tfB[3]) || Math.abs(tfB[0]) || 10;

		// In PDF coordinates, higher y is closer to top of page.
		// For top-to-bottom order, higher y comes first (descending y: yB - yA > 0).
		const yDiff = yB - yA;
		const lineHeight = Math.max(hA, hB, 8);
		const lineTolerance = lineHeight * 0.45;

		if (Math.abs(yDiff) <= lineTolerance) {
			// On the same visual line: sort left-to-right (lower x comes first)
			return xA - xB;
		}

		// On different lines: sort top-to-bottom (higher y first)
		return yDiff;
	});

	return indexedItems;
}

/**
 * Builds a searchable PageTextModel from PDF.js TextContent items,
 * maintaining a reversible source map from normalized character index
 * to original TextItem and local character offset.
 */
export function buildPageTextModel(pageNumber: number, rawItems: PdfTextItem[]): PageTextModel {
	const items = sortItemsReadingOrder(rawItems);
	const normalizedChars: string[] = [];
	const charMapping: (CharSourceMapping | null)[] = [];

	let prevItemEndedWithSpaceOrHyphen = true;

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex];
		const str = item.str || "";

		if (str.length === 0) {
			if (item.hasEOL && !prevItemEndedWithSpaceOrHyphen) {
				normalizedChars.push(" ");
				charMapping.push(null);
				prevItemEndedWithSpaceOrHyphen = true;
			}
			continue;
		}

		// Insert synthetic space delimiter between items if needed
		const startsWithWhitespace = /^\s/.test(str);
		if (!prevItemEndedWithSpaceOrHyphen && !startsWithWhitespace) {
			normalizedChars.push(" ");
			charMapping.push(null);
		}

		for (let charOffset = 0; charOffset < str.length; charOffset++) {
			const rawChar = str[charOffset];
			const normStr = normalizeCharacter(rawChar);

			if (normStr.length === 0) {
				// Ignored zero-width char / soft hyphen
				continue;
			}

			for (let k = 0; k < normStr.length; k++) {
				normalizedChars.push(normStr[k]);
				charMapping.push({
					itemIndex,
					charOffset,
					origLength: 1,
				});
			}
		}

		const endsWithWhitespaceOrHyphen = /[\s\-–—]$/.test(str);
		prevItemEndedWithSpaceOrHyphen = endsWithWhitespaceOrHyphen;

		if (item.hasEOL && !prevItemEndedWithSpaceOrHyphen) {
			normalizedChars.push(" ");
			charMapping.push(null);
			prevItemEndedWithSpaceOrHyphen = true;
		}
	}

	return {
		pageNumber,
		normalizedText: normalizedChars.join(""),
		charMapping,
		items,
	};
}

/**
 * Maps a match range [start, end) in normalized text back to original TextItem character spans.
 */
export function mapNormalizedRangeToItemSpans(
	pageModel: PageTextModel,
	start: number,
	end: number
): ItemMatchSpan[] {
	const mapping = pageModel.charMapping;
	const clampedStart = Math.max(0, Math.min(start, mapping.length));
	const clampedEnd = Math.max(clampedStart, Math.min(end, mapping.length));

	const itemCharRanges = new Map<number, { min: number; max: number }>();

	for (let i = clampedStart; i < clampedEnd; i++) {
		const entry = mapping[i];
		if (!entry) continue;

		const { itemIndex, charOffset, origLength = 1 } = entry;
		const endOffset = charOffset + origLength;

		const existing = itemCharRanges.get(itemIndex);
		if (!existing) {
			itemCharRanges.set(itemIndex, { min: charOffset, max: endOffset });
		} else {
			existing.min = Math.min(existing.min, charOffset);
			existing.max = Math.max(existing.max, endOffset);
		}
	}

	const spans: ItemMatchSpan[] = [];
	for (const [itemIndex, range] of itemCharRanges.entries()) {
		spans.push({
			itemIndex,
			startOffset: range.min,
			endOffset: range.max,
		});
	}

	// Sort spans by itemIndex ascending
	spans.sort((a, b) => a.itemIndex - b.itemIndex);
	return spans;
}
