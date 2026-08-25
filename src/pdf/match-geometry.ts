import { ItemMatchSpan, MatchRect, PageTextModel } from "./types";

export interface GeometryResult {
	rects: MatchRect[];
	isFallback: boolean;
}

/**
 * Computes visual bounding rectangles for a list of ItemMatchSpans on a PDF page.
 * Prefers precise DOM Range client rects from the text layer; falls back to
 * PDF transform-matrix calculation if DOM nodes are unavailable.
 */
export function computeMatchGeometry(
	pageElement: HTMLElement | null,
	textLayerElement: HTMLElement | null,
	itemSpans: ItemMatchSpan[],
	pageModel: PageTextModel,
	viewport?: {
		convertToViewportRectangle?: (rect: number[]) => number[];
		width?: number;
		height?: number;
		scale?: number;
	}
): GeometryResult {
	if (!pageElement || itemSpans.length === 0) {
		return { rects: [], isFallback: false };
	}

	// 1. Primary route: DOM Range getClientRects() from rendered text layer
	if (textLayerElement && textLayerElement.childElementCount > 0) {
		const domRects = computeDomRangeGeometry(pageElement, textLayerElement, itemSpans, pageModel);
		if (domRects.length > 0) {
			return { rects: domRects, isFallback: false };
		}
	}

	// 2. Fallback route: PDF transform matrix calculation
	const fallbackRects = computeTransformGeometry(pageElement, itemSpans, pageModel, viewport);
	return { rects: fallbackRects, isFallback: true };
}

/**
 * Primary geometry computation using DOM Range client rects.
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
		if (!item) continue;

		// Map itemIndex to DOM element
		let targetEl: HTMLElement | null = null;
		if (domChildren.length === pageModel.items.length) {
			targetEl = domChildren[span.itemIndex];
		} else if (span.itemIndex < domChildren.length) {
			targetEl = domChildren[span.itemIndex];
		}

		if (!targetEl) continue;

		const textNode = targetEl.firstChild || targetEl;
		const totalLength = textNode.textContent?.length ?? item.str.length;
		const localStart = Math.max(0, Math.min(span.startOffset, totalLength));
		const localEnd = Math.max(localStart, Math.min(span.endOffset, totalLength));

		if (localStart === localEnd) continue;

		try {
			const range = document.createRange();
			range.setStart(textNode, localStart);
			range.setEnd(textNode, localEnd);

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
			// Ignore DOM range errors for detached/malformed nodes and continue
		}
	}

	return resultRects;
}

/**
 * Fallback geometry computation using TextItem transform matrices and page viewport.
 */
function computeTransformGeometry(
	pageElement: HTMLElement,
	itemSpans: ItemMatchSpan[],
	pageModel: PageTextModel,
	viewport?: {
		convertToViewportRectangle?: (rect: number[]) => number[];
		width?: number;
		height?: number;
		scale?: number;
	}
): MatchRect[] {
	const resultRects: MatchRect[] = [];
	const pageWidth = pageElement.offsetWidth || viewport?.width || 612;
	const pageHeight = pageElement.offsetHeight || viewport?.height || 792;

	for (const span of itemSpans) {
		const item = pageModel.items[span.itemIndex];
		if (!item || !item.str || item.str.length === 0) continue;

		const totalLen = item.str.length;
		const startFrac = Math.max(0, Math.min(1, span.startOffset / totalLen));
		const endFrac = Math.max(startFrac, Math.min(1, span.endOffset / totalLen));

		const transform = item.transform || [1, 0, 0, 1, 0, 0];
		const itemX = transform[4];
		const itemY = transform[5];
		const itemWidth = item.width || 100;
		const itemHeight = item.height || Math.abs(transform[3]) || 12;

		const subX1 = itemX + itemWidth * startFrac;
		const subX2 = itemX + itemWidth * endFrac;
		const subY1 = itemY;
		const subY2 = itemY + itemHeight;

		if (viewport && typeof viewport.convertToViewportRectangle === "function") {
			try {
				const vpRect = viewport.convertToViewportRectangle([subX1, subY1, subX2, subY2]);
				const x = Math.min(vpRect[0], vpRect[2]);
				const y = Math.min(vpRect[1], vpRect[3]);
				const w = Math.abs(vpRect[2] - vpRect[0]);
				const h = Math.abs(vpRect[3] - vpRect[1]);

				resultRects.push({
					left: Math.max(0, x),
					top: Math.max(0, y),
					width: w,
					height: h,
				});
				continue;
			} catch {
				// Fallback to basic coordinate scaling below
			}
		}

		// Simple proportional projection if viewport is unavailable
		const scaleX = pageWidth / 612;
		const scaleY = pageHeight / 792;
		resultRects.push({
			left: Math.max(0, subX1 * scaleX),
			top: Math.max(0, pageHeight - subY2 * scaleY),
			width: Math.max(2, (subX2 - subX1) * scaleX),
			height: Math.max(2, itemHeight * scaleY),
		});
	}

	return resultRects;
}
