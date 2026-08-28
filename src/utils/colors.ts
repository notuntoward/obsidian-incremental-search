import {
	parseCssColor,
	relativeLuminance,
	computePdfSecondaryStyle,
	RGBA,
} from "./adaptive-highlight";
import { IncrementalSearchSettings } from "../types";

const LIGHT_THEME_TEXT = { r: 46, g: 51, b: 56, a: 1 };
const DARK_THEME_TEXT = { r: 220, g: 221, b: 222, a: 1 };
const PDF_FALLBACK_BACKGROUND = { r: 255, g: 255, b: 255, a: 1 };

const rgbString = (color: RGBA) => `rgb(${color.r}, ${color.g}, ${color.b})`;

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
 * Checks the contrast of the accent color against a background.
 * If contrast < 2.5, it falls back to the provided fallback color.
 * Pass `background` to evaluate against a surface other than the theme
 * (PDFs pass their actual page background and font color).
 */
export function resolveOutlineColor(background?: string, fallbackOverride?: string): string {
	if (typeof document === "undefined" || typeof window === "undefined" || !document.body) {
		return "#705dcf";
	}
	const bodyStyle = window.getComputedStyle(document.body);

	const appBg = bodyStyle.getPropertyValue("--background-primary").trim();
	const accent = bodyStyle.getPropertyValue("--interactive-accent").trim();
	const fallback =
		fallbackOverride || bodyStyle.getPropertyValue("--text-normal").trim() || "#000000";

	if (!accent) {
		return fallback;
	}

	const rgbBg = parseCssColor(
		background ||
			appBg ||
			(document.body.classList.contains("theme-dark") ? "#1e1e1e" : "#ffffff")
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
 * Checks whether an element or any ancestor up to (and including) `root`
 * applies a CSS `filter: invert(...)` of at least 50%. Themes that render PDFs
 * as dark (e.g. Minimal's PDF dark mode) do so by inverting the canvas output
 * with a filter, since canvas bitmaps cannot be recolored via background-color.
 */
function hasInversionFilter(el: HTMLElement, root: HTMLElement): boolean {
	let current: HTMLElement | null = el;
	while (current) {
		const filter = window.getComputedStyle(current).filter;
		if (filter && filter !== "none") {
			const match = filter.match(/invert\(\s*([\d.]+)(%)?\s*\)/);
			if (match) {
				const raw = parseFloat(match[1]);
				const amount = match[2] ? raw / 100 : raw;
				if (amount >= 0.5) {
					return true;
				}
			}
		}
		if (current === root) break;
		current = current.parentElement;
	}
	return false;
}

/**
 * Detects the PDF's actual page background and font colors.
 *
 * PDF.js renders pages into a `<canvas>` bitmap, so CSS `background-color` set
 * on the canvas or its wrapper elements is never visible — the canvas bitmap
 * covers it entirely. The only reliable way a theme changes a PDF's visible
 * appearance is a CSS `filter: invert(...)` applied to the canvas or an
 * ancestor (the technique themes like Minimal use for "PDF dark mode").
 *
 * When a canvas is present: inverted → treated as a dark page; otherwise the
 * PDF is the untouched white-page-with-dark-text default, regardless of any
 * background-color set on surrounding elements.
 *
 * When no canvas is present (non-standard PDF renderer), falls back to reading
 * explicit background-color from page/text-layer elements.
 */
function detectPdfAppearance(containerEl: HTMLElement): { background: RGBA; text: RGBA } {
	const fallback = { background: { ...PDF_FALLBACK_BACKGROUND }, text: { ...LIGHT_THEME_TEXT } };
	if (typeof window === "undefined") {
		return fallback;
	}

	const canvas = containerEl.querySelector<HTMLElement>("canvas");
	if (canvas) {
		if (hasInversionFilter(canvas, containerEl)) {
			return { background: { r: 0, g: 0, b: 0, a: 1 }, text: { ...DARK_THEME_TEXT } };
		}
		return fallback;
	}

	const readBackground = (el: HTMLElement): RGBA | null => {
		const bgColor = window.getComputedStyle(el).backgroundColor;
		if (!bgColor || bgColor === "transparent" || bgColor === "rgba(0, 0, 0, 0)") {
			return null;
		}
		return parseCssColor(bgColor);
	};

	for (const el of Array.from(
		containerEl.querySelectorAll<HTMLElement>(".pdfViewer .page, .pdf-viewer .page, .textLayer")
	)) {
		const background = readBackground(el);
		if (background) {
			const text = relativeLuminance(background) < 0.35 ? DARK_THEME_TEXT : LIGHT_THEME_TEXT;
			return { background, text: { ...text } };
		}
	}

	return fallback;
}

/**
 * Applies PDF match colors computed with the same outline and secondary
 * pipelines as markdown, evaluated against the PDF's actual page background
 * and font colors. The theme mode used is the one that best matches how the
 * PDF is styled (dark pages use the dark-theme algorithm, light pages use the
 * light-theme algorithm).
 */
export function applyPdfColors(
	containerEl: HTMLElement,
	settings?: Partial<IncrementalSearchSettings>
) {
	const { background: pdfBackground, text: pdfText } = detectPdfAppearance(containerEl);
	const secondary = computePdfSecondaryStyle(pdfBackground, pdfText, settings);
	const outline = resolveOutlineColor(rgbString(pdfBackground), rgbString(pdfText));
	containerEl.style.setProperty("--incsearch-secondary-fill", secondary.fillCss);
	containerEl.style.setProperty("--incsearch-secondary-edge", secondary.edgeCss);
	containerEl.style.setProperty("--incsearch-current-outline-resolved", outline);
	if (typeof document !== "undefined" && document.documentElement) {
		document.documentElement.style.setProperty(
			"--incsearch-pdf-secondary-fill",
			secondary.fillCss
		);
	}
}

/**
 * Removes PDF-specific color overrides from the container element.
 */
export function clearPdfColors(containerEl: HTMLElement) {
	containerEl.style.removeProperty("--incsearch-secondary-fill");
	containerEl.style.removeProperty("--incsearch-secondary-edge");
	containerEl.style.removeProperty("--incsearch-current-outline-resolved");
	if (typeof document !== "undefined" && document.documentElement) {
		document.documentElement.style.removeProperty("--incsearch-pdf-secondary-fill");
	}
}

/**
 * Updates the `--incsearch-current-outline-resolved` CSS variable on the document body.
 */
export function updateResolvedOutlineColor() {
	if (typeof document === "undefined" || !document.body) return;
	const resolved = resolveOutlineColor();
	document.body.style.setProperty("--incsearch-current-outline-resolved", resolved);
}
