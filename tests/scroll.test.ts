import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	isOffScreenVertically,
	isOffScreenHorizontally,
	isPageCompletelyOffScreen,
	computeAxisCenterDelta,
	computeScrollDeltas,
	scrollTargetIntoViewIfNeeded,
	scrollEditorMatchIntoView,
	CURRENT_MATCH_SELECTOR_PARTS,
	MATCH_ELEMENT_CLASS_TOKENS,
	NATIVE_CURRENT_MATCH_SELECTOR,
	NATIVE_CURRENT_MATCH_ALT_SELECTOR,
	PLUGIN_CURRENT_MATCH_SELECTOR,
	NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR,
	isMatchElementCandidate,
	getCompoundMatchBoundingRect,
} from "../src/utils/scroll";

describe("utils: scroll geometry", () => {
	it("correctly identifies whether an element is fully on-screen vs partially/completely off-screen vertically", () => {
		const viewport = { top: 100, bottom: 600, left: 0, right: 800 };

		// Fully inside with margin
		expect(isOffScreenVertically({ top: 200, bottom: 300, left: 10, right: 100 }, viewport)).toBe(false);

		// Partially clipped at top (top extends above viewport top + padding)
		expect(isOffScreenVertically({ top: 90, bottom: 150, left: 10, right: 100 }, viewport)).toBe(true);

		// Partially clipped at bottom (bottom extends past viewport bottom - padding, matching user's screenshot)
		expect(isOffScreenVertically({ top: 580, bottom: 605, left: 10, right: 100 }, viewport)).toBe(true);

		// Completely above
		expect(isOffScreenVertically({ top: 50, bottom: 90, left: 10, right: 100 }, viewport)).toBe(true);

		// Completely below
		expect(isOffScreenVertically({ top: 610, bottom: 700, left: 10, right: 100 }, viewport)).toBe(true);
	});

	it("correctly identifies whether an element is fully on-screen vs partially/completely off-screen horizontally", () => {
		const viewport = { top: 100, bottom: 600, left: 0, right: 800 };

		// Fully inside with margin
		expect(isOffScreenHorizontally({ top: 200, bottom: 300, left: 50, right: 200 }, viewport)).toBe(false);

		// Partially clipped at left (left extends past viewport left + padding)
		expect(isOffScreenHorizontally({ top: 200, bottom: 300, left: -10, right: 100 }, viewport)).toBe(true);

		// Partially clipped at right (right extends past viewport right - padding)
		expect(isOffScreenHorizontally({ top: 200, bottom: 300, left: 750, right: 820 }, viewport)).toBe(true);

		// Completely to the left
		expect(isOffScreenHorizontally({ top: 200, bottom: 300, left: -200, right: -50 }, viewport)).toBe(true);

		// Completely to the right
		expect(isOffScreenHorizontally({ top: 200, bottom: 300, left: 850, right: 950 }, viewport)).toBe(true);
	});

	it("correctly identifies whether a tall page is completely off-screen", () => {
		const viewport = { top: 100, bottom: 600, left: 0, right: 800 };

		// Page spans through viewport (top at 0, bottom at 1000)
		expect(isPageCompletelyOffScreen({ top: 0, bottom: 1000, left: 0, right: 800 }, viewport)).toBe(false);

		// Top of page is visible in bottom half of viewport (top at 400, bottom at 1400)
		expect(isPageCompletelyOffScreen({ top: 400, bottom: 1400, left: 0, right: 800 }, viewport)).toBe(false);

		// Bottom of page is visible in top half of viewport (top at -500, bottom at 300)
		expect(isPageCompletelyOffScreen({ top: -500, bottom: 300, left: 0, right: 800 }, viewport)).toBe(false);

		// Completely above
		expect(isPageCompletelyOffScreen({ top: -1000, bottom: 50, left: 0, right: 800 }, viewport)).toBe(true);

		// Completely below
		expect(isPageCompletelyOffScreen({ top: 650, bottom: 1650, left: 0, right: 800 }, viewport)).toBe(true);
	});

	it("correctly computes the axis center delta (canonical centering formula)", () => {
		// target: start 400, size 20 -> center 410
		// container: start 100, size 500 -> center 350
		// delta = 410 - 350 = 60
		const delta = computeAxisCenterDelta(400, 20, 100, 500);
		expect(delta).toBe(60);
	});

	it("correctly computes scroll deltas via computeScrollDeltas", () => {
		const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };

		// 1. Fully in-view: neither axis off-screen, both deltas 0
		const inViewTarget = { top: 200, bottom: 220, left: 100, right: 200, width: 100, height: 20 };
		const resInView = computeScrollDeltas(inViewTarget, containerRect);
		expect(resInView.isOffV).toBe(false);
		expect(resInView.isOffH).toBe(false);
		expect(resInView.deltaX).toBe(0);
		expect(resInView.deltaY).toBe(0);

		// 2. Off-screen vertically only (clipped at bottom: top 590, bottom 610, height 20 -> center 600)
		// Container center: 100 + 250 = 350 -> deltaY = 600 - 350 = 250
		const offVTarget = { top: 590, bottom: 610, left: 100, right: 200, width: 100, height: 20 };
		const resOffV = computeScrollDeltas(offVTarget, containerRect);
		expect(resOffV.isOffV).toBe(true);
		expect(resOffV.isOffH).toBe(false);
		expect(resOffV.deltaX).toBe(0);
		expect(resOffV.deltaY).toBe(250);

		// 3. Off-screen horizontally only (clipped at right: left 780, right 850, width 70 -> center 815)
		// Container center: 0 + 400 = 400 -> deltaX = 815 - 400 = 415
		// Because the target is off-screen, it also centers vertically:
		// Target vertical center: 200 + 10 = 210, Container vertical center: 100 + 250 = 350 -> deltaY = 210 - 350 = -140
		const offHTarget = { top: 200, bottom: 220, left: 780, right: 850, width: 70, height: 20 };
		const resOffH = computeScrollDeltas(offHTarget, containerRect);
		expect(resOffH.isOffV).toBe(false);
		expect(resOffH.isOffH).toBe(true);
		expect(resOffH.deltaX).toBe(415);
		expect(resOffH.deltaY).toBe(-140);

		// 4. Off-screen both vertically and horizontally
		const offBothTarget = { top: 590, bottom: 610, left: 780, right: 850, width: 70, height: 20 };
		const resOffBoth = computeScrollDeltas(offBothTarget, containerRect);
		expect(resOffBoth.isOffV).toBe(true);
		expect(resOffBoth.isOffH).toBe(true);
		expect(resOffBoth.deltaX).toBe(415);
		expect(resOffBoth.deltaY).toBe(250);

		// 5. Target in-view but forceCenter is true -> centers vertically (and horizontally if zoomed)
		const resForceNotZoomed = computeScrollDeltas(inViewTarget, containerRect, { forceCenter: true });
		expect(resForceNotZoomed.deltaX).toBe(0);
		expect(resForceNotZoomed.deltaY).toBe(-140);

		const resForceZoomed = computeScrollDeltas(inViewTarget, containerRect, { forceCenter: true, isZoomedH: true });
		expect(resForceZoomed.deltaX).toBe(-250);
		expect(resForceZoomed.deltaY).toBe(-140);
	});

	it("scrollTargetIntoViewIfNeeded suppresses scrolling when target is already visible and scrolls when off-screen", () => {
		const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
		const scrollBySpy = vi.fn();
		const mockContainer = {
			getBoundingClientRect: () => containerRect,
			scrollBy: scrollBySpy,
			scrollLeft: 0,
			scrollTop: 0,
		} as any;

		// 1. Target already visible -> returns false, no scrollBy call
		const inViewTarget = { top: 200, bottom: 220, left: 100, right: 200, width: 100, height: 20 };
		const inViewResult = scrollTargetIntoViewIfNeeded(inViewTarget, mockContainer);
		expect(inViewResult).toBe(false);
		expect(scrollBySpy).not.toHaveBeenCalled();

		// 2. Target off-screen vertically -> returns true, scrolls deltaY
		const offVTarget = { top: 590, bottom: 610, left: 100, right: 200, width: 100, height: 20 };
		const offVResult = scrollTargetIntoViewIfNeeded(offVTarget, mockContainer);
		expect(offVResult).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: 0,
			top: 250,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		// 3. Target off-screen horizontally -> returns true, scrolls deltaX and deltaY (centering both axes)
		const offHTarget = { top: 200, bottom: 220, left: 780, right: 850, width: 70, height: 20 };
		const offHResult = scrollTargetIntoViewIfNeeded(offHTarget, mockContainer);
		expect(offHResult).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: 415,
			top: -140,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		// 4. Target off-screen both -> returns true, scrolls both
		const offBothTarget = { top: 590, bottom: 610, left: 780, right: 850, width: 70, height: 20 };
		const offBothResult = scrollTargetIntoViewIfNeeded(offBothTarget, mockContainer);
		expect(offBothResult).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: 415,
			top: 250,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		// 5. Target in-view but forceCenter is true -> scrolls vertically (and horizontally if isZoomedH is true)
		const forceCenterResult = scrollTargetIntoViewIfNeeded(inViewTarget, mockContainer, { forceCenter: true });
		expect(forceCenterResult).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: 0,
			top: -140,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		const forceCenterZoomedResult = scrollTargetIntoViewIfNeeded(inViewTarget, mockContainer, { forceCenter: true, isZoomedH: true });
		expect(forceCenterZoomedResult).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: -250,
			top: -140,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		// 6. Target off-screen vertically with isZoomedH: true -> centers horizontally too
		const offVZoomedResult = scrollTargetIntoViewIfNeeded(offVTarget, mockContainer, { isZoomedH: true });
		expect(offVZoomedResult).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: -250,
			top: 250,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		// 5. Fallback when scrollBy is not available
		const fallbackContainer = {
			getBoundingClientRect: () => containerRect,
			scrollLeft: 10,
			scrollTop: 20,
		} as any;
		const fallbackResult = scrollTargetIntoViewIfNeeded(offBothTarget, fallbackContainer);
		expect(fallbackResult).toBe(true);
		expect(fallbackContainer.scrollLeft).toBe(10 + 415);
		expect(fallbackContainer.scrollTop).toBe(20 + 250);
	});

	it("scrollEditorMatchIntoView suppresses scroll when match coords are on-screen and centers when off-screen", () => {
		const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
		const scrollBySpy = vi.fn();
		const dispatchSpy = vi.fn();

		const scrollDOM = {
			getBoundingClientRect: () => containerRect,
			scrollBy: scrollBySpy,
			scrollLeft: 0,
			scrollTop: 0,
		};

		// Mock EditorView with on-screen match
		const mockViewOnScreen: any = {
			scrollDOM,
			dom: {
				querySelector: () => null,
			},
			coordsAtPos: (pos: number) => ({
				top: 200,
				bottom: 220,
				left: pos === 5 ? 50 : 100,
				right: pos === 5 ? 100 : 150,
			}),
			dispatch: dispatchSpy,
		};

		const resOnScreen = scrollEditorMatchIntoView(mockViewOnScreen, { from: 5, to: 10 });
		expect(resOnScreen).toBe(false);
		expect(scrollBySpy).not.toHaveBeenCalled();
		expect(dispatchSpy).not.toHaveBeenCalled();

		// Mock EditorView with off-screen vertical match
		const mockViewOffV: any = {
			scrollDOM,
			dom: {
				querySelector: () => null,
			},
			coordsAtPos: (pos: number) => ({
				top: 590,
				bottom: 610,
				left: pos === 5 ? 50 : 150,
				right: pos === 5 ? 150 : 200,
			}),
			dispatch: dispatchSpy,
		};

		const resOffV = scrollEditorMatchIntoView(mockViewOffV, { from: 5, to: 10 });
		expect(resOffV).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: 0,
			top: 250,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		// Mock EditorView with off-screen horizontal match (e.g. zoomed note)
		const mockViewOffH: any = {
			scrollDOM,
			dom: {
				querySelector: () => null,
			},
			coordsAtPos: (pos: number) => ({
				top: 200,
				bottom: 220,
				left: 780,
				right: 850,
			}),
			dispatch: dispatchSpy,
		};

		const resOffH = scrollEditorMatchIntoView(mockViewOffH, { from: 5, to: 10 });
		expect(resOffH).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: 415,
			top: -140,
			behavior: "smooth",
		});
		scrollBySpy.mockClear();

		// Mock EditorView with unrendered match (coordsAtPos returns null) -> falls back to CM6 scrollIntoView dispatch
		const mockViewUnrendered: any = {
			scrollDOM,
			dom: {
				querySelector: () => null,
			},
			coordsAtPos: () => null,
			dispatch: dispatchSpy,
		};

		const resUnrendered = scrollEditorMatchIntoView(mockViewUnrendered, { from: 500, to: 510 });
		expect(resUnrendered).toBe(true);
		expect(dispatchSpy).toHaveBeenCalled();
		dispatchSpy.mockClear();

		// Mock EditorView with stale on-screen element in DOM, but target coords are off-screen
		const mockViewStaleEl: any = {
			scrollDOM,
			dom: {
				querySelector: () => ({
					getBoundingClientRect: () => ({ top: 200, bottom: 220, left: 50, right: 150, width: 100, height: 20 }),
				}),
			},
			coordsAtPos: () => ({
				top: 590,
				bottom: 610,
				left: 50,
				right: 150,
			}),
			dispatch: dispatchSpy,
		};

		const resStale = scrollEditorMatchIntoView(mockViewStaleEl, { from: 50, to: 60 });
		expect(resStale).toBe(true);
		expect(scrollBySpy).toHaveBeenCalledWith({
			left: 0,
			top: 250,
			behavior: "smooth",
		});
	});
});

