import { describe, it, expect, vi, afterEach } from "vitest";
import { parseColor, getRelativeLuminance, getContrastRatio, resolveOutlineColor } from "../src/utils/colors";

describe("colors utility", () => {
	it("calculates relative luminance correctly", () => {
		// Pure black
		expect(getRelativeLuminance([0, 0, 0])).toBeCloseTo(0, 4);
		// Pure white
		expect(getRelativeLuminance([255, 255, 255])).toBeCloseTo(1, 4);
		// Red
		expect(getRelativeLuminance([255, 0, 0])).toBeCloseTo(0.2126, 4);
	});

	it("calculates contrast ratio correctly", () => {
		// Black vs White
		const whiteLum = getRelativeLuminance([255, 255, 255]);
		const blackLum = getRelativeLuminance([0, 0, 0]);
		expect(getContrastRatio(whiteLum, blackLum)).toBeCloseTo(21, 2);

		// Same color
		expect(getContrastRatio(whiteLum, whiteLum)).toBeCloseTo(1, 2);
	});
});
