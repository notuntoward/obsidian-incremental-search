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
	padding = 0
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
	padding = 0
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

export interface ScrollCenterDelta {
	isOffV: boolean;
	isOffH: boolean;
	deltaX: number;
	deltaY: number;
}

export interface ComputeScrollDeltasOptions {
	padding?: number;
	forceCenter?: boolean;
	isZoomedH?: boolean;
}

export interface ScrollTargetOptions {
	padding?: number;
	behavior?: ScrollBehavior;
	forceCenter?: boolean;
	isZoomedH?: boolean;
}

/**
 * Calculates the horizontal and vertical deltas required to center a target
 * within a container viewport if it is outside the viewport.
 * If the target is not off-screen along any axis and forceCenter is false,
 * both deltas are 0.
 * If the target is off-screen (or forceCenter is true), deltaY centers the
 * target vertically, and deltaX centers the target horizontally if off-screen
 * horizontally, zoomed, or forceCenter.
 */
export function computeScrollDeltas(
	target: BoundingRectLike,
	containerRect: BoundingRectLike,
	options: number | ComputeScrollDeltasOptions = 0
): ScrollCenterDelta {
	const padding = typeof options === "number" ? options : (options.padding ?? 0);
	const forceCenter = typeof options === "object" ? Boolean(options.forceCenter) : false;
	const isZoomedH = typeof options === "object" ? options.isZoomedH : undefined;

	const isOffV = isOffScreenVertically(target, containerRect, padding);
	const isOffH = isOffScreenHorizontally(target, containerRect, padding);

	if (!forceCenter && !isOffV && !isOffH) {
		return { isOffV: false, isOffH: false, deltaX: 0, deltaY: 0 };
	}

	const targetWidth = target.width ?? (target.right - target.left);
	const targetHeight = target.height ?? (target.bottom - target.top);
	const containerWidth = containerRect.width ?? (containerRect.right - containerRect.left);
	const containerHeight = containerRect.height ?? (containerRect.bottom - containerRect.top);

	const deltaY = target.top + targetHeight / 2 - (containerRect.top + containerHeight / 2);

	const shouldCenterH = isOffH || isZoomedH === true;
	const deltaX = shouldCenterH
		? target.left + targetWidth / 2 - (containerRect.left + containerWidth / 2)
		: 0;

	return { isOffV, isOffH, deltaX, deltaY };
}

/**
 * Scrolls a scrollable container element just enough to center the target bounding box
 * if and only if any part of the target is outside the container viewport (or forceCenter is true).
 * If the target is already completely visible within the viewport, no scrolling occurs.
 *
 * @returns true if scrolling was performed, false if target was already fully visible.
 */
export function scrollTargetIntoViewIfNeeded(
	target: BoundingRectLike,
	scrollContainer: HTMLElement,
	options: ScrollTargetOptions = {}
): boolean {
	if (!scrollContainer || typeof scrollContainer.getBoundingClientRect !== "function") {
		return false;
	}

	const containerRect = scrollContainer.getBoundingClientRect();
	const padding = options.padding ?? 0;
	const forceCenter = options.forceCenter ?? false;
	const isZoomedH =
		options.isZoomedH ??
		(typeof scrollContainer.scrollWidth === "number" &&
			typeof scrollContainer.clientWidth === "number" &&
			scrollContainer.scrollWidth > scrollContainer.clientWidth + 5);

	const { isOffV, isOffH, deltaX, deltaY } = computeScrollDeltas(target, containerRect, {
		padding,
		forceCenter,
		isZoomedH,
	});

	if (!forceCenter && !isOffV && !isOffH) {
		return false;
	}

	const behavior = options.behavior ?? "smooth";
	if (typeof scrollContainer.scrollBy === "function") {
		scrollContainer.scrollBy({ left: deltaX, top: deltaY, behavior });
	} else {
		scrollContainer.scrollLeft += deltaX;
		scrollContainer.scrollTop += deltaY;
	}
	return true;
}

/**
 * For CodeMirror 6 Markdown view:
 * Checks if the match range is already visible on screen. If it is already visible,
 * suppresses scrolling completely. If it is outside the viewport (or unrendered),
 * centers it vertically, and also horizontally if off-screen horizontally (e.g. zoomed).
 */
