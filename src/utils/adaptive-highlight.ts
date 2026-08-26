import { IncrementalSearchSettings, SecondaryHighlightStyle } from "../types";

export type RGBA = { r: number; g: number; b: number; a: number };

export type CssBoxDecoration = {
	source: "border" | "outline" | "box-shadow" | "none";
	color: RGBA | null;
	thicknessPx: number | null;
	raw: string;
};

export type MeasuredAppearance = {
	mode: "light" | "dark";
	appBackground: RGBA;
	normalText: RGBA;
	currentFill: RGBA;
	currentText: RGBA;
	currentBox: CssBoxDecoration;
	themeAccent: RGBA | null;
	themeHighlightBg: RGBA | null;
};

export type SecondaryStyle = {
	mode: "light" | "dark";
	fillCss: string;
	edgeCss: string;
	useUnderline: boolean;
	fillRgba: RGBA;
	edgeRgba: RGBA;
};

export const MIN_DETECTABLE_DIFFERENCE = 1.12;
export const MIN_TEXT_CONTRAST = 4.5;
export const MAX_ACCEPTABLE_DEGRADATION = 0.92;
export const DEFAULT_SUBORDINATE_FRACTION = 0.75;

/**
 * Recursively resolves CSS variables (e.g. "var(--color-accent)" or "hsl(var(--accent-h), ...)")
 * using computed styles from the document.
 */
export function resolveAllCssVariables(
	input: string | null | undefined,
	el?: Element | null
): string {
	if (!input) return "";
	if (typeof document === "undefined" || typeof window === "undefined") {
		return input.trim();
	}
	const target = el ?? document.body ?? document.documentElement;
	if (!target) return input.trim();

	let result = input.trim();
	const cs = window.getComputedStyle(target);

	// Resolve direct var(...) or embedded var(...) in expressions up to 6 levels deep
	for (let i = 0; i < 6; i++) {
		if (!result.includes("var(--")) break;
		result = result.replace(
			/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\s*\)/gi,
			(_, varName, fallback) => {
				const val = cs.getPropertyValue(varName).trim();
				return val || (fallback ? fallback.trim() : "");
			}
		);
	}
	return result.trim();
}

/**
 * Parses any CSS color string into RGBA.
 * Supports: hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb(), rgba(), hsl(), hsla(),
 * CSS variables var(--...), and browser DOM fallback.
 */
