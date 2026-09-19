/**
 * Injects inline <mark> highlight elements directly into PDF.js .textLayer text nodes
 * for both active (current) match framing and secondary match highlighting.
 *
 * Why inline <mark> tags directly in the text layer?
 * 1. PDF.js styles all `.textLayer span` with `position: absolute; color: transparent;`.
 *    Using `<mark>` avoids CSS collisions with PDF.js's span rules.
 * 2. Because <mark> is an inline child of the exact text node positioned by PDF.js,
 *    its geometry, scale, rotation, font metrics, and zoom alignment are 100% exact
 *    by construction â€” requiring zero coordinate math or matrix transformations.
 * 3. Rendering both the active match outline and secondary fills using the exact DOM
 *    character map eliminates PDF.js internal find-controller index drift (e.g. wrapping
 *    adjacent whitespace or shifted characters).
 */

export const SECONDARY_CLASS = "incsearch-pdf-secondary";

/**
 * Removes all injected <mark> highlight elements from containerEl,
 * unwrapping their text content and normalizing adjacent text nodes back to the original DOM.
 */
export function clearSecondaryHighlights(containerEl: HTMLElement): void {
	const marks = containerEl.querySelectorAll(`mark.${SECONDARY_CLASS}, mark.incsearch-pdf-match`);
	const parentsToNormalize = new Set<Node>();

	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i];
		const parent = mark.parentNode;
		if (!parent) continue;
		parentsToNormalize.add(parent);
		while (mark.firstChild) {
			parent.insertBefore(mark.firstChild, mark);
		}
		parent.removeChild(mark);
	}

	for (const parent of parentsToNormalize) {
		parent.normalize();
	}

	if (typeof containerEl.normalize === "function") {
		containerEl.normalize();
	}
}