export function scrollEditorMatchIntoView(
	view: EditorView,
	match: { from: number; to: number },
	options: ScrollTargetOptions = {}
): boolean {
	try {
		const scrollContainer = (view as any).scrollDOM || view.dom;
		if (!scrollContainer || typeof scrollContainer.getBoundingClientRect !== "function") {
			view.dispatch({
				effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), {
					y: "center",
					x: "center",
				}),
			});
			return true;
		}

		// Query coordinates of the target match position directly from the editor
		let targetBox: BoundingRectLike | null = null;
		if (typeof view.coordsAtPos === "function") {
			const startCoords = view.coordsAtPos(match.from);
			const endCoords = view.coordsAtPos(match.to) || startCoords;
			if (startCoords) {
				const top = Math.min(startCoords.top, endCoords?.top ?? startCoords.top);
				const bottom = Math.max(startCoords.bottom, endCoords?.bottom ?? startCoords.bottom);
				const left = Math.min(startCoords.left, endCoords?.left ?? startCoords.left);
				const right = Math.max(startCoords.right, endCoords?.right ?? startCoords.right);
				targetBox = {
					top,
					bottom,
					left,
					right,
					width: right - left,
					height: bottom - top,
				};
			}
		}

		// If target coordinates are known, use the shared scrollTargetIntoViewIfNeeded
		if (targetBox) {
			return scrollTargetIntoViewIfNeeded(targetBox, scrollContainer, options);
		}

		// If target is in an unrendered distant line (coordsAtPos is null),
		// fall back to EditorView.scrollIntoView to scroll the heightmap and mount the line.
		view.dispatch({
			effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), {
				y: "center",
				x: "center",
			}),
		});
		return true;
	} catch {
		view.dispatch({
			effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), {
				y: "center",
				x: "center",
			}),
		});
		return true;
	}
}

/**
 * For CodeMirror 6 EditorView: checks if a range [from, to] is off-screen vertically or horizontally.
 * If off-screen, returns a scrollIntoView effect with y/x: "center".
 * If already visible on-screen, returns a scrollIntoView effect with y/x: "nearest".
 */
export function getSmartScrollEffect(view: EditorView, from: number, to: number) {
	try {
		const scrollDOM = (view as any).scrollDOM || view.dom;
		if (!scrollDOM || typeof scrollDOM.getBoundingClientRect !== "function") {
			return EditorView.scrollIntoView(EditorSelection.range(from, to), {
				y: "center",
				x: "nearest",
			});
		}

		const viewportRect = scrollDOM.getBoundingClientRect();
		const startCoords = view.coordsAtPos(from);
		const endCoords = view.coordsAtPos(to) || startCoords;

		if (!startCoords) {
			return EditorView.scrollIntoView(EditorSelection.range(from, to), {
				y: "center",
				x: "nearest",
			});
		}

		const targetBox: BoundingRectLike = {
			top: Math.min(startCoords.top, endCoords?.top ?? startCoords.top),
			bottom: Math.max(startCoords.bottom, endCoords?.bottom ?? startCoords.bottom),
			left: Math.min(startCoords.left, endCoords?.left ?? startCoords.left),
			right: Math.max(startCoords.right, endCoords?.right ?? startCoords.right),
		};

		const isOff = isOffScreenVertically(targetBox, viewportRect) || isOffScreenHorizontally(targetBox, viewportRect);

		return EditorView.scrollIntoView(EditorSelection.range(from, to), {
			y: isOff ? "center" : "nearest",
			x: isOff ? "center" : "nearest",
		});
	} catch {
		return EditorView.scrollIntoView(EditorSelection.range(from, to), {
			y: "center",
			x: "nearest",
		});
	}
}

export interface CompoundBoundingRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
	width: number;
	height: number;
}

/**
 * Computes the unified compound bounding box of all currently selected match fragments
 * within the given container or page element.
 */
export function getCompoundMatchBoundingRect(
	containerEl: HTMLElement,
	pageEl?: HTMLElement | null
): CompoundBoundingRect | null {
	const scope = pageEl || containerEl;
	if (!scope || typeof scope.querySelectorAll !== "function") return null;

	const fragments = Array.from(
		scope.querySelectorAll<HTMLElement>(
			".highlight.selected, .highlight.is-selected, .incsearch-pdf-match.is-current"
		)
	).filter((el) => {
		if (typeof el.getBoundingClientRect !== "function") return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 || r.height > 0;
	});

	if (fragments.length === 0) return null;

	let minTop = Infinity;
	let maxBottom = -Infinity;
	let minLeft = Infinity;
	let maxRight = -Infinity;

	for (const frag of fragments) {
		const r = frag.getBoundingClientRect();
		if (r.top < minTop) minTop = r.top;
		if (r.bottom > maxBottom) maxBottom = r.bottom;
		if (r.left < minLeft) minLeft = r.left;
		if (r.right > maxRight) maxRight = r.right;
	}

	return {
		top: minTop,
		bottom: maxBottom,
		left: minLeft,
		right: maxRight,
		width: maxRight - minLeft,
		height: maxBottom - minTop,
	};
}
