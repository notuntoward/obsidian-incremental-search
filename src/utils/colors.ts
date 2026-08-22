/**
 * Parses a CSS color string into RGB values [0-255].
 * Supports hex (#rgb, #rrggbb), rgb(), rgba().
 */
export function parseColor(color: string): [number, number, number] | null {
	// Create a dummy element to let the browser resolve the color
	const div = document.createElement("div");
	div.style.color = color;
	div.style.display = "none";
	document.body.appendChild(div);
	const computed = window.getComputedStyle(div).color;
	document.body.removeChild(div);

	const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (match) {
		return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
	}
	return null;
}

/**
 * Calculates the relative luminance of a color according to WCAG 2.0.
 * RGB values must be in [0-255].
 */
export function getRelativeLuminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map((val) => {
		const srgb = val / 255;
		return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
 * If contrast < 3.0, it falls back to --text-normal.
 */
export function resolveOutlineColor(): string {
	const bodyStyle = window.getComputedStyle(document.body);

	// Get computed colors
	const matchBg = bodyStyle.getPropertyValue("--incsearch-match-bg").trim();
	const accent = bodyStyle.getPropertyValue("--interactive-accent").trim();
	const fallback = bodyStyle.getPropertyValue("--text-normal").trim() || "#000000";

	if (!matchBg || !accent) {
		return fallback;
	}

	const rgbBg = parseColor(matchBg);
	const rgbAccent = parseColor(accent);

	if (!rgbBg || !rgbAccent) {
		return fallback;
	}

	const lumBg = getRelativeLuminance(rgbBg);
	const lumAccent = getRelativeLuminance(rgbAccent);

	const ratio = getContrastRatio(lumBg, lumAccent);

	if (ratio >= 3.0) {
		return accent;
	}
	return fallback;
}

/**
 * Updates the `--incsearch-current-outline-resolved` CSS variable on the document body.
 */
export function updateResolvedOutlineColor() {
	const resolved = resolveOutlineColor();
	document.body.style.setProperty("--incsearch-current-outline-resolved", resolved);
}
