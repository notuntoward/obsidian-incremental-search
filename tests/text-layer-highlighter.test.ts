import { describe, it, expect, beforeEach } from "vitest";
import { clearSecondaryHighlights, SECONDARY_CLASS } from "../src/pdf/text-layer-highlighter";

describe("text-layer-highlighter", () => {
	let textLayer: HTMLDivElement;

	beforeEach(() => {
		textLayer = document.createElement("div");
		textLayer.className = "textLayer";
	});

	it("clears secondary highlights and restores normalized DOM", () => {
		const span = document.createElement("span");
		span.appendChild(document.createTextNode("siotherapy "));
		const mark = document.createElement("mark");
		mark.className = SECONDARY_CLASS;
		mark.textContent = "and";
		span.appendChild(mark);
		span.appendChild(document.createTextNode(" exercise"));
		textLayer.appendChild(span);

		expect(textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`).length).toBe(1);

		clearSecondaryHighlights(textLayer);
		expect(textLayer.querySelectorAll(`mark.${SECONDARY_CLASS}`).length).toBe(0);
		expect(span.textContent).toBe("siotherapy and exercise");
		expect(span.childNodes.length).toBe(1); // normalized back to 1 text node
	});
});
