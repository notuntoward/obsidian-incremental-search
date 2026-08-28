import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";

export interface BoundingRectLike {
	top: number;
	bottom: number;
	left: number;
	right: number;
	height?: number;
	width?: number;
}

/**
 * Checks whether a target bounding box is completely or partially outside
 * the top or bottom boundaries of the container viewport (i.e. not fully visible).
 * Returns true if ANY part of the target extends outside the viewport (or padding buffer).
 */
export function isOffScreenVertically(
	target: BoundingRectLike,
	viewport: BoundingRectLike,
	padding = 5
): boolean {
	return target.top < viewport.top + padding || target.bottom > viewport.bottom - padding;
}

/**
 * Checks whether a target bounding box is completely or partially outside
 * the left or right boundaries of the container viewport (i.e. not fully visible).
 * Returns true if ANY part of the target extends outside the viewport (or padding buffer).
 */
export function isOffScreenHorizontally(
	target: BoundingRectLike,
	viewport: BoundingRectLike,
	padding = 5
): boolean {
	return target.left < viewport.left + padding || target.right > viewport.right - padding;
}

/**
 * Checks whether a large element (such as an entire PDF page) is completely disjoint
 * from the viewport (no part of the element is visible on screen).
 */
export function isPageCompletelyOffScreen(
	pageBounds: BoundingRectLike,
	viewport: BoundingRectLike
): boolean {
	return pageBounds.bottom < viewport.top || pageBounds.top > viewport.bottom;
}

/**
 * Calculates the vertical scroll offset needed to center the target element/rect
 * within the container viewport.
 */
export function computeVerticalCenterDelta(
	targetTop: number,
	targetHeight: number,
	containerTop: number,
	containerHeight: number
): number {
	const targetCenter = targetTop + targetHeight / 2;
	const containerCenter = containerTop + containerHeight / 2;
	return targetCenter - containerCenter;
}

/**
 * For CodeMirror 6 EditorView: checks if a range [from, to] is off-screen vertically.
 * If off-screen, returns a scrollIntoView effect with y: "center".
 * If already visible on-screen, returns a scrollIntoView effect with y: "nearest".
 */
export function getSmartScrollEffect(view: EditorView, from: number, to: number) {
	try {
		const scrollDOM = (view as any).scrollDOM || view.dom;
		if (!scrollDOM || typeof scrollDOM.getBoundingClientRect !== "function") {
			return EditorView.scrollIntoView(EditorSelection.range(from, to), {
				y: "center",
			});
		}

		const viewportRect = scrollDOM.getBoundingClientRect();
		const targetCoords = view.coordsAtPos(from);

		if (!targetCoords) {
			return EditorView.scrollIntoView(EditorSelection.range(from, to), {
				y: "center",
			});
		}

		if (isOffScreenVertically(targetCoords, viewportRect)) {
			return EditorView.scrollIntoView(EditorSelection.range(from, to), {
				y: "center",
			});
		}

		return EditorView.scrollIntoView(EditorSelection.range(from, to), {
			y: "nearest",
		});
	} catch {
		return EditorView.scrollIntoView(EditorSelection.range(from, to), {
			y: "center",
		});
	}
}