export function parseCssColor(value: string | null | undefined): RGBA {
	if (!value) return { r: 0, g: 0, b: 0, a: 0 };

	// Resolve CSS variables first
	const resolved = resolveAllCssVariables(value);
	let trimmed = resolved.toLowerCase();

	// Clean up !important and trailing semicolons
	trimmed = trimmed
		.replace(/!important/g, "")
		.replace(/;+$/, "")
		.trim();

	if (trimmed === "transparent" || trimmed === "") {
		return { r: 0, g: 0, b: 0, a: 0 };
	}

	// Hex format
	if (trimmed.startsWith("#")) {
		const hex = trimmed.slice(1);
		if (hex.length === 3) {
			const r = parseInt(hex[0] + hex[0], 16);
			const g = parseInt(hex[1] + hex[1], 16);
			const b = parseInt(hex[2] + hex[2], 16);
			return { r, g, b, a: 1 };
		}
		if (hex.length === 4) {
			const r = parseInt(hex[0] + hex[0], 16);
			const g = parseInt(hex[1] + hex[1], 16);
			const b = parseInt(hex[2] + hex[2], 16);
			const a = parseInt(hex[3] + hex[3], 16) / 255;
			return { r, g, b, a: Number(a.toFixed(3)) };
		}
		if (hex.length === 6) {
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			return { r, g, b, a: 1 };
		}
		if (hex.length === 8) {
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			const a = parseInt(hex.slice(6, 8), 16) / 255;
			return { r, g, b, a: Number(a.toFixed(3)) };
		}
	}

	// rgb / rgba format with commas or modern slash syntax
	const rgbaMatch = trimmed.match(
		/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i
	);
	if (rgbaMatch) {
		const [, r, g, b, aRaw] = rgbaMatch;
		let a = 1;
		if (aRaw !== undefined) {
			a = aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw);
		}
		return {
			r: Math.min(255, Math.max(0, Math.round(Number(r)))),
			g: Math.min(255, Math.max(0, Math.round(Number(g)))),
			b: Math.min(255, Math.max(0, Math.round(Number(b)))),
			a: Math.min(1, Math.max(0, Number(a))),
		};
	}

	// hsl / hsla format (e.g. hsl(175, 57%, 33%) or hsl(175 57% 33% / 80%))
	const hslaMatch = trimmed.match(
		/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,/]+([\d.]+%?))?\s*\)/i
	);
	if (hslaMatch) {
		const [, hRaw, sRaw, lRaw, aRaw] = hslaMatch;
		const h = parseFloat(hRaw) % 360;
		const s = parseFloat(sRaw) / 100;
		const l = parseFloat(lRaw) / 100;
		let a = 1;
		if (aRaw !== undefined) {
			a = aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw);
		}
		const k = (n: number) => (n + h / 30) % 12;
		const aFactor = s * Math.min(l, 1 - l);
		const f = (n: number) =>
			l - aFactor * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		return {
			r: Math.min(255, Math.max(0, Math.round(f(0) * 255))),
			g: Math.min(255, Math.max(0, Math.round(f(8) * 255))),
			b: Math.min(255, Math.max(0, Math.round(f(4) * 255))),
			a: Math.min(1, Math.max(0, Number(a))),
		};
	}

	// Browser DOM fallback for named colors
	if (typeof document !== "undefined" && document.createElement) {
		try {
			const probe = document.createElement("span");
			probe.style.setProperty("color", trimmed);
			probe.style.display = "none";
			document.body.appendChild(probe);
			const computed = window.getComputedStyle(probe).color;
			probe.remove();
			if (computed && computed !== trimmed) {
				return parseCssColor(computed);
			}
		} catch {
			// ignore fallback errors
		}
	}

	return { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * Composites a foreground RGBA color over a background RGBA color.
 */
export function composite(fg: RGBA, bg: RGBA): RGBA {
	const a = fg.a + bg.a * (1 - fg.a);
	if (a === 0) return { r: bg.r, g: bg.g, b: bg.b, a: 0 };
	return {
		r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
		g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
		b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
		a,
	};
}

/**
 * Calculates standard WCAG 2.x relative luminance (0 to 1).
 */
export function relativeLuminance(c: RGBA): number {
	const toLinear = (channel: number) => {
		const v = channel / 255;
		return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
	};
	const r = toLinear(c.r);
	const g = toLinear(c.g);
	const b = toLinear(c.b);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculates standard WCAG 2.x contrast ratio (1:1 to 21:1).
 */
export function contrastRatio(a: RGBA, b: RGBA): number {
	const L1 = relativeLuminance(a);
	const L2 = relativeLuminance(b);
	const lighter = Math.max(L1, L2);
	const darker = Math.min(L1, L2);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Formats RGBA as CSS rgba(...) string.
 */
export function toCssRgba(c: RGBA): string {
	const r = Math.round(c.r);
	const g = Math.round(c.g);
	const b = Math.round(c.b);
	const a = Number(c.a.toFixed(3));
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Returns true if the color is essentially monochrome (greyscale / neutral).
 */
export function isMonochrome(c: RGBA): boolean {
	return Math.abs(c.r - c.g) <= 12 && Math.abs(c.g - c.b) <= 12 && Math.abs(c.r - c.b) <= 12;
}

/**
 * Calculates the Hunt colorfulness adaptation factor (F_L^0.25) according to CAM16 / CIECAM02.
 * The Hunt effect establishes that perceived colorfulness (M = C * F_L^0.25) increases with adapting
 * luminance. At low luminance (dark themes), colors appear desaturated and dim.
 *
 * @param bgLuminance - Standard relative luminance Y_bg in [0, 1]
 * @returns Normalized Hunt colorfulness factor in [0.60, 1.00]
 */
export function calculateHuntAdaptationFactor(bgLuminance: number): number {
	const clampedY = Math.max(0, Math.min(1, bgLuminance));
	// Map relative luminance [0, 1] to display adapting luminance L_A [5, 200] cd/m^2
	const La = 5 + 195 * clampedY;
	const k = 1 / (5 * La + 1);
	const k4 = k * k * k * k;
	const oneMinusK4 = 1 - k4;
	const Fl = 0.2 * k4 * (5 * La) + 0.1 * oneMinusK4 * oneMinusK4 * Math.cbrt(5 * La);

	// Normalizing factor against white reference (Fl ~ 1.0 at La = 200)
	const FlRef = 1.0;
	const huntCorrelate = Math.pow(Fl, 0.25) / FlRef;
	return Math.max(0.5, Math.min(1.0, huntCorrelate));
}

/**
 * Ensures the accent color has high vibrancy and luminosity for dark backgrounds,
 * or adequate saturation/contrast for warm light backgrounds (e.g. Flexoki warm cream, Solarized),
 * using continuous Hunt adaptation factors.
 */
export function ensurePerceptibleAccent(accent: RGBA, bg: RGBA, isDarkLegacy?: boolean): RGBA {
	const bgLum = relativeLuminance(bg);
	const accentLum = relativeLuminance(accent);
	const isDark = isDarkLegacy ?? bgLum < 0.35;
	const H = calculateHuntAdaptationFactor(bgLum);
	const D = Math.max(0, Math.min(1, (1 - H) / 0.265)); // Darkness deficit [0, 1]

	if (isDark || bgLum < 0.35) {
		// Dark / Black / Slate background:
		// Compensate for the Hunt effect and Stevens effect by scaling max channel to 255
		// and applying luminous lift inversely proportional to the Hunt colorfulness factor.
		if (isMonochrome(accent)) {
			return { r: 255, g: 255, b: 255, a: 1 };
		}
		const maxChannel = Math.max(accent.r, accent.g, accent.b);
		if (maxChannel === 0) {
			return { r: 255, g: 255, b: 255, a: 1 };
		}
		const scale = 255 / maxChannel;
		const rScaled = accent.r * scale;
		const gScaled = accent.g * scale;
		const bScaled = accent.b * scale;

		const lift = Math.round(50 * D * (1 - Math.min(1, accentLum * 1.5)));
		const r = Math.min(255, Math.round(rScaled + lift * (1 - rScaled / 255)));
		const g = Math.min(255, Math.round(gScaled + lift * (1 - gScaled / 255)));
		const b = Math.min(255, Math.round(bScaled + lift * (1 - bScaled / 255)));
		return { r, g, b, a: 1 };
	} else {
		// Light / Warm Paper background
		if (isMonochrome(accent)) {
			return { r: 45, g: 45, b: 45, a: 1 };
		}

		const currentContrast = contrastRatio(accent, bg);

		// If accent is too pale (e.g. pale yellow on warm paper) or has low contrast against paper:
		if (accentLum > 0.38 || currentContrast < 2.8) {
			const maxChannel = Math.max(accent.r, accent.g, accent.b);
			if (maxChannel > 0) {
				const targetMax = Math.min(185, maxChannel * 0.72);
				const scale = targetMax / maxChannel;
				const r = Math.max(0, Math.min(255, Math.round(accent.r * scale)));
				const g = Math.max(0, Math.min(255, Math.round(accent.g * scale)));
				const b = Math.max(0, Math.min(255, Math.round(accent.b * scale)));
				return { r, g, b, a: 1 };
			}
		}
	}
	return { ...accent, a: 1 };
}

/**
 * Walks up the DOM to find the first opaque background color.
 */
export function firstOpaqueBackground(el: HTMLElement | null): RGBA {
	for (let node: HTMLElement | null = el; node; node = node.parentElement) {
		if (typeof window !== "undefined") {
			const color = parseCssColor(window.getComputedStyle(node).backgroundColor);
			if (color.a > 0.05) return color;
		}
	}
	if (typeof document !== "undefined" && typeof window !== "undefined" && document.body) {
		const bodyBg = parseCssColor(window.getComputedStyle(document.body).backgroundColor);
		if (bodyBg.a > 0.05) return bodyBg;

		const varValue = window
			.getComputedStyle(document.body)
			.getPropertyValue("--background-primary")
			.trim();
		if (varValue) {
			const parsed = parseCssColor(varValue);
			if (parsed.a > 0.05) return parsed;
		}
	}
	const isDark =
		typeof document !== "undefined" &&
		document.body &&
		document.body.classList.contains("theme-dark");
	return isDark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
}

/**
 * Detects box/border/outline decoration on a match element or container.
 */
export function detectBoxDecoration(matchEl: HTMLElement | null): CssBoxDecoration {
	if (!matchEl || typeof window === "undefined") {
		return { source: "none", color: null, thicknessPx: null, raw: "" };
	}

	for (let el: HTMLElement | null = matchEl; el && el !== document.body; el = el.parentElement) {
		const cs = window.getComputedStyle(el);
		if (!cs) break;

		for (const edge of ["top", "right", "bottom", "left"] as const) {
			const width = parseFloat(cs.getPropertyValue(`border-${edge}-width`));
			const style = cs.getPropertyValue(`border-${edge}-style`);
			const color = parseCssColor(cs.getPropertyValue(`border-${edge}-color`));
			if (width > 0 && style !== "none" && color.a > 0.01) {
				return { source: "border", color, thicknessPx: width, raw: `${width}px ${style}` };
			}
		}

		const outlineWidth = parseFloat(cs.outlineWidth);
		const outlineColor = parseCssColor(cs.outlineColor);
		if (outlineWidth > 0 && cs.outlineStyle !== "none" && outlineColor.a > 0.01) {
			return {
				source: "outline",
				color: outlineColor,
				thicknessPx: outlineWidth,
				raw: cs.outlineWidth,
			};
		}

		if (cs.boxShadow && cs.boxShadow !== "none") {
			const matchColor = cs.boxShadow.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]+)/);
			const color = matchColor ? parseCssColor(matchColor[0]) : null;
			return { source: "box-shadow", color, thicknessPx: null, raw: cs.boxShadow };
		}
	}

	return { source: "none", color: null, thicknessPx: null, raw: "" };
}

/**
 * Measures the active appearance tokens from the live DOM or theme variables.
 */
export function measureCurrentMatchAppearance(targetEl?: HTMLElement | null): MeasuredAppearance {
	const isDark =
		typeof document !== "undefined" &&
		document.body &&
		document.body.classList.contains("theme-dark");
	const mode: "light" | "dark" = isDark ? "dark" : "light";

	const currentMatchEl =
		targetEl ??
		(typeof document !== "undefined"
			? (document.querySelector(".incsearch-match-exact.is-current") as HTMLElement | null)
			: null);

	const bodyStyle =
		typeof document !== "undefined" && typeof window !== "undefined" && document.body
			? window.getComputedStyle(document.body)
			: null;

	const normalText = parseCssColor(
		bodyStyle?.getPropertyValue("--text-normal") ||
			bodyStyle?.color ||
			(isDark ? "#dcddde" : "#2e3338")
	);
	const appBackground = currentMatchEl
		? firstOpaqueBackground(currentMatchEl)
		: firstOpaqueBackground(null);

	const themeAccent = parseCssColor(
		bodyStyle?.getPropertyValue("--interactive-accent") ||
			bodyStyle?.getPropertyValue("--text-accent") ||
			bodyStyle?.getPropertyValue("--color-accent") ||
			"#705dcf"
	);
	const themeHighlightBg = parseCssColor(
		bodyStyle?.getPropertyValue("--text-highlight-bg") || "#ffe066"
	);

	let currentFill = { r: 0, g: 0, b: 0, a: 0 };
	let currentText = normalText;
	let currentBox: CssBoxDecoration = { source: "none", color: null, thicknessPx: null, raw: "" };

	if (currentMatchEl && typeof window !== "undefined") {
		const cs = window.getComputedStyle(currentMatchEl);
		currentFill = parseCssColor(cs.backgroundColor);
		currentText = parseCssColor(cs.color);
		currentBox = detectBoxDecoration(currentMatchEl);
	} else if (bodyStyle) {
		const outlineResolved = bodyStyle
			.getPropertyValue("--incsearch-current-outline-resolved")
			.trim();
		if (outlineResolved) {
			const outlineColor = parseCssColor(outlineResolved);
			if (outlineColor.a > 0) {
				currentBox = {
					source: "outline",
					color: outlineColor,
					thicknessPx: 2,
					raw: "2px solid",
				};
			}
		} else if (themeAccent.a > 0) {
			currentBox = {
				source: "outline",
				color: themeAccent,
				thicknessPx: 2,
				raw: "2px solid",
			};
		}
	}

	return {
		mode,
		appBackground,
		normalText,
		currentFill,
		currentText,
		currentBox,
		themeAccent: themeAccent.a > 0 ? themeAccent : null,
		themeHighlightBg: themeHighlightBg.a > 0 ? themeHighlightBg : null,
	};
}

/**
 * Chooses an accent origin color defensively using a prioritized fallback chain.
 * If the active match outline is monochrome (white/black), it checks whether the theme
 * has a chromatic accent (--interactive-accent or --text-highlight-bg) before falling back.
 */
export function chooseAccent(a: MeasuredAppearance): RGBA {
	// 1. Current match fill if distinguishable from app background
	const visibleFill = composite(a.currentFill, a.appBackground);
	if (
		contrastRatio(visibleFill, a.appBackground) >= MIN_DETECTABLE_DIFFERENCE &&
		!isMonochrome(visibleFill)
	) {
		return visibleFill;
	}

	// 2. Current match outline / box decoration color (if chromatic)
	if (a.currentBox.color) {
		const visibleBorder = composite(a.currentBox.color, a.appBackground);
		if (
			contrastRatio(visibleBorder, a.appBackground) >= MIN_DETECTABLE_DIFFERENCE &&
			!isMonochrome(visibleBorder)
		) {
			return visibleBorder;
		}
	}

	// 3. Theme interactive accent
	if (a.themeAccent) {
		const visibleAccent = composite(a.themeAccent, a.appBackground);
		if (
			contrastRatio(visibleAccent, a.appBackground) >= MIN_DETECTABLE_DIFFERENCE &&
			!isMonochrome(visibleAccent)
		) {
			return visibleAccent;
		}
	}

	// 4. Theme highlight background (e.g. yellow highlight)
	if (a.themeHighlightBg) {
		const visibleHighlight = composite(a.themeHighlightBg, a.appBackground);
		if (contrastRatio(visibleHighlight, a.appBackground) >= MIN_DETECTABLE_DIFFERENCE) {
			return visibleHighlight;
		}
	}

	// 5. If box decoration was monochrome (e.g. clean white/black outline)
	if (a.currentBox.color) {
		const visibleBorder = composite(a.currentBox.color, a.appBackground);
		if (contrastRatio(visibleBorder, a.appBackground) >= MIN_DETECTABLE_DIFFERENCE) {
			return visibleBorder;
		}
	}

	// 6. Current match text
	const visibleText = composite(a.currentText, a.appBackground);
	if (contrastRatio(visibleText, a.appBackground) >= MIN_DETECTABLE_DIFFERENCE) {
		return visibleText;
	}

	// 7. Adaptive neutral
	return relativeLuminance(a.appBackground) < 0.5
		? { r: 255, g: 255, b: 255, a: 1 }
		: { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * Determines appropriate fill alpha and edge alpha for secondary match highlights
 * using a continuous psychophysical transfer function based on the Hunt Effect and the Stevens Effect.
 *
 * @param prominenceScale - Slider prominence value in [0.20, 1.00]
 * @param bgLuminanceOrIsDark - Background relative luminance [0, 1] or boolean flag
 */
export function calculateSecondaryAlphas(
	prominenceScale = 0.75,
	bgLuminanceOrIsDark: number | boolean = false
): { fillAlpha: number; edgeAlpha: number } {
	const clampedP = Math.max(0.2, Math.min(1.0, prominenceScale));
	const bgLuminance =
		typeof bgLuminanceOrIsDark === "number"
			? bgLuminanceOrIsDark
			: bgLuminanceOrIsDark
				? 0.015
				: 1.0;

	const H = calculateHuntAdaptationFactor(bgLuminance);
	// Darkness factor D smoothly ranges from 0.0 (pure white) to 1.0 (true black)
	const D = Math.max(0, Math.min(1, (1 - H) / 0.265));

	// Continuous Hunt/Stevens perceptual transfer function
	// Fill alpha scales smoothly from [0.08..0.24] on white to [0.20..0.46] on true black
	const minFill = 0.08 + 0.12 * D;
	const maxFill = 0.24 + 0.22 * D;
	const fillAlpha = Number((minFill + (maxFill - minFill) * clampedP).toFixed(3));

	// Edge alpha scales smoothly from [0.20..0.55] on white to [0.45..0.92] on true black
	const minEdge = 0.2 + 0.25 * D;
	const maxEdge = 0.55 + 0.37 * D;
	const edgeAlpha = Number((minEdge + (maxEdge - minEdge) * clampedP).toFixed(3));

	return { fillAlpha, edgeAlpha };
}

/**
 * Checks whether text remains readable over candidate fill.
 */
export function textRemainsReadable(
	textColor: RGBA,
	background: RGBA,
	candidateFill: RGBA,
	enforceLegibility = true
): boolean {
	if (!enforceLegibility) return true;
	const baseline = contrastRatio(textColor, background);
	const withFill = contrastRatio(textColor, candidateFill);
	return withFill >= MIN_TEXT_CONTRAST || withFill >= baseline * MAX_ACCEPTABLE_DEGRADATION;
}

/**
 * Quantifies the visual prominence of the current match.
 */
export function currentMatchProminence(measured: MeasuredAppearance): number {
	const fillProminence = contrastRatio(
		composite(measured.currentFill, measured.appBackground),
		measured.appBackground
	);
	const boxProminence = measured.currentBox.color
		? contrastRatio(
				composite(measured.currentBox.color, measured.appBackground),
				measured.appBackground
			)
		: 1;
	return Math.max(fillProminence, boxProminence, 1.4);
}

/**
 * Builds the complete SecondaryStyle object based on appearance and user settings.
 */
export function buildSecondaryStyle(
	measured: MeasuredAppearance,
	settings?: Partial<IncrementalSearchSettings>
): SecondaryStyle {
	const styleMode: SecondaryHighlightStyle = settings?.secondaryHighlightStyle ?? "adaptive";
	const prominence = Math.max(0.2, Math.min(1.0, settings?.secondaryProminence ?? 0.75));
	const enforceLegibility = settings?.secondaryEnforceLegibility ?? true;
	const bgLuminance = relativeLuminance(measured.appBackground);
	const isDark = measured.mode === "dark" || bgLuminance < 0.35;

	// 1. Custom color mode
	if (styleMode === "custom") {
		const customStr = isDark
			? settings?.secondaryCustomDarkColor
			: settings?.secondaryCustomLightColor;
		if (customStr && customStr.trim()) {
			const customRgba = parseCssColor(customStr.trim());
			const { fillAlpha: calcFill, edgeAlpha: calcEdge } = calculateSecondaryAlphas(
				prominence,
				bgLuminance
			);
			const fillAlpha = customRgba.a > 0 && customRgba.a < 1.0 ? customRgba.a : calcFill;
			const edgeAlpha =
				customRgba.a > 0 && customRgba.a < 1.0
					? Math.min(1.0, customRgba.a * 1.8)
					: calcEdge;
			const fillComp = composite({ ...customRgba, a: fillAlpha }, measured.appBackground);
			const readable = textRemainsReadable(
				measured.normalText,
				measured.appBackground,
				fillComp,
				enforceLegibility
			);
			return {
				mode: measured.mode,
				fillCss: readable
					? `rgba(${customRgba.r}, ${customRgba.g}, ${customRgba.b}, ${fillAlpha.toFixed(3)})`
					: "transparent",
				edgeCss: `rgba(${customRgba.r}, ${customRgba.g}, ${customRgba.b}, ${edgeAlpha.toFixed(3)})`,
				useUnderline: !readable,
				fillRgba: fillComp,
				edgeRgba: { ...customRgba, a: edgeAlpha },
			};
		}
	}

	// 2. Underline-only mode
	if (styleMode === "underline") {
		const rawAccent = chooseAccent(measured);
		const accent = ensurePerceptibleAccent(rawAccent, measured.appBackground, isDark);
		const { edgeAlpha } = calculateSecondaryAlphas(prominence, bgLuminance);
		return {
			mode: measured.mode,
			fillCss: "transparent",
			edgeCss: `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${edgeAlpha.toFixed(3)})`,
			useUnderline: true,
			fillRgba: { r: 0, g: 0, b: 0, a: 0 },
			edgeRgba: { ...accent, a: edgeAlpha },
		};
	}

	// 3. Theme highlight default mode
	if (styleMode === "theme" && measured.themeHighlightBg) {
		const hl = measured.themeHighlightBg;
		const { fillAlpha, edgeAlpha } = calculateSecondaryAlphas(prominence, bgLuminance);
		const fillComp = composite({ ...hl, a: fillAlpha }, measured.appBackground);
		return {
			mode: measured.mode,
			fillCss: `rgba(${hl.r}, ${hl.g}, ${hl.b}, ${fillAlpha})`,
			edgeCss: `rgba(${hl.r}, ${hl.g}, ${hl.b}, ${edgeAlpha})`,
			useUnderline: false,
			fillRgba: fillComp,
			edgeRgba: { ...hl, a: edgeAlpha },
		};
	}

	// 4. Tint-only mode
	if (styleMode === "tint") {
		const rawAccent = chooseAccent(measured);
		const accent = ensurePerceptibleAccent(rawAccent, measured.appBackground, isDark);
		const { fillAlpha } = calculateSecondaryAlphas(prominence, bgLuminance);
		const effectiveFillAlpha =
			isDark && isMonochrome(accent) ? Math.min(fillAlpha, 0.2) : fillAlpha;
		const fillComp = composite({ ...accent, a: effectiveFillAlpha }, measured.appBackground);
		const readable = textRemainsReadable(
			measured.normalText,
			measured.appBackground,
			fillComp,
			enforceLegibility
		);
		return {
			mode: measured.mode,
			fillCss: readable
				? `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${effectiveFillAlpha.toFixed(3)})`
				: "transparent",
			edgeCss: "transparent",
			useUnderline: !readable,
			fillRgba: fillComp,
			edgeRgba: { r: 0, g: 0, b: 0, a: 0 },
		};
	}

	// 5. Default "adaptive" mode (fill + inset edge, with underline fallback if low readability)
	const rawAccent = chooseAccent(measured);
	const accent = ensurePerceptibleAccent(rawAccent, measured.appBackground, isDark);
	const { fillAlpha, edgeAlpha } = calculateSecondaryAlphas(prominence, bgLuminance);
	const effectiveFillAlpha =
		isDark && isMonochrome(accent) ? Math.min(fillAlpha, 0.2) : fillAlpha;

	const fillComp = composite({ ...accent, a: effectiveFillAlpha }, measured.appBackground);
	const readable = textRemainsReadable(
		measured.normalText,
		measured.appBackground,
		fillComp,
		enforceLegibility
	);

	const fillCss = readable
		? `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${effectiveFillAlpha.toFixed(3)})`
		: "transparent";
	const edgeCss = `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${edgeAlpha.toFixed(3)})`;

	return {
		mode: measured.mode,
		fillCss,
		edgeCss,
		useUnderline: !readable,
		fillRgba: fillComp,
		edgeRgba: { ...accent, a: edgeAlpha },
	};
}

/**
 * Cache for computed secondary styles.
 */
const appearanceCache = new Map<string, SecondaryStyle>();

export function getAppearanceCacheKey(settings?: Partial<IncrementalSearchSettings>): string {
	const isDark =
		typeof document !== "undefined" &&
		document.body &&
		document.body.classList.contains("theme-dark");
	const mode = isDark ? "dark" : "light";
	const className = typeof document !== "undefined" ? document.body?.className || "" : "";
	const style = settings?.secondaryHighlightStyle || "adaptive";
	const prom = settings?.secondaryProminence ?? 0.75;
	const leg = settings?.secondaryEnforceLegibility ?? true;
	const cl = settings?.secondaryCustomLightColor || "";
	const cd = settings?.secondaryCustomDarkColor || "";
	return `${mode}:${className}:${style}:${prom}:${leg}:${cl}:${cd}`;
}

export function invalidateAppearanceCache(): void {
	appearanceCache.clear();
}

/**
 * Computes or retrieves cached secondary match style and applies CSS custom properties.
 */
export function getOrComputeSecondaryStyle(
	settings?: Partial<IncrementalSearchSettings>,
	targetEl?: HTMLElement | null
): SecondaryStyle {
	const key = getAppearanceCacheKey(settings);
	const cached = appearanceCache.get(key);
	if (cached) {
		applySecondaryStyle(cached);
		return cached;
	}

	const measured = measureCurrentMatchAppearance(targetEl);
	const style = buildSecondaryStyle(measured, settings);
	appearanceCache.set(key, style);
	applySecondaryStyle(style);
	return style;
}

/**
 * Applies computed secondary style values to CSS custom properties.
 */
export function applySecondaryStyle(style: SecondaryStyle): void {
	if (typeof document === "undefined" || !document.documentElement || !document.body) {
		return;
	}
	document.documentElement.style.setProperty("--incsearch-secondary-fill", style.fillCss);
	document.documentElement.style.setProperty("--incsearch-secondary-edge", style.edgeCss);
	document.body.style.setProperty("--incsearch-secondary-fill", style.fillCss);
	document.body.style.setProperty("--incsearch-secondary-edge", style.edgeCss);
}