describe("utils: scroll canonical current-match selectors", () => {
	// These tests exist so that editing one copy of the "current match" class list
	// without updating the others (see the comment block above CURRENT_MATCH_SELECTOR
	// in src/utils/scroll.ts) fails the suite instead of silently reintroducing drift
	// between the several PDF consumers that must agree on "which element is current".

	it("builds CURRENT_MATCH_SELECTOR from exactly its three documented parts", () => {
		expect(CURRENT_MATCH_SELECTOR_PARTS).toEqual([
			NATIVE_CURRENT_MATCH_SELECTOR,
			NATIVE_CURRENT_MATCH_ALT_SELECTOR,
			PLUGIN_CURRENT_MATCH_SELECTOR,
		]);
		expect(NATIVE_CURRENT_MATCH_SELECTOR).toBe(".highlight.selected");
		expect(NATIVE_CURRENT_MATCH_ALT_SELECTOR).toBe(".highlight.is-selected");
		expect(PLUGIN_CURRENT_MATCH_SELECTOR).toBe(".incsearch-pdf-match.is-current");
	});

	it("scopes NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR to both textLayer class spellings", () => {
		expect(NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR).toBe(
			".textLayer .highlight.selected, .text-layer .highlight.selected"
		);
	});

	it("keeps MATCH_ELEMENT_CLASS_TOKENS as bare tokens drawn from CURRENT_MATCH_SELECTOR_PARTS", () => {
		// isMatchElementCandidate's broad OR-guard must never test for a class that isn't
		// part of the canonical selector union, or it could treat an unrelated element as
		// a match candidate; and every token it tests must actually appear somewhere in the
		// canonical parts, or a real current-match element could stop being recognized.
		const canonicalTokens = new Set(
			CURRENT_MATCH_SELECTOR_PARTS.flatMap((part) => part.replace(/^\./, "").split("."))
		);
		for (const token of MATCH_ELEMENT_CLASS_TOKENS) {
			expect(canonicalTokens.has(token)).toBe(true);
		}
	});

	it("isMatchElementCandidate recognizes every canonical current-match class shape", () => {
		const makeEl = (...classes: string[]) =>
			({
				classList: { contains: (c: string) => classes.includes(c) } as unknown as DOMTokenList,
			}) as { classList: DOMTokenList };
		expect(isMatchElementCandidate(makeEl("highlight", "selected"))).toBe(true);
		expect(isMatchElementCandidate(makeEl("incsearch-pdf-match", "is-current"))).toBe(true);
		expect(isMatchElementCandidate(makeEl("unrelated-class"))).toBe(false);
		expect(isMatchElementCandidate(null)).toBe(false);
		expect(isMatchElementCandidate(undefined)).toBe(false);
	});

	it("getCompoundMatchBoundingRect queries elements using the canonical selector union", () => {
		const querySelectorAll = vi.fn().mockReturnValue([]);
		const containerEl: any = { querySelectorAll };
		getCompoundMatchBoundingRect(containerEl);
		expect(querySelectorAll).toHaveBeenCalledWith(
			CURRENT_MATCH_SELECTOR_PARTS.join(", ")
		);
	});

	// The three tests above only guard scroll.ts's own constants against internal drift.
	// They do NOT prove any consumer actually imports and uses those constants instead of
	// re-spelling ".highlight.selected" (etc.) inline. This static source scan closes that
	// gap: it fails if a future edit reintroduces a hardcoded copy of the selector in any
	// file under src/pdf/, which is exactly the bug this consolidation fixed.
	//
	// The scanned directory and the checked class fragments are both derived at runtime
	// (readdirSync + the exported selector parts) rather than hand-maintained, so this
	// guard cannot silently go stale by missing a new src/pdf/ file or a new selector part
	// the way a hardcoded file list or hardcoded regex could.
	it("never re-inlines a hardcoded current-match class string in src/pdf/**", () => {
		const pdfDir = join(__dirname, "..", "src", "pdf");
		const filesToScan = readdirSync(pdfDir).filter((f) => f.endsWith(".ts"));
		expect(filesToScan.length).toBeGreaterThan(0);

		// Build one pattern per selector part's state-bearing class fragment (e.g.
		// "highlight.selected", "highlight.is-selected", "incsearch-pdf-match.is-current"),
		// matched as a dotted class chain so it still catches the fragment inside a longer
		// selector string (e.g. ".textLayer .highlight.selected").
		const fragments = CURRENT_MATCH_SELECTOR_PARTS.map((part) =>
			part.replace(/^\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		);
		const inlineSelectorPattern = new RegExp(
			`["'\`][^"'\`]*(?:${fragments.join("|")})[^"'\`]*["'\`]`
		);

		for (const file of filesToScan) {
			const contents = readFileSync(join(pdfDir, file), "utf8");
			expect(
				inlineSelectorPattern.test(contents),
				`${file} appears to hardcode a current-match selector string instead of importing ` +
					`it from src/utils/scroll.ts (NATIVE_CURRENT_MATCH_SELECTOR / ` +
					`NATIVE_CURRENT_MATCH_IN_TEXT_LAYER_SELECTOR / PLUGIN_CURRENT_MATCH_SELECTOR / ` +
					`CURRENT_MATCH_SELECTOR).`
			).toBe(false);
		}
	});
});
