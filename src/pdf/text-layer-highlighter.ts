import { findWildcardMatches } from "../engine";

/**
 * Injects inline <mark> highlight elements directly into PDF.js .textLayer text nodes
 * for both active (current) match framing and secondary match highlighting.
 *
 * Why inline <mark> tags directly in the text layer?
 * 1. PDF.js styles all `.textLayer span` with `position: absolute; color: transparent;`.
 *    Using `<mark>` avoids CSS collisions with PDF.js's span rules.
 * 2. Because <mark> is an inline child of the exact text node positioned by PDF.js,
 *    its geometry, scale, rotation, font metrics, and zoom alignment are 100% exact
 *    by construction â€” requiring zero coordinate math or matrix transformations.
 * 3. Rendering both the active match outline and secondary fills using the exact DOM
 *    character map eliminates PDF.js internal find-controller index drift (e.g. wrapping
 *    adjacent whitespace or shifted characters).
 */

export const SECONDARY_CLASS = "incsearch-pdf-secondary";
export const ACTIVE_CLASS = "incsearch-pdf-match is-current";

/**
 * Removes all injected <mark> highlight elements from containerEl,
 * unwrapping their text content and normalizing adjacent text nodes back to the original DOM.
 */
export function clearSecondaryHighlights(containerEl: HTMLElement): void {
	const marks = containerEl.querySelectorAll(
		`mark.${SECONDARY_CLASS}, mark.incsearch-pdf-match`
	);
	const parentsToNormalize = new Set<Node>();

	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i];
		const parent = mark.parentNode;
		if (!parent) continue;
		parentsToNormalize.add(parent);
		while (mark.firstChild) {
			parent.insertBefore(mark.firstChild, mark);
		}
		parent.removeChild(mark);
	}

	for (const parent of parentsToNormalize) {
		parent.normalize();
	}

	if (typeof containerEl.normalize === "function") {
		containerEl.normalize();
	}
}

interface CharMapEntry {
	node: Text;
	offsetInNode: number;
	isInsideNativeSelected?: boolean;
}

interface PageCharMap {
	fullText: string;
	charMap: CharMapEntry[];
	nativeSelectedCharIndices: Set<number>;
}

/**
 * Walks a .textLayer element to build a concatenated text string and 1:1 character-to-Text-node mapping.
 */
