import { describe, it, expect, beforeEach } from "vitest";
import {
	parseCssColor,
	composite,
	relativeLuminance,
	contrastRatio,
	toCssRgba,
	isMonochrome,
	ensurePerceptibleAccent,
	chooseAccent,
	calculateSecondaryAlphas,
	textRemainsReadable,
	buildSecondaryStyle,
	getAppearanceCacheKey,
	invalidateAppearanceCache,
	getOrComputeSecondaryStyle,
	resolveAllCssVariables,
	MeasuredAppearance,
} from "../src/utils/adaptive-highlight";

describe("adaptive-highlight module", () => {
	beforeEach(() => {
		invalidateAppearanceCache();
		document.body.className = "";
	});

	describe("parseCssColor", () => {
		it("parses transparent and empty values", () => {
			expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
			expect(parseCssColor("")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
			expect(parseCssColor(null)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
		});

		it("parses 3-digit and 6-digit hex colors", () => {
			expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(parseCssColor("#000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			expect(parseCssColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(parseCssColor("#1e1e1e")).toEqual({ r: 30, g: 30, b: 30, a: 1 });
		});

		it("parses 4-digit and 8-digit hex colors with alpha", () => {
			const parsed4 = parseCssColor("#ff08");
			expect(parsed4.r).toBe(255);
			expect(parsed4.g).toBe(255);
			expect(parsed4.b).toBe(0);
			expect(parsed4.a).toBeCloseTo(0.533, 2);

			const parsed8 = parseCssColor("#1e1e1e80");
			expect(parsed8.r).toBe(30);
			expect(parsed8.g).toBe(30);
			expect(parsed8.b).toBe(30);
			expect(parsed8.a).toBeCloseTo(0.502, 2);
		});

		it("parses rgb and rgba strings", () => {
			expect(parseCssColor("rgb(100, 150, 200)")).toEqual({ r: 100, g: 150, b: 200, a: 1 });
			expect(parseCssColor("rgba(100, 150, 200, 0.5)")).toEqual({ r: 100, g: 150, b: 200, a: 0.5 });
			expect(parseCssColor("rgba(100 150 200 / 80%)")).toEqual({ r: 100, g: 150, b: 200, a: 0.8 });
		});

		it("parses hsl and hsla strings directly", () => {
			const hslTeal = parseCssColor("hsl(175, 57%, 33%)");
			expect(hslTeal.r).toBeCloseTo(36, -1);
			expect(hslTeal.g).toBeCloseTo(132, -1);
			expect(hslTeal.b).toBeCloseTo(124, -1);
			expect(hslTeal.a).toBe(1);

			const hsla = parseCssColor("hsla(45, 100%, 50%, 0.75)");
			expect(hsla.r).toBe(255);
			expect(hsla.g).toBeCloseTo(191, -1);
			expect(hsla.b).toBe(0);
			expect(hsla.a).toBe(0.75);
		});

		it("cleans !important and trailing semicolons", () => {
			expect(parseCssColor("#24837b !important;")).toEqual({ r: 36, g: 131, b: 123, a: 1 });
			expect(parseCssColor("rgba(100, 150, 200, 0.5) !important")).toEqual({ r: 100, g: 150, b: 200, a: 0.5 });
		});
	});

	describe("resolveAllCssVariables", () => {
		it("resolves basic variables", () => {
			expect(resolveAllCssVariables("#ffffff")).toBe("#ffffff");
			expect(resolveAllCssVariables("var(--not-existing, #123456)")).toBe("#123456");
		});
	});

	describe("color math and contrast", () => {
		it("composites foreground over background correctly", () => {
			const fg = { r: 255, g: 255, b: 255, a: 0.5 };
			const bg = { r: 0, g: 0, b: 0, a: 1 };
			const comp = composite(fg, bg);
			expect(comp.r).toBeCloseTo(127.5, 1);
			expect(comp.g).toBeCloseTo(127.5, 1);
			expect(comp.b).toBeCloseTo(127.5, 1);
			expect(comp.a).toBe(1);
		});

		it("calculates WCAG relative luminance", () => {
			expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 4);
			expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 4);
		});

		it("calculates contrast ratios", () => {
			const white = { r: 255, g: 255, b: 255, a: 1 };
			const black = { r: 0, g: 0, b: 0, a: 1 };
			expect(contrastRatio(white, black)).toBeCloseTo(21, 1);
			expect(contrastRatio(white, white)).toBeCloseTo(1, 1);
		});

		it("formats toCssRgba", () => {
			expect(toCssRgba({ r: 100, g: 150, b: 200, a: 0.75 })).toBe("rgba(100, 150, 200, 0.75)");
		});

		it("identifies monochrome colors", () => {
			expect(isMonochrome({ r: 255, g: 255, b: 255, a: 1 })).toBe(true);
			expect(isMonochrome({ r: 30, g: 30, b: 30, a: 1 })).toBe(true);
			expect(isMonochrome({ r: 112, g: 93, b: 207, a: 1 })).toBe(false);
		});
	});

	describe("ensurePerceptibleAccent", () => {
		const pitchBlackBg = { r: 0, g: 0, b: 0, a: 1 };
		const warmCreamBg = { r: 255, g: 252, b: 240, a: 1 }; // Flexoki Warm Paper #FFFCF0

		it("lifts dark accent colors for dark backgrounds", () => {
			const darkPurple = { r: 112, g: 93, b: 207, a: 1 };
			const lifted = ensurePerceptibleAccent(darkPurple, pitchBlackBg, true);
			expect(relativeLuminance(lifted)).toBeGreaterThan(0.3);
			expect(lifted.b).toBe(255);
		});

		it("keeps white/monochrome accents bright on dark backgrounds", () => {
			const white = { r: 255, g: 255, b: 255, a: 1 };
			const res = ensurePerceptibleAccent(white, pitchBlackBg, true);
			expect(res.r).toBe(255);
			expect(res.g).toBe(255);
			expect(res.b).toBe(255);
		});

		it("deepens pale yellow highlights for warm light paper", () => {
			const paleYellow = { r: 255, g: 224, b: 102, a: 1 }; // #ffe066
			const deepened = ensurePerceptibleAccent(paleYellow, warmCreamBg, false);
			expect(relativeLuminance(deepened)).toBeLessThan(0.4);
			expect(Math.max(deepened.r, deepened.g, deepened.b)).toBeLessThanOrEqual(185);
		});

		it("preserves saturated chromatic accents for warm light paper", () => {
			const flexokiTeal = { r: 36, g: 131, b: 123, a: 1 }; // #24837B
			const res = ensurePerceptibleAccent(flexokiTeal, warmCreamBg, false);
			expect(res.r).toBe(36);
			expect(res.g).toBe(131);
			expect(res.b).toBe(123);
		});
	});

	describe("chooseAccent fallback hierarchy", () => {
		const darkBg = { r: 0, g: 0, b: 0, a: 1 };
		const lightBg = { r: 255, g: 255, b: 255, a: 1 };

		it("prefers current chromatic fill if distinguishable from appBackground", () => {
			const appearance: MeasuredAppearance = {
				mode: "dark",
				appBackground: darkBg,
				normalText: { r: 220, g: 220, b: 220, a: 1 },
				currentFill: { r: 255, g: 200, b: 0, a: 1 },
				currentText: { r: 0, g: 0, b: 0, a: 1 },
				currentBox: {
					source: "outline",
					color: { r: 100, g: 100, b: 255, a: 1 },
					thicknessPx: 2,
					raw: "2px solid",
				},
				themeAccent: { r: 112, g: 93, b: 207, a: 1 },
				themeHighlightBg: null,
			};
			const accent = chooseAccent(appearance);
			expect(accent.r).toBe(255);
			expect(accent.g).toBe(200);
		});

		it("prefers chromatic themeAccent if currentBox is monochrome white", () => {
			const appearance: MeasuredAppearance = {
				mode: "dark",
				appBackground: darkBg,
				normalText: { r: 220, g: 220, b: 220, a: 1 },
				currentFill: { r: 0, g: 0, b: 0, a: 0 },
				currentText: { r: 220, g: 220, b: 220, a: 1 },
				currentBox: {
					source: "outline",
					color: { r: 255, g: 255, b: 255, a: 1 },
					thicknessPx: 2,
					raw: "2px solid",
				},
				themeAccent: { r: 112, g: 93, b: 207, a: 1 }, // chromatic purple
				themeHighlightBg: null,
			};
			const accent = chooseAccent(appearance);
			expect(accent.r).toBe(112);
			expect(accent.g).toBe(93);
			expect(accent.b).toBe(207);
		});

		it("uses monochrome box outline when theme accent is absent or monochrome", () => {
			const appearance: MeasuredAppearance = {
				mode: "dark",
				appBackground: darkBg,
				normalText: { r: 220, g: 220, b: 220, a: 1 },
				currentFill: { r: 0, g: 0, b: 0, a: 0 },
				currentText: { r: 220, g: 220, b: 220, a: 1 },
				currentBox: {
					source: "outline",
					color: { r: 255, g: 255, b: 255, a: 1 },
					thicknessPx: 2,
					raw: "2px solid",
				},
				themeAccent: { r: 255, g: 255, b: 255, a: 1 },
				themeHighlightBg: null,
			};
			const accent = chooseAccent(appearance);
			expect(accent).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		});

		it("falls back to adaptive neutral when all signals match background", () => {
			const darkAppearance: MeasuredAppearance = {
				mode: "dark",
				appBackground: darkBg,
				normalText: darkBg,
				currentFill: { r: 0, g: 0, b: 0, a: 0 },
				currentText: darkBg,
				currentBox: { source: "none", color: null, thicknessPx: null, raw: "" },
				themeAccent: null,
				themeHighlightBg: null,
			};
			expect(chooseAccent(darkAppearance)).toEqual({ r: 255, g: 255, b: 255, a: 1 });

			const lightAppearance: MeasuredAppearance = {
				mode: "light",
				appBackground: lightBg,
				normalText: lightBg,
				currentFill: { r: 0, g: 0, b: 0, a: 0 },
				currentText: lightBg,
				currentBox: { source: "none", color: null, thicknessPx: null, raw: "" },
				themeAccent: null,
				themeHighlightBg: null,
			};
			expect(chooseAccent(lightAppearance)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
		});
	});

	describe("calculateSecondaryAlphas", () => {
		it("provides high-contrast, scalable alphas for dark themes across prominence range", () => {
			const low = calculateSecondaryAlphas(0.2, true);
			expect(low.fillAlpha).toBeCloseTo(0.21, 2);
			expect(low.edgeAlpha).toBeCloseTo(0.46, 2);

			const mid = calculateSecondaryAlphas(0.75, true);
			expect(mid.fillAlpha).toBeCloseTo(0.375, 2);
			expect(mid.edgeAlpha).toBeCloseTo(0.763, 2);

			const high = calculateSecondaryAlphas(1.0, true);
			expect(high.fillAlpha).toBeCloseTo(0.45, 2);
			expect(high.edgeAlpha).toBeCloseTo(0.9, 2);
		});

		it("provides smooth scaling for light/warm themes across prominence range", () => {
			const low = calculateSecondaryAlphas(0.2, false);
			expect(low.fillAlpha).toBeCloseTo(0.116, 2);

			const mid = calculateSecondaryAlphas(0.75, false);
			expect(mid.fillAlpha).toBeCloseTo(0.215, 2);

			const high = calculateSecondaryAlphas(1.0, false);
			expect(high.fillAlpha).toBeCloseTo(0.26, 2);
		});
	});

	describe("Flexoki Warm Light and warm cream themes", () => {
		it("produces visible highlights with Flexoki Teal on warm paper (#FFFCF0)", () => {
			const flexokiLight: MeasuredAppearance = {
				mode: "light",
				appBackground: { r: 255, g: 252, b: 240, a: 1 }, // Warm Paper
				normalText: { r: 16, g: 15, b: 15, a: 1 }, // Flexoki Black
				currentFill: { r: 0, g: 0, b: 0, a: 0 },
				currentText: { r: 16, g: 15, b: 15, a: 1 },
				currentBox: {
					source: "outline",
					color: { r: 36, g: 131, b: 123, a: 1 },
					thicknessPx: 2,
					raw: "2px solid",
				},
				themeAccent: { r: 36, g: 131, b: 123, a: 1 },
				themeHighlightBg: null,
			};

			const style = buildSecondaryStyle(flexokiLight, { secondaryHighlightStyle: "adaptive" });
			expect(style.mode).toBe("light");
			expect(style.useUnderline).toBe(false);
			expect(style.fillCss).toMatch(/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\.\d+\)$/);
			expect(style.edgeCss).toMatch(/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\.\d+\)$/);

			const fillMatch = style.fillCss.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
			expect(fillMatch).not.toBeNull();
			const alpha = parseFloat(fillMatch![4]);
			expect(alpha).toBeGreaterThanOrEqual(0.15);

			const r = parseInt(fillMatch![1], 10);
			const g = parseInt(fillMatch![2], 10);
			const b = parseInt(fillMatch![3], 10);
			const compR = r * alpha + 255 * (1 - alpha);
			const compG = g * alpha + 252 * (1 - alpha);
			const compB = b * alpha + 240 * (1 - alpha);

			const maxDiff = Math.max(
				Math.abs(compR - 255),
				Math.abs(compG - 252),
				Math.abs(compB - 240)
			);
			expect(maxDiff).toBeGreaterThanOrEqual(25);
		});

		it("produces visible highlights with Flexoki Yellow (#AD8301) on warm paper (#F2F0E5)", () => {
			const flexokiYellow: MeasuredAppearance = {
				mode: "light",
				appBackground: { r: 242, g: 240, b: 229, a: 1 }, // Warm base
				normalText: { r: 16, g: 15, b: 15, a: 1 },
				currentFill: { r: 0, g: 0, b: 0, a: 0 },
				currentText: { r: 16, g: 15, b: 15, a: 1 },
				currentBox: {
					source: "outline",
					color: { r: 173, g: 131, b: 1, a: 1 },
					thicknessPx: 2,
					raw: "2px solid",
				},
				themeAccent: { r: 173, g: 131, b: 1, a: 1 },
				themeHighlightBg: null,
			};

			const style = buildSecondaryStyle(flexokiYellow, { secondaryHighlightStyle: "adaptive" });
			expect(style.fillCss).not.toBe("transparent");

			const fillMatch = style.fillCss.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
			expect(fillMatch).not.toBeNull();
			const alpha = parseFloat(fillMatch![4]);
			const b = parseInt(fillMatch![3], 10);
			const compB = b * alpha + 229 * (1 - alpha);
			expect(Math.abs(compB - 229)).toBeGreaterThanOrEqual(30);
		});
	});

	describe("dark themes with black backgrounds (#000000) and Obsidian dark (#1e1e1e)", () => {
		const pitchBlackAppearance: MeasuredAppearance = {
			mode: "dark",
			appBackground: { r: 0, g: 0, b: 0, a: 1 }, // Pure black
			normalText: { r: 220, g: 220, b: 220, a: 1 },
			currentFill: { r: 0, g: 0, b: 0, a: 0 },
			currentText: { r: 220, g: 220, b: 220, a: 1 },
			currentBox: {
				source: "outline",
				color: { r: 255, g: 255, b: 255, a: 1 },
				thicknessPx: 2,
				raw: "2px solid",
			},
			themeAccent: { r: 112, g: 93, b: 207, a: 1 }, // Purple accent
			themeHighlightBg: { r: 255, g: 224, b: 102, a: 1 },
		};

		it("produces strong, clearly distinguishable fill and edge on pure black background", () => {
			const style = buildSecondaryStyle(pitchBlackAppearance, { secondaryHighlightStyle: "adaptive" });
			expect(style.mode).toBe("dark");
			expect(style.useUnderline).toBe(false);
			expect(style.fillCss).toMatch(/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\.\d+\)$/);
			expect(style.edgeCss).toMatch(/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\.\d+\)$/);

			const fillMatch = style.fillCss.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
			expect(fillMatch).not.toBeNull();
			const alpha = parseFloat(fillMatch![4]);
			expect(alpha).toBeGreaterThanOrEqual(0.35);

			const r = parseInt(fillMatch![1], 10);
			const g = parseInt(fillMatch![2], 10);
			const b = parseInt(fillMatch![3], 10);
			const maxRenderedChannel = Math.max(r, g, b) * alpha;
			expect(maxRenderedChannel).toBeGreaterThanOrEqual(60);
		});

		it("produces high contrast when prominence is turned to 1.0 (100%)", () => {
			const style = buildSecondaryStyle(pitchBlackAppearance, {
				secondaryHighlightStyle: "adaptive",
				secondaryProminence: 1.0,
			});
			const fillMatch = style.fillCss.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
			expect(fillMatch).not.toBeNull();
			const alpha = parseFloat(fillMatch![4]);
			expect(alpha).toBeCloseTo(0.45, 2);

			const edgeMatch = style.edgeCss.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
			expect(edgeMatch).not.toBeNull();
			const edgeAlpha = parseFloat(edgeMatch![4]);
			expect(edgeAlpha).toBeCloseTo(0.90, 2);
		});

		it("produces clean monochrome badges on pure black background with monochrome theme", () => {
			const monochromeAppearance: MeasuredAppearance = {
				...pitchBlackAppearance,
				themeAccent: { r: 255, g: 255, b: 255, a: 1 },
				themeHighlightBg: null,
			};
			const style = buildSecondaryStyle(monochromeAppearance, { secondaryHighlightStyle: "adaptive" });
			expect(style.fillCss).toContain("rgba(255, 255, 255,");
			expect(style.edgeCss).toContain("rgba(255, 255, 255,");
		});
	});

	describe("buildSecondaryStyle across styles", () => {
		const measuredDark: MeasuredAppearance = {
			mode: "dark",
			appBackground: { r: 30, g: 30, b: 30, a: 1 },
			normalText: { r: 220, g: 220, b: 220, a: 1 },
			currentFill: { r: 0, g: 0, b: 0, a: 0 },
			currentText: { r: 220, g: 220, b: 220, a: 1 },
			currentBox: {
				source: "outline",
				color: { r: 112, g: 93, b: 207, a: 1 },
				thicknessPx: 2,
				raw: "2px solid",
			},
			themeAccent: { r: 112, g: 93, b: 207, a: 1 },
			themeHighlightBg: { r: 255, g: 224, b: 102, a: 1 },
		};

		it("builds adaptive style with fill and edge", () => {
			const style = buildSecondaryStyle(measuredDark, { secondaryHighlightStyle: "adaptive" });
			expect(style.mode).toBe("dark");
			expect(style.fillCss).not.toBe("transparent");
			expect(style.edgeCss).not.toBe("transparent");
			expect(style.useUnderline).toBe(false);
		});

		it("builds underline-only style", () => {
			const style = buildSecondaryStyle(measuredDark, { secondaryHighlightStyle: "underline" });
			expect(style.fillCss).toBe("transparent");
			expect(style.useUnderline).toBe(true);
			expect(style.edgeCss).not.toBe("transparent");
		});

		it("builds tint-only style without edge", () => {
			const style = buildSecondaryStyle(measuredDark, { secondaryHighlightStyle: "tint" });
			expect(style.fillCss).not.toBe("transparent");
			expect(style.edgeCss).toBe("transparent");
			expect(style.useUnderline).toBe(false);
		});

		it("builds theme-default style", () => {
			const style = buildSecondaryStyle(measuredDark, { secondaryHighlightStyle: "theme" });
			expect(style.fillCss).toContain("rgba(");
			expect(style.useUnderline).toBe(false);
		});

		it("builds custom color style", () => {
			const style = buildSecondaryStyle(measuredDark, {
				secondaryHighlightStyle: "custom",
				secondaryCustomDarkColor: "#61afef",
			});
			expect(style.fillCss).toContain("rgba(");
			expect(style.edgeCss).toContain("rgba(");
		});
	});

	describe("caching and CSS application", () => {
		it("generates stable cache keys", () => {
			const k1 = getAppearanceCacheKey({
				secondaryHighlightStyle: "adaptive",
				secondaryProminence: 0.75,
			});
			const k2 = getAppearanceCacheKey({
				secondaryHighlightStyle: "adaptive",
				secondaryProminence: 0.75,
			});
			expect(k1).toBe(k2);

			const k3 = getAppearanceCacheKey({
				secondaryHighlightStyle: "underline",
				secondaryProminence: 0.5,
			});
			expect(k1).not.toBe(k3);
		});

		it("computes, caches, and applies secondary styles to DOM", () => {
			const style = getOrComputeSecondaryStyle({ secondaryHighlightStyle: "adaptive" });
			expect(style).toBeDefined();
			expect(document.body.style.getPropertyValue("--incsearch-secondary-fill")).toBe(style.fillCss);
			expect(document.body.style.getPropertyValue("--incsearch-secondary-edge")).toBe(style.edgeCss);
		});
	});
});
