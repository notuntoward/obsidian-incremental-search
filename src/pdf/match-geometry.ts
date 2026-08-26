import { ItemMatchSpan, MatchRect, PageTextModel } from "./types";

/**
 * Extracts all text nodes inside a DOM tree into a single searchable string,
 * keeping an exact 1:1 character index to Text node and character offset.
 */
interface DomCharMapping {
	text: string;
	chars: { node: Text; offset: number }[];
}

function extractDomCharMapping(container: Node): DomCharMapping {
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
	let node = walker.nextNode() as Text | null;
	let text = "";
	const chars: { node: Text; offset: number }[] = [];

	while (node) {
		const nodeContent = node.textContent || "";
		for (let i = 0; i < nodeContent.length; i++) {
			chars.push({ node, offset: i });
		}
		text += nodeContent;
		node = walker.nextNode() as Text | null;
	}

	return { text, chars };
}

/**
 * Computes bounding rectangles for match spans on a page.
 * Uses exact DOM Range measurements from PDF.js .textLayer spans if populated,
 * or falls back to PDF.js PageViewport transform matrices.
 */
export function computeMatchGeometry(
	pageElement: HTMLElement | null,
	textLayerElement: HTMLElement | null,
	itemSpans: ItemMatchSpan[],
	pageModel: PageTextModel,
	viewport?: any
): { rects: MatchRect[] } {
	if (!pageElement) {
		return { rects: [] };
	}

	// 1. If textLayer is available, measure exact DOM ranges from rendered browser font layout
	if (textLayerElement && textLayerElement.children.length > 0) {
		const domRects = computeDomRangeGeometry(
			pageElement,
			textLayerElement,
			itemSpans,
			pageModel
		);
		if (
			domRects.length === itemSpans.length &&
			domRects.length > 0 &&
			domRects.every((dr) => dr.width >= 3 && dr.height >= 3)
		) {
			return { rects: domRects };
		}
	}

	// 2. Fallback to transform geometry if textLayer is not yet rendered
	const transformRects = computeTransformGeometry(pageElement, itemSpans, pageModel, viewport);
	return { rects: transformRects };
}

/**
 * Finds the DOM element in .textLayer that corresponds to a text item,
 * verifying that the element's textContent matches the item's string.
 */
function findMatchingDomElement(
	domChildren: HTMLElement[],
	targetDomIndex: number,
	expectedStr: string
): HTMLElement | null {
	if (!expectedStr) return null;
	const trimmed = expectedStr.trim();

	// 1. Direct index check
	if (targetDomIndex < domChildren.length) {
		const directEl = domChildren[targetDomIndex];
		const text = directEl.textContent || "";
		if (text === expectedStr || (trimmed && text.includes(trimmed))) {
			return directEl;
		}
	}

	// 2. Search adjacent elements within a local window (e.g. ±15 elements)
	for (let offset = 1; offset <= 15; offset++) {
		const left = targetDomIndex - offset;
		if (left >= 0 && left < domChildren.length) {
			const el = domChildren[left];
			const text = el.textContent || "";
			if (text === expectedStr || (trimmed && text.includes(trimmed))) {
				return el;
			}
		}
		const right = targetDomIndex + offset;
		if (right < domChildren.length) {
			const el = domChildren[right];
			const text = el.textContent || "";
			if (text === expectedStr || (trimmed && text.includes(trimmed))) {
				return el;
			}
		}
	}

	// 3. Scan all children for matching text
	for (const el of domChildren) {
		const text = el.textContent || "";
		if (text === expectedStr || (trimmed && text.includes(trimmed))) {
			return el;
		}
	}

	return null;
}

/**
 * Traverses a DOM node tree to find the exact Text node and local offset
 * corresponding to a character offset within the element's textContent.
 */
function getTextNodeAndOffset(
	root: Node,
	targetOffset: number
): { node: Text; offset: number } | null {
	const mapping = extractDomCharMapping(root);
	if (mapping.chars.length === 0) return null;
	const idx = Math.max(0, Math.min(targetOffset, mapping.chars.length - 1));
	return mapping.chars[idx] || null;
}

/**
 * Computes exact bounding rectangles using DOM Range on .textLayer span elements,
 * normalized by current page zoom / CSS transforms.
 */
