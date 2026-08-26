import { parseCssColor, relativeLuminance, contrastRatio } from "./adaptive-highlight";

/**
 * Parses a CSS color string into RGB values [0-255].
 * Supports hex (#rgb, #rrggbb), rgb(), rgba().
 */
export function parseColor(color: string): [number, number, number] | null {
	const c = parseCssColor(color);
	if (c.a === 0 && color.trim().toLowerCase() === "transparent") {
		return null;
	}
	return [c.r, c.g, c.b];
}

/**
 * Calculates the relative luminance of a color according to WCAG 2.0.
 * RGB values must be in [0-255].
 */
export function getRelativeLuminance(rgb: [number, number, number]): number {
	return relativeLuminance({ r: rgb[0], g: rgb[1], b: rgb[2], a: 1 });
}

/**
 * Calculates the contrast ratio between two relative luminances.
 */
export function getContrastRatio(lum1: number, lum2: number): number {
	const lighter = Math.max(lum1, lum2);
	const darker = Math.min(lum1, lum2);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Checks the contrast of the accent color against the computed match background.
 * If contrast < 2.5, it falls back to --text-normal.
 */
export function resolveOutlineColor(): string {
	if (typeof document === "undefined" || typeof window === "undefined" || !document.body) {
		return "#705dcf";
	}
	const bodyStyle = window.getComputedStyle(document.body);

	// Get computed colors
	const appBg = bodyStyle.getPropertyValue("--background-primary").trim();
	const accent = bodyStyle.getPropertyValue("--interactive-accent").trim();
	const fallback = bodyStyle.getPropertyValue("--text-normal").trim() || "#000000";

	if (!accent) {
		return fallback;
	}

	const rgbBg = parseCssColor(
		appBg || (document.body.classList.contains("theme-dark") ? "#1e1e1e" : "#ffffff")
	);
	const rgbAccent = parseCssColor(accent);

	const lumBg = relativeLuminance(rgbBg);
	const lumAccent = relativeLuminance(rgbAccent);

	const ratio = getContrastRatio(lumBg, lumAccent);

	if (ratio >= 2.5) {
		return accent;
	}
	return fallback;
}

/**
 * Updates the `--incsearch-current-outline-resolved` CSS variable on the document body.
 */
export function updateResolvedOutlineColor() {
	if (typeof document === "undefined" || !document.body) return;
	const resolved = resolveOutlineColor();
	document.body.style.setProperty("--incsearch-current-outline-resolved", resolved);
}