function buildTextLayerCharMap(textLayerEl: HTMLElement): PageCharMap {
	const walker = document.createTreeWalker(textLayerEl, NodeFilter.SHOW_TEXT, {
		acceptNode(node: Node): number {
			const parent = node.parentElement;
			if (!parent) return NodeFilter.FILTER_REJECT;
			// Skip any existing marks
			if (
				parent.tagName === "MARK" &&
				(parent.classList.contains(SECONDARY_CLASS) ||
					parent.classList.contains("incsearch-pdf-match"))
			) {
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	let fullText = "";
	const charMap: CharMapEntry[] = [];
	const nativeSelectedCharIndices = new Set<number>();
	let textNode = walker.nextNode() as Text | null;

	while (textNode) {
		const str = textNode.textContent || "";
		const parent = textNode.parentElement;
		const isInsideNativeSelected = Boolean(
			parent?.closest(
				".highlight.selected, .highlight.current, .highlight.append.selected, .highlight.appended.selected"
			)
		);

		for (let i = 0; i < str.length; i++) {
			const globalCharIdx = charMap.length;
			if (isInsideNativeSelected) {
				nativeSelectedCharIndices.add(globalCharIdx);
			}
			charMap.push({ node: textNode, offsetInNode: i, isInsideNativeSelected });
		}
		fullText += str;
		textNode = walker.nextNode() as Text | null;
	}

	return { fullText, charMap, nativeSelectedCharIndices };
}

interface TextInterval {
	start: number;
	end: number;
}

/**
 * Finds all match intervals [start, end) within the page's concatenated text.
 */
function findMatchIntervals(
	fullText: string,
	query: string,
	caseSensitive: boolean,
	spaceAsWildcard: boolean
): TextInterval[] {
	if (!fullText || !query) return [];

	const intervals: TextInterval[] = [];

	if (spaceAsWildcard && query.includes(" ")) {
		// Wildcard mode: only highlight full wildcard sequences, matching the
		// behavior in markdown mode. Standalone tokens are not secondary matches.
		const wildcardMatches = findWildcardMatches(fullText, query, 0, caseSensitive);
		for (const m of wildcardMatches) {
			// Use the full match span so the active/current highlight box covers
			// the entire wildcard sequence (e.g. "systematic search"), not just
			// the first token.
			intervals.push({ start: m.from, end: m.to });
		}
	} else {
		// Exact substring search
		const target = caseSensitive ? query : query.toLowerCase();
		const haystack = caseSensitive ? fullText : fullText.toLowerCase();
		let pos = 0;
		while (true) {
			const idx = haystack.indexOf(target, pos);
			if (idx === -1) break;
			intervals.push({ start: idx, end: idx + target.length });
			pos = idx + Math.max(1, target.length);
		}
	}

	return intervals;
}

interface NodeSlice {
	start: number;
	end: number;
	isCurrent: boolean;
}

/**
 * Injects inline <mark> highlight spans into a PDF.js text layer.
 * Marks the active match with `is-current` outline and secondary matches with `incsearch-pdf-secondary`.
 *
 * @param textLayerEl The .textLayer DOM element of the page.
 * @param query The search query string.
 * @param caseSensitive Whether the search is case-sensitive.
 * @param spaceAsWildcard Whether spaces act as wildcards.
 * @param targetActiveMatchIndex Optional 0-based match index on this page to mark as active (current).
 *                               If omitted or undefined, automatically detects active match via native highlight spans.
 */
export function injectSecondaryHighlights(
	textLayerEl: HTMLElement | null,
	query: string,
	caseSensitive: boolean,
	spaceAsWildcard = false,
	targetActiveMatchIndex?: number
): void {
	if (!textLayerEl || !query || query.trim().length === 0) return;

	// 1. Clean previous injected marks inside this text layer
	clearSecondaryHighlights(textLayerEl);

	// 2. Build continuous text and character-to-node mapping
	const { fullText, charMap, nativeSelectedCharIndices } = buildTextLayerCharMap(textLayerEl);
	if (fullText.length === 0 || charMap.length === 0) return;

	// 3. Find match intervals in the page text
	const intervals = findMatchIntervals(fullText, query, caseSensitive, spaceAsWildcard);
	if (intervals.length === 0) return;

	// 4. Resolve which match on this page is the active match
	let activeMatchIdx = -1;
	if (typeof targetActiveMatchIndex === "number") {
		activeMatchIdx = targetActiveMatchIndex;
	} else if (nativeSelectedCharIndices.size > 0) {
		// Auto-detect: find which match interval intersects the native selected characters
		for (let i = 0; i < intervals.length; i++) {
			const inter = intervals[i];
			let overlaps = false;
			for (let c = inter.start; c < inter.end; c++) {
				if (nativeSelectedCharIndices.has(c)) {
					overlaps = true;
					break;
				}
			}
			if (overlaps) {
				activeMatchIdx = i;
				break;
			}
		}
	}

	// 5. Map page-level intervals to individual Text nodes with isCurrent flag
	const nodeSliceMap = new Map<Text, NodeSlice[]>();

	for (let matchIdx = 0; matchIdx < intervals.length; matchIdx++) {
		const interval = intervals[matchIdx];
		const isCurrent = matchIdx === activeMatchIdx;
		const start = Math.max(0, Math.min(interval.start, charMap.length));
		const end = Math.max(start, Math.min(interval.end, charMap.length));
		if (start >= end) continue;

		let node = charMap[start].node;
		let segStart = charMap[start].offsetInNode;
		let segEnd = segStart + 1;

		for (let i = start + 1; i < end; i++) {
			const entry = charMap[i];
			if (entry.node === node && entry.offsetInNode === segEnd) {
				segEnd++;
			} else {
				const list = nodeSliceMap.get(node) || [];
				list.push({ start: segStart, end: segEnd, isCurrent });
				nodeSliceMap.set(node, list);

				node = entry.node;
				segStart = entry.offsetInNode;
				segEnd = segStart + 1;
			}
		}

		const list = nodeSliceMap.get(node) || [];
		list.push({ start: segStart, end: segEnd, isCurrent });
		nodeSliceMap.set(node, list);
	}

	// 6. Wrap matching text slices in <mark>
	for (const [textNode, rawSlices] of nodeSliceMap.entries()) {
		const parent = textNode.parentNode;
		if (!parent) continue;

		const content = textNode.textContent || "";
		if (content.length === 0) continue;

		// Sort slices by start offset
		rawSlices.sort((a, b) => a.start - b.start);

		// Merge overlapping slices, prioritizing isCurrent
		const mergedSlices: NodeSlice[] = [];
		for (const slice of rawSlices) {
			const clampedStart = Math.max(0, Math.min(slice.start, content.length));
			const clampedEnd = Math.max(clampedStart, Math.min(slice.end, content.length));
			if (clampedStart >= clampedEnd) continue;

			if (mergedSlices.length === 0) {
				mergedSlices.push({
					start: clampedStart,
					end: clampedEnd,
					isCurrent: slice.isCurrent,
				});
			} else {
				const last = mergedSlices[mergedSlices.length - 1];
				if (clampedStart <= last.end) {
					last.end = Math.max(last.end, clampedEnd);
					last.isCurrent = last.isCurrent || slice.isCurrent;
				} else {
					mergedSlices.push({
						start: clampedStart,
						end: clampedEnd,
						isCurrent: slice.isCurrent,
					});
				}
			}
		}

		if (mergedSlices.length === 0) continue;

		// Construct replacement DocumentFragment
		const frag = document.createDocumentFragment();
		let cursor = 0;

		for (const slice of mergedSlices) {
			if (slice.start > cursor) {
				frag.appendChild(document.createTextNode(content.slice(cursor, slice.start)));
			}

			const mark = document.createElement("mark");
			mark.className = slice.isCurrent ? ACTIVE_CLASS : SECONDARY_CLASS;
			mark.textContent = content.slice(slice.start, slice.end);
			frag.appendChild(mark);

			cursor = slice.end;
		}

		if (cursor < content.length) {
			frag.appendChild(document.createTextNode(content.slice(cursor)));
		}

		parent.replaceChild(frag, textNode);
	}
}
