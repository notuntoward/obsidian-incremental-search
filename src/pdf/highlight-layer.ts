import { NATIVE_CURRENT_MATCH_SELECTOR } from "../utils/scroll";

/**
 * Removes all native PDF.js highlight decorations from the entire viewer container.
 */
export function clearAllPdfHighlights(containerEl: HTMLElement) {
	containerEl
		.querySelectorAll(".incsearch-pdf-native-current-overlay")
		.forEach((el) => el.remove());
	containerEl
		.querySelectorAll(".incsearch-pdf-native-envelope-active")
		.forEach((el) => el.classList.remove("incsearch-pdf-native-envelope-active"));
	const css = containerEl.ownerDocument.defaultView?.CSS as
		(typeof CSS & { highlights?: { delete(name: string): boolean } }) | undefined;
	css?.highlights?.delete("incsearch-pdf-current-token");
	containerEl.querySelectorAll(NATIVE_CURRENT_MATCH_SELECTOR).forEach((el) => {
		el.classList.remove("selected");
	});
}
