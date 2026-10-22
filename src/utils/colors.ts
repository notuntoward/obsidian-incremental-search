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
export function resolveOutlineColor(background?: string, fallbackOverride?: string, doc?: Document): string {
	const targetDoc = doc ?? (typeof activeDocument !== "undefined" ? activeDocument : (typeof document !== "undefined" ? document : null));
	const targetWin = targetDoc?.defaultView ?? (typeof activeWindow !== "undefined" ? activeWindow : (typeof window !== "undefined" ? window : null));

	if (!targetDoc || !targetWin || !targetDoc.body) {
		return "#705dcf";
	}
	const bodyStyle = targetWin.getComputedStyle(targetDoc.body);

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
			(targetDoc.body.classList.contains("theme-dark") ? "#1e1e1e" : "#ffffff")
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
	const win = el.ownerDocument?.defaultView ?? (typeof activeWindow !== "undefined" ? activeWindow : (typeof window !== "undefined" ? window : null));
	if (!win) return false;
	let current: HTMLElement | null = el;
	while (current) {
		const filter = win.getComputedStyle(current).filter;
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
 */
function detectPdfAppearance(containerEl: HTMLElement): { background: RGBA; text: RGBA } {
	const fallback = { background: { ...PDF_FALLBACK_BACKGROUND }, text: { ...LIGHT_THEME_TEXT } };
	const win = containerEl.ownerDocument?.defaultView ?? (typeof activeWindow !== "undefined" ? activeWindow : (typeof window !== "undefined" ? window : null));
	if (!win) {
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
		const bgColor = win.getComputedStyle(el).backgroundColor;
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
 * and font colors.
 */
export function applyPdfColors(
	containerEl: HTMLElement,
	settings?: Partial<IncrementalSearchSettings>
) {
	const doc = containerEl.ownerDocument;
	const { background: pdfBackground, text: pdfText } = detectPdfAppearance(containerEl);
	const secondary = computePdfSecondaryStyle(pdfBackground, pdfText, settings);
	const outline = resolveOutlineColor(rgbString(pdfBackground), rgbString(pdfText), doc);
	containerEl.style.setProperty("--incsearch-secondary-fill", secondary.fillCss);
	containerEl.style.setProperty("--incsearch-secondary-edge", secondary.edgeCss);
	containerEl.style.setProperty("--incsearch-current-outline-resolved", outline);
	if (doc && doc.documentElement) {
		doc.documentElement.style.setProperty(
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
	const doc = containerEl.ownerDocument;
	if (doc && doc.documentElement) {
		doc.documentElement.style.removeProperty("--incsearch-pdf-secondary-fill");
	}
}

/**
 * Updates the `--incsearch-current-outline-resolved` CSS variable on the document body.
 */
export function updateResolvedOutlineColor(doc?: Document) {
	const targetDoc = doc ?? (typeof activeDocument !== "undefined" ? activeDocument : (typeof document !== "undefined" ? document : null));
	if (!targetDoc || !targetDoc.body) return;
	const resolved = resolveOutlineColor(undefined, undefined, targetDoc);
	targetDoc.body.style.setProperty("--incsearch-current-outline-resolved", resolved);
}