function computeDomRangeGeometry(
	pageElement: HTMLElement,
	textLayerElement: HTMLElement,
	itemSpans: ItemMatchSpan[],
	pageModel: PageTextModel
): MatchRect[] {
	const pageRect = pageElement.getBoundingClientRect();
	const scaleX = pageElement.offsetWidth > 0 ? pageRect.width / pageElement.offsetWidth : 1;
	const scaleY = pageElement.offsetHeight > 0 ? pageRect.height / pageElement.offsetHeight : 1;
	const domChildren = Array.from(textLayerElement.children) as HTMLElement[];
	const resultRects: MatchRect[] = [];
	let pageDomMapping: DomCharMapping | null = null;

	for (const span of itemSpans) {
		const item = pageModel.items[span.itemIndex];
		if (!item || !item.str) continue;

		let rectsForSpan: MatchRect[] = [];

		// 1. Try element-level match first
		const targetDomIndex = item.domIndex ?? span.itemIndex;
		const targetEl = findMatchingDomElement(domChildren, targetDomIndex, item.str);
		if (targetEl) {
			const elMapping = extractDomCharMapping(targetEl);
			const totalLength = elMapping.chars.length;
			const localStart = Math.max(0, Math.min(span.startOffset, totalLength));
			const localEnd = Math.max(localStart, Math.min(span.endOffset, totalLength));

			if (localStart < localEnd && localEnd <= elMapping.chars.length) {
				const startChar = elMapping.chars[localStart];
				const endChar = elMapping.chars[localEnd - 1];
				try {
					const range = document.createRange();
					range.setStart(startChar.node, startChar.offset);
					range.setEnd(endChar.node, endChar.offset + 1);

					const clientRects = range.getClientRects();
					for (let i = 0; i < clientRects.length; i++) {
						const r = clientRects[i];
						if (r.width > 0 && r.height > 0) {
							rectsForSpan.push({
								left: Math.max(0, (r.left - pageRect.left) / scaleX),
								top: Math.max(0, (r.top - pageRect.top) / scaleY),
								width: Math.max(2, r.width / scaleX),
								height: Math.max(2, r.height / scaleY),
							});
						}
					}
				} catch {
					// Ignore DOM range errors
				}
			}
		}

		// 2. If element-level match failed, search in the page-wide DOM text mapping
		if (rectsForSpan.length === 0) {
			if (!pageDomMapping) {
				pageDomMapping = extractDomCharMapping(textLayerElement);
			}

			const targetSnippet = item.str.slice(span.startOffset, span.endOffset);
			if (targetSnippet && pageDomMapping.text.length > 0) {
				const foundIdx = pageDomMapping.text.indexOf(targetSnippet);
				if (foundIdx !== -1 && foundIdx + targetSnippet.length <= pageDomMapping.chars.length) {
					const startChar = pageDomMapping.chars[foundIdx];
					const endChar = pageDomMapping.chars[foundIdx + targetSnippet.length - 1];
					try {
						const range = document.createRange();
						range.setStart(startChar.node, startChar.offset);
						range.setEnd(endChar.node, endChar.offset + 1);

						const clientRects = range.getClientRects();
						for (let i = 0; i < clientRects.length; i++) {
							const r = clientRects[i];
							if (r.width > 0 && r.height > 0) {
								rectsForSpan.push({
									left: Math.max(0, (r.left - pageRect.left) / scaleX),
									top: Math.max(0, (r.top - pageRect.top) / scaleY),
									width: Math.max(2, r.width / scaleX),
									height: Math.max(2, r.height / scaleY),
								});
							}
						}
					} catch {
						// Ignore DOM range errors
					}
				}
			}
		}

		resultRects.push(...rectsForSpan);
	}

	return resultRects;
}

function getCharWeight(ch: string): number {
	if (ch === " " || ch === "\t") return 0.28;
	if ("ijl|![]:;.,'\"`".includes(ch)) return 0.26;
	if ("frt-()".includes(ch)) return 0.38;
	if ("abcdeghknopquvxyz0123456789".includes(ch)) return 0.54;
	if ("w".includes(ch)) return 0.78;
	if ("m".includes(ch)) return 0.84;
	if ("ABCDEFGHJKLMNOPQRSTUVXYZ".includes(ch)) return 0.72;
	if ("MW".includes(ch)) return 0.95;
	return 0.54;
}

