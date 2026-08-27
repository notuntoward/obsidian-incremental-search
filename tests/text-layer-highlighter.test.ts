import { describe, it, expect, beforeEach } from "vitest";
import {
	injectSecondaryHighlights,
	clearSecondaryHighlights,
	SECONDARY_CLASS,
} from "../src/pdf/text-layer-highlighter";

describe("text-layer-highlighter", () => {
	let textLayer: HTMLDivElement;

	beforeEach(() => {
		textLayer = document.createElement("div");
		textLayer.className = "textLayer";
	});

	it("injects <mark> elements for exact single-word matches", () => {
		const span1 = document.createElement("span");
		span1.textContent = "obesity-related cardiometabolic risk factors";
		const span2 = document.createElement("span");
		span2.textContent = "siotherapy and exercise";
		textLayer.appendChild(span1);
		textLayer.appendChild(span2);

		injectSecondaryHighlights(textLayer, "and", false);

		const marks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(marks.length).toBe(1);
		expect(marks[0].textContent).toBe("and");
		expect(marks[0].parentElement).toBe(span2);
	});

	it("handles multiple occurrences across multiple spans", () => {
		const span1 = document.createElement("span");
		span1.textContent = "Addressing the limitations, the present systematic review";
		const span2 = document.createElement("span");
		span2.textContent = "aimed to compare the effects of diet, the interventions";
		textLayer.appendChild(span1);
		textLayer.appendChild(span2);

		injectSecondaryHighlights(textLayer, "the", false);

		const marks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(marks.length).toBe(4);
		for (let i = 0; i < marks.length; i++) {
			expect(marks[i].textContent?.toLowerCase()).toBe("the");
		}
	});

	it("respects case sensitivity when query contains uppercase", () => {
		const span = document.createElement("span");
		span.textContent = "(MetS), which increases risk. The mets score and MetS severity";
		textLayer.appendChild(span);

		// Case sensitive (contains uppercase M, S)
		injectSecondaryHighlights(textLayer, "MetS", true);

		const marks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(marks.length).toBe(2);
		expect(marks[0].textContent).toBe("MetS");
		expect(marks[1].textContent).toBe("MetS");
	});

	it("marks active match with is-current class when targetActiveMatchIndex is provided", () => {
		const span1 = document.createElement("span");
		span1.textContent = "methodological rigor and lower";
		const span2 = document.createElement("span");
		span2.textContent = "physiotherapy and exercise trials";
		textLayer.appendChild(span1);
		textLayer.appendChild(span2);

		// Match 1 (the one in span2) is active
		injectSecondaryHighlights(textLayer, "and", false, false, 1);

		const activeMark = textLayer.querySelector("mark.incsearch-pdf-match.is-current");
		expect(activeMark).not.toBeNull();
		expect(activeMark?.textContent).toBe("and");
		expect(activeMark?.parentElement).toBe(span2);

		const secondaryMarks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(secondaryMarks.length).toBe(1);
		expect(secondaryMarks[0].textContent).toBe("and");
		expect(secondaryMarks[0].parentElement).toBe(span1);
	});

	it("auto-detects active match via intersection with PDF.js native selected element", () => {
		const span1 = document.createElement("span");
		span1.textContent = "methodological rigor and lower";

		const span2 = document.createElement("span");
		const nativeSelected = document.createElement("span");
		nativeSelected.className = "highlight selected";
		nativeSelected.textContent = "and";
		span2.appendChild(document.createTextNode("physiotherapy "));
		span2.appendChild(nativeSelected);
		span2.appendChild(document.createTextNode(" exercise trials"));

		textLayer.appendChild(span1);
		textLayer.appendChild(span2);

		// Auto-detection without explicit index
		injectSecondaryHighlights(textLayer, "and", false);

		const activeMark = textLayer.querySelector("mark.incsearch-pdf-match.is-current");
		expect(activeMark).not.toBeNull();
		expect(activeMark?.textContent).toBe("and");

		const secondaryMarks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(secondaryMarks.length).toBe(1);
		expect(secondaryMarks[0].textContent).toBe("and");
		expect(secondaryMarks[0].parentElement).toBe(span1);
	});

	it("correctly handles words split across text node boundaries", () => {
		const span1 = document.createElement("span");
		span1.textContent = "siother";
		const span2 = document.createElement("span");
		span2.textContent = "apy and exerc";
		textLayer.appendChild(span1);
		textLayer.appendChild(span2);

		injectSecondaryHighlights(textLayer, "therapy", false);

		const marks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(marks.length).toBe(2);
		expect(marks[0].textContent).toBe("ther");
		expect(marks[1].textContent).toBe("apy");
	});

	it("supports spaceAsWildcard multi-token matching with a continuous full-span mark", () => {
		const span1 = document.createElement("span");
		span1.textContent = "group comparisons and other tests";
		textLayer.appendChild(span1);

		injectSecondaryHighlights(textLayer, "group tests", false, true);

		const marks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(marks.length).toBe(1);
		expect(marks[0].textContent).toBe("group comparisons and other tests");
	});

	it("expands the active match box to cover the full wildcard sequence", () => {
		const span1 = document.createElement("span");
		const nativeSelected = document.createElement("span");
		nativeSelected.className = "highlight selected";
		nativeSelected.textContent = "systematic";
		span1.appendChild(document.createTextNode("The "));
		span1.appendChild(nativeSelected);
		span1.appendChild(document.createTextNode(" search identified 3340 records"));
		textLayer.appendChild(span1);

		injectSecondaryHighlights(textLayer, "systematic search", false, true);

		const activeMarks = textLayer.querySelectorAll("mark.incsearch-pdf-match.is-current");
		expect(activeMarks.length).toBeGreaterThan(0);
		const activeText = Array.from(activeMarks)
			.map((m) => m.textContent)
			.join("");
		expect(activeText).toBe("systematic search");
	});

	it("does not highlight standalone tokens outside of full wildcard sequences", () => {
		const span1 = document.createElement("span");
		span1.textContent = "systematic search found results. The search was thorough.";
		textLayer.appendChild(span1);

		injectSecondaryHighlights(textLayer, "systematic search", false, true);

		const marks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(marks.length).toBe(1);
		expect(marks[0].textContent).toBe("systematic search");
		// The standalone "search" at the end should NOT be highlighted
	});

	it("highlights second 'search' when it completes a wildcard sequence", () => {
		const span1 = document.createElement("span");
		span1.textContent = "systematic search found results. The systematic review was a search.";
		textLayer.appendChild(span1);

		injectSecondaryHighlights(textLayer, "systematic search", false, true);

		const marks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(marks.length).toBe(2);
		expect(marks[0].textContent).toBe("systematic search");
		expect(marks[1].textContent).toBe("systematic review was a search");
		// The second "search" is highlighted because it completes the wildcard sequence
	});

	it("marks non-active full wildcard matches as secondary", () => {
		const span1 = document.createElement("span");
		const nativeSelected = document.createElement("span");
		nativeSelected.className = "highlight selected";
		nativeSelected.textContent = "systematic";

		const text = "systematic search is key. We need systematic search here too.";
		const firstIdx = text.indexOf("systematic");
		span1.appendChild(document.createTextNode(text.slice(0, firstIdx)));
		span1.appendChild(nativeSelected);
		span1.appendChild(
			document.createTextNode(text.slice(firstIdx + "systematic".length))
		);
		textLayer.appendChild(span1);

		injectSecondaryHighlights(textLayer, "systematic search", false, true);

		const activeMarks = textLayer.querySelectorAll("mark.incsearch-pdf-match.is-current");
		expect(activeMarks.length).toBeGreaterThan(0);
		const activeText = Array.from(activeMarks)
			.map((m) => m.textContent)
			.join("");
		expect(activeText).toBe("systematic search");

		const secondaryMarks = textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`);
		expect(secondaryMarks.length).toBe(1);
		expect(secondaryMarks[0].textContent).toBe("systematic search");
	});

	it("clears secondary highlights and restores normalized DOM", () => {
		const span = document.createElement("span");
		span.textContent = "siotherapy and exercise";
		textLayer.appendChild(span);

		injectSecondaryHighlights(textLayer, "and", false);
		expect(textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`).length).toBe(1);

		clearSecondaryHighlights(textLayer);
		expect(textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`).length).toBe(0);
		expect(span.textContent).toBe("siotherapy and exercise");
		expect(span.childNodes.length).toBe(1); // normalized back to 1 text node
	});
});
