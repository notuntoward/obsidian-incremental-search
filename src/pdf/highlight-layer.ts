import { PdfMatch } from "./types";

const OVERLAY_CLASS = "incsearch-pdf-overlay";
const MATCH_CLASS = "incsearch-pdf-match incsearch-match-exact";

/**
 * Gets or creates the absolutely positioned overlay layer for a PDF page element.
 */
export function getOrCreatePageOverlay(pageElement: HTMLElement): HTMLElement {
	let overlay = pageElement.querySelector(`.${OVERLAY_CLASS}`) as HTMLElement | null;
	if (!overlay) {
		overlay = document.createElement("div");
		overlay.className = OVERLAY_CLASS;
		overlay.style.position = "absolute";
		overlay.style.left = "0";
		overlay.style.top = "0";
		overlay.style.width = "100%";
		overlay.style.height = "100%";
		overlay.style.pointerEvents = "none";
		overlay.style.zIndex = "2";
		overlay.style.overflow = "hidden";
		pageElement.appendChild(overlay);
	}
	return overlay;
}

/**
 * Renders highlight rectangles on a PDF page container.
 */
export function renderPageHighlights(
	pageElement: HTMLElement,
	matches: PdfMatch[],
	activeMatchId: string | null,
	highlightAll = true
) {
	const overlay = getOrCreatePageOverlay(pageElement);
	overlay.textContent = "";

	if (!matches || matches.length === 0) {
		return;
	}

	const fragment = document.createDocumentFragment();

	for (const match of matches) {
		const isCurrent = match.id === activeMatchId;
		if (!highlightAll && !isCurrent) {
			continue;
		}

		if (!match.rects || match.rects.length === 0) {
			continue;
		}

		for (const rect of match.rects) {
			const highlightDiv = document.createElement("div");
			highlightDiv.className = isCurrent ? `${MATCH_CLASS} is-current` : MATCH_CLASS;
			highlightDiv.dataset.matchId = match.id;
			highlightDiv.style.position = "absolute";
			highlightDiv.style.left = `${rect.left}px`;
			highlightDiv.style.top = `${rect.top}px`;
			highlightDiv.style.width = `${rect.width}px`;
			highlightDiv.style.height = `${rect.height}px`;
			highlightDiv.style.pointerEvents = "none";
			fragment.appendChild(highlightDiv);
		}
	}

	overlay.appendChild(fragment);
}

/**
 * Removes all highlight overlays from a single page element.
 */
export function clearPageHighlights(pageElement: HTMLElement) {
	const overlay = pageElement.querySelector(`.${OVERLAY_CLASS}`);
	if (overlay) {
		overlay.remove();
	}
}

/**
 * Removes all highlight overlays from the entire viewer container.
 */
export function clearAllPdfHighlights(containerEl: HTMLElement) {
	const overlays = containerEl.querySelectorAll(`.${OVERLAY_CLASS}`);
	overlays.forEach((el) => el.remove());
	containerEl
		.querySelectorAll(".incsearch-pdf-native-current-overlay")
		.forEach((el) => el.remove());
	containerEl
		.querySelectorAll(".incsearch-pdf-native-envelope-active")
		.forEach((el) => el.classList.remove("incsearch-pdf-native-envelope-active"));
	const css = containerEl.ownerDocument.defaultView?.CSS as
		(typeof CSS & { highlights?: { delete(name: string): boolean } }) | undefined;
	css?.highlights?.delete("incsearch-pdf-current-token");
	containerEl.querySelectorAll(".highlight.selected").forEach((el) => {
		el.classList.remove("selected");
	});
}