function getSubStringFractions(
	str: string,
	startOffset: number,
	endOffset: number
): { startFrac: number; endFrac: number } {
	const totalLen = str.length;
	if (totalLen === 0) return { startFrac: 0, endFrac: 1 };

	let totalWeight = 0;
	const weights: number[] = new Array(totalLen);
	for (let i = 0; i < totalLen; i++) {
		const w = getCharWeight(str[i]);
		weights[i] = w;
		totalWeight += w;
	}

	if (totalWeight <= 0) {
		return {
			startFrac: Math.max(0, Math.min(1, startOffset / totalLen)),
			endFrac: Math.max(0, Math.min(1, endOffset / totalLen)),
		};
	}

	let startWeight = 0;
	const clampedStart = Math.max(0, Math.min(startOffset, totalLen));
	for (let i = 0; i < clampedStart; i++) {
		startWeight += weights[i];
	}

	let spanWeight = 0;
	const clampedEnd = Math.max(clampedStart, Math.min(endOffset, totalLen));
	for (let i = clampedStart; i < clampedEnd; i++) {
		spanWeight += weights[i];
	}

	return {
		startFrac: startWeight / totalWeight,
		endFrac: (startWeight + spanWeight) / totalWeight,
	};
}

/**
 * Fallback geometry computation using TextItem transform matrices and page viewport.
 */
function computeTransformGeometry(
	pageElement: HTMLElement,
	itemSpans: ItemMatchSpan[],
	pageModel: PageTextModel,
	viewport?: any
): MatchRect[] {
	const resultRects: MatchRect[] = [];
	const pageWidth = pageElement.offsetWidth || viewport?.width || 612;
	const pageHeight = pageElement.offsetHeight || viewport?.height || 792;

	for (const span of itemSpans) {
		const item = pageModel.items[span.itemIndex];
		if (!item || !item.str || item.str.length === 0) continue;

		const { startFrac, endFrac } = getSubStringFractions(
			item.str,
			span.startOffset,
			span.endOffset
		);

		const transform = item.transform || [1, 0, 0, 1, 0, 0];
		const itemX = transform[4] || 0;
		const itemY = transform[5] || 0;
		const itemWidth = item.width || 100;
		const itemHeight = item.height || Math.abs(transform[3]) || Math.abs(transform[0]) || 12;

		const subX1 = itemX + itemWidth * startFrac;
		const subX2 = itemX + itemWidth * endFrac;
		// PDF transform[5] is the font baseline. In standard PDF coordinates (+Y up),
		// ascent is above baseline (+0.75 * itemHeight) and descent is below (-0.25 * itemHeight).
		const subY1 = itemY - 0.25 * itemHeight;
		const subY2 = itemY + 0.75 * itemHeight;

		// 1. Check if viewport has convertToViewportPoint (standard PDF.js PageViewport API)
		if (viewport && typeof viewport.convertToViewportPoint === "function") {
			try {
				const pt1 = viewport.convertToViewportPoint(subX1, subY1);
				const pt2 = viewport.convertToViewportPoint(subX2, subY2);
				resultRects.push({
					left: Math.max(0, Math.min(pt1[0], pt2[0])),
					top: Math.max(0, Math.min(pt1[1], pt2[1])),
					width: Math.max(2, Math.abs(pt2[0] - pt1[0])),
					height: Math.max(2, Math.abs(pt2[1] - pt1[1])),
				});
				continue;
			} catch {
				// Fallback to transform matrix
			}
		}

		// 2. Check if viewport has transform matrix: [scaleX, 0, 0, -scaleY, offsetX, offsetY]
		if (viewport && Array.isArray(viewport.transform) && viewport.transform.length >= 6) {
			const M = viewport.transform;
			const p1x = M[0] * subX1 + M[2] * subY1 + M[4];
			const p1y = M[1] * subX1 + M[3] * subY1 + M[5];
			const p2x = M[0] * subX2 + M[2] * subY2 + M[4];
			const p2y = M[1] * subX2 + M[3] * subY2 + M[5];
			resultRects.push({
				left: Math.max(0, Math.min(p1x, p2x)),
				top: Math.max(0, Math.min(p1y, p2y)),
				width: Math.max(2, Math.abs(p2x - p1x)),
				height: Math.max(2, Math.abs(p2y - p1y)),
			});
			continue;
		}

		// 3. Fallback proportional scaling
		const scaleX = pageWidth / (viewport?.rawDims?.pageWidth || 612);
		const scaleY = pageHeight / (viewport?.rawDims?.pageHeight || 792);
		resultRects.push({
			left: Math.max(0, subX1 * scaleX),
			top: Math.max(0, pageHeight - subY2 * scaleY),
			width: Math.max(2, (subX2 - subX1) * scaleX),
			height: Math.max(2, (subY2 - subY1) * scaleY),
		});
	}

	return resultRects;
}
