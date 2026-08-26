import { ItemMatchSpan, MatchRect, PageTextModel } from "./types";

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

	// If textLayer is available, measure exact DOM ranges from rendered browser font layout
	if (textLayerElement && textLayerElement.children.length > 0) {
		const domRects = computeDomRangeGeometry(
			pageElement,
			textLayerElement,
			itemSpans,
			pageModel
		);
		if (domRects.length === itemSpans.length && domRects.length > 0) {
			const allValid = domRects.every((dr) => dr.width >= 3 && dr.height >= 3);
			if (allValid) {
				return { rects: domRects };
			}
		}
	}

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
	const textNodes: Text[] = [];
	if (root.nodeType === Node.TEXT_NODE) {
		textNodes.push(root as Text);
	} else {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
		let n = walker.nextNode();
		while (n) {
			textNodes.push(n as Text);
			n = walker.nextNode();
		}
	}

	let accumulated = 0;
	for (const tn of textNodes) {
		const len = tn.textContent?.length || 0;
		if (accumulated + len >= targetOffset) {
			return { node: tn, offset: Math.max(0, targetOffset - accumulated) };
		}
		accumulated += len;
	}

	if (textNodes.length > 0) {
		const last = textNodes[textNodes.length - 1];
		return { node: last, offset: last.textContent?.length || 0 };
	}

	return null;
}

/**
 * Computes exact bounding rectangles using DOM Range on .textLayer span elements.
 */
function computeDomRangeGeometry(
	pageElement: HTMLElement,
	textLayerElement: HTMLElement,
	itemSpans: ItemMatchSpan[],
	pageModel: PageTextModel
): MatchRect[] {
	const pageRect = pageElement.getBoundingClientRect();
	const domChildren = Array.from(textLayerElement.children) as HTMLElement[];
	const resultRects: MatchRect[] = [];

	for (const span of itemSpans) {
		const item = pageModel.items[span.itemIndex];
		if (!item || !item.str) continue;

		// Map itemIndex to DOM element using item.domIndex
		const targetDomIndex = item.domIndex ?? span.itemIndex;
		const targetEl = findMatchingDomElement(domChildren, targetDomIndex, item.str);
		if (!targetEl) {
			// If element text doesn't match, abort DOM measurement to allow transform geometry fallback
			return [];
		}

		const totalLength = targetEl.textContent?.length ?? item.str.length;
		const localStart = Math.max(0, Math.min(span.startOffset, totalLength));
		const localEnd = Math.max(localStart, Math.min(span.endOffset, totalLength));

		if (localStart === localEnd) continue;

		const startPos = getTextNodeAndOffset(targetEl, localStart);
		const endPos = getTextNodeAndOffset(targetEl, localEnd);
		if (!startPos || !endPos) continue;

		try {
			const range = document.createRange();
			range.setStart(startPos.node, startPos.offset);
			range.setEnd(endPos.node, endPos.offset);

			const clientRects = range.getClientRects();
			for (let i = 0; i < clientRects.length; i++) {
				const r = clientRects[i];
				if (r.width > 0 && r.height > 0) {
					resultRects.push({
						left: Math.max(0, r.left - pageRect.left),
						top: Math.max(0, r.top - pageRect.top),
						width: r.width,
						height: r.height,
					});
				}
			}
		} catch {
			// Ignore DOM range errors
		}
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
		// PDF transform[5] is the font baseline. Glyphs extend below by ~0.2*h (descent) and above by ~0.85*h (ascent).
		const subY1 = itemY - 0.2 * itemHeight;
		const subY2 = itemY + 0.85 * itemHeight;

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
			height: Math.max(2, itemHeight * scaleY),
		});
	}

	return resultRects;
}
