import { describe, it, expect } from "vitest";
import {
	isOffScreenVertically,
	isOffScreenHorizontally,
	isPageCompletelyOffScreen,
	computeVerticalCenterDelta,
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

	it("correctly computes vertical center delta", () => {
		// target: top 400, height 20 -> center 410
		// container: top 100, height 500 -> center 350
		// delta = 410 - 350 = 60
		const delta = computeVerticalCenterDelta(400, 20, 100, 500);
		expect(delta).toBe(60);
	});
});
