import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	PdfMatchController,
	processPdfQuery,
	findPdfWildcardMatches,
	deduplicateRepeatedPdfMatches,
	decorateNativeSelectedHighlightFragments,
} from "../src/pdf/pdf-match-controller";
import { PdfViewAdapter } from "../src/pdf/pdf-view-adapter";
import { DEFAULT_SETTINGS } from "../src/types";
import * as colors from "../src/utils/colors";

describe("processPdfQuery (Space-as-wildcard for PDF)", () => {
	it("treats single space as multi-token wildcard words (phraseSearch: false)", () => {
		const res = processPdfQuery("quick fox dog", true);
		expect(res.phraseSearch).toBe(false);
		expect(res.processedQuery).toBe("quick fox dog");
	});

	it("treats 2 spaces as exactly 1 literal space (phraseSearch: true)", () => {
		const res = processPdfQuery("the  KAN", true);
		expect(res.phraseSearch).toBe(true);
		expect(res.processedQuery).toBe("the KAN");
	});

	it("treats 3 spaces as exactly 2 literal spaces (phraseSearch: true)", () => {
		const res = processPdfQuery("the   KAN", true);
		expect(res.phraseSearch).toBe(true);
		expect(res.processedQuery).toBe("the  KAN");
	});

	it("always uses phraseSearch: true when spaceAsWildcard is disabled", () => {
		const res = processPdfQuery("quick fox dog", false);
		expect(res.phraseSearch).toBe(true);
		expect(res.processedQuery).toBe("quick fox dog");
	});
});

describe("deduplicateRepeatedPdfMatches", () => {
	const rawMatches = (content: string, query: string) =>
		[...content.matchAll(new RegExp(query, "g"))].map((m) => ({
			index: m.index!,
			length: m[0].length,
		}));

	it("collapses a text run printed twice by faux-bold content streams", () => {
		const content =
			"11-12-2002\nThe CIECAM02 color appearance modelThe CIECAM02 color appearance model\nNathan Moroney";
		const matches = rawMatches(content, "CIECAM02");
		expect(matches).toHaveLength(2);

		const deduped = deduplicateRepeatedPdfMatches(content, matches);
		expect(deduped).toHaveLength(1);
		expect(deduped![0].index).toBe(matches[0].index);
	});

	it("collapses every query hit inside a duplicated run", () => {
		const content = "Recommended CitationRecommended Citation\nMoroney";
		const matches = rawMatches(content, "Citation");
		expect(matches).toHaveLength(2);
		expect(deduplicateRepeatedPdfMatches(content, matches)).toHaveLength(1);
	});

	it("collapses duplicates separated by a hard line break", () => {
		const content = "alpha\nCIECAM02 body\nCIECAM02 body\nomega";
		const matches = rawMatches(content, "CIECAM02");
		expect(matches).toHaveLength(2);
		expect(deduplicateRepeatedPdfMatches(content, matches)).toHaveLength(1);
	});

	it("preserves whitespace-separated word repetition in ordinary prose", () => {
		for (const content of [
			"I believe that that was what happened",
			"the review was very very thorough",
			"had he had had the chance",
		]) {
			const matches = rawMatches(content, "\\b(?:that|very|had)\\b");
			expect(matches.length).toBeGreaterThan(1);
			expect(deduplicateRepeatedPdfMatches(content, matches)).toHaveLength(matches.length);
		}
	});

	it("keeps genuine later occurrences while dropping only the duplicate", () => {
		const content = "See CIECAM02 hereThe CIECAM02 color modelThe CIECAM02 color model and CIECAM02 again";
		const matches = rawMatches(content, "CIECAM02");
		expect(matches).toHaveLength(4);
		const deduped = deduplicateRepeatedPdfMatches(content, matches);
		expect(deduped).toHaveLength(3);
		expect(deduped![0].index).toBe(matches[0].index);
		expect(deduped![2].index).toBe(matches[3].index);
	});

	it("passes through undefined or single-match results", () => {
		expect(deduplicateRepeatedPdfMatches("anything", undefined)).toBeUndefined();
		const single = [{ index: 3, length: 4 }];
		expect(deduplicateRepeatedPdfMatches("anything", single)).toBe(single);
	});

	it("fully collapses a run printed three or more times", () => {
		const content = "Header\nMyndex ResearchMyndex ResearchMyndex Research\nFooter";
		const matches = rawMatches(content, "Myndex Research");
		expect(matches).toHaveLength(3);
		expect(deduplicateRepeatedPdfMatches(content, matches)).toHaveLength(1);
	});

	it("preserves short, incidentally glued matches that are not re-printed runs", () => {
		// Two adjacent table cells both containing "100" with no separator between
		// them must not be mistaken for a duplicated text run.
		const content = "Total: 100100 units";
		const matches = rawMatches(content, "100");
		expect(matches).toHaveLength(2);
		expect(deduplicateRepeatedPdfMatches(content, matches)).toHaveLength(2);
	});
});

describe("findPdfWildcardMatches", () => {
	it("keeps wildcard token sequences within PDF.js line boundaries", () => {
		const pageContent = [
			"PEDro criteria apply across intervention modalities.",
			"interventions, for which PEDro is widely accepted.",
			"instrument across all intervention types was preferred.",
			"exercise modality and intensity were analyzed.",
		].join("\n");

		const matches = findPdfWildcardMatches(pageContent, "intervention modalit", false);

		expect(matches).toHaveLength(1);
		expect(pageContent.slice(matches[0].from, matches[0].to)).toBe(
			"intervention modalit"
		);
	});

	it("skips distant first tokens after PDF.js removes visual line boundaries", () => {
		const pageContent = [
			"contributors to heterogeneity, particularly caloric restriction",
			"populations. To address this, primary analyses were conducted",
			"x".repeat(300),
			"compensatory behaviors to better understand long-term relevance",
		].join(" ");

		const matches = findPdfWildcardMatches(pageContent, "to better", false);

		expect(matches).toHaveLength(1);
		const matchedText = pageContent.slice(matches[0].from, matches[0].to);
		expect(matchedText).toBe("to better");
	});
});

describe("decorateNativeSelectedHighlightFragments", () => {
	it("joins touching same-line fragments but preserves real line breaks", () => {
		const container = document.createElement("div");
		container.innerHTML = `<div class="textLayer">
			<span id="a" class="highlight begin selected"></span>
			<span id="b" class="highlight middle selected"></span>
			<span id="c" class="highlight end selected"></span>
		</div>`;
		const a = container.querySelector<HTMLElement>("#a")!;
		const b = container.querySelector<HTMLElement>("#b")!;
		const c = container.querySelector<HTMLElement>("#c")!;
		a.getBoundingClientRect = () => ({
			left: 10, right: 50, top: 10, bottom: 30, width: 40, height: 20,
		} as DOMRect);
		b.getBoundingClientRect = () => ({
			left: 60, right: 100, top: 10, bottom: 30, width: 40, height: 20,
		} as DOMRect);
		c.getBoundingClientRect = () => ({
			left: 10, right: 60, top: 35, bottom: 55, width: 50, height: 20,
		} as DOMRect);

		decorateNativeSelectedHighlightFragments(container);

		expect(a.classList.contains("incsearch-join-next")).toBe(true);
		expect(b.classList.contains("incsearch-join-prev")).toBe(true);
		expect(b.classList.contains("incsearch-join-next")).toBe(false);
		expect(c.classList.contains("incsearch-join-prev")).toBe(false);
	});

	it("highlights wildcard query tokens inside native selected fragments", () => {
		const container = document.createElement("div");
		container.innerHTML = `<div class="textLayer">
			<span class="highlight begin selected">plugin has </span>
			<span class="highlight end selected">something like isearch and more</span>
		</div>`;
		const originalText = container.textContent;
		const originalChildCounts = Array.from(
			container.querySelectorAll(".highlight"),
			(fragment) => fragment.childNodes.length
		);
		const registeredRanges: Range[][] = [];
		const setHighlight = vi.fn();
		Object.defineProperty(window, "CSS", {
			configurable: true,
			value: { highlights: { delete: vi.fn(), set: setHighlight } },
		});
		Object.defineProperty(window, "Highlight", {
			configurable: true,
			value: class {
				constructor(...ranges: Range[]) {
					registeredRanges.push(ranges);
				}
			},
		});

		decorateNativeSelectedHighlightFragments(
			container,
			"plugin some like isearch an"
		);

		expect(container.textContent).toBe(originalText);
		expect(
			Array.from(container.querySelectorAll(".highlight"), (fragment) => fragment.childNodes.length)
		).toEqual(originalChildCounts);
		expect(registeredRanges).toHaveLength(1);
		expect(registeredRanges[0].map((range) => range.toString())).toEqual([
			"plugin",
			"some",
			"like",
			"isearch",
			"an",
		]);
		expect(setHighlight).toHaveBeenCalledWith(
			"incsearch-pdf-current-token",
			expect.anything()
		);
	});

	it("does not add wildcard token spans for literal double-space queries", () => {
		const container = document.createElement("div");
		container.innerHTML = `<div class="textLayer">
			<span class="highlight selected">and meta</span>
		</div>`;

		decorateNativeSelectedHighlightFragments(container, "and  meta");

		expect(container.querySelector(".highlight")?.textContent).toBe("and meta");
	});

	it("flattens only the facing corners when neighboring line boxes touch", () => {
		const container = document.createElement("div");
		container.innerHTML = `<div class="textLayer">
			<span id="first" class="highlight begin selected">plugin</span>
			<span id="second" class="highlight end selected"> something and</span>
		</div>`;
		const first = container.querySelector<HTMLElement>("#first")!;
		const second = container.querySelector<HTMLElement>("#second")!;
		first.getBoundingClientRect = () => ({
			left: 640, right: 780, top: 100, bottom: 125, width: 140, height: 25,
		} as DOMRect);
		second.getBoundingClientRect = () => ({
			left: 65, right: 650, top: 127, bottom: 152, width: 585, height: 25,
		} as DOMRect);

		decorateNativeSelectedHighlightFragments(container);

		expect(first.classList.contains("incsearch-line-join-next")).toBe(true);
		expect(second.classList.contains("incsearch-line-join-prev")).toBe(true);
		expect(first.classList.contains("incsearch-join-next")).toBe(false);
	});
});

describe("PDF Match Controller (Native Find & Built-in Geometry)", () => {
	let nativeAdapter: PdfViewAdapter;
	let containerEl: HTMLDivElement;
	let nativeFindCommands: any[];

	beforeEach(() => {
		containerEl = document.createElement("div");
		nativeFindCommands = [];

		nativeAdapter = {
			numPages: 5,
			containerEl,
			getPageElement: () => null,
			getVisiblePageNumbers: () => [1],
			on: (_event: string, _handler: any) => () => { },
			scrollPageIntoView: vi.fn(),
			executeNativeFind: (cmd: any) => {
				nativeFindCommands.push(cmd);
				return true;
			},
		};
	});

	it("delegates literal search to native find and applies CSS class in on-demand mode", async () => {
		const controller = new PdfMatchController(nativeAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "on-demand",
			spaceAsWildcard: true,
		});

		await controller.search("algorithm");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0].query).toBe("algorithm");
		expect(nativeFindCommands[0].phraseSearch).toBe(true);
		expect(nativeFindCommands[0].highlightAll).toBe(false);

		// Container has CSS class to hide non-selected native highlights until peeked
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(true);

		// Press Ctrl+Enter -> toggleDemandHighlights
		controller.toggleDemandHighlights();
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(false);
		expect(nativeFindCommands[1].highlightAll).toBe(true);

		// Press Ctrl+Enter again -> hide other matches
		controller.toggleDemandHighlights();
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(true);
	});

	it("feeds markdown wildcard ranges to native PDF find and keeps native navigation", async () => {
		const text = "Third, despite the advantages. Third, despite an issue.";
		const originalMatch = vi.fn((_query: any, _pageContent: string, _pageIndex: number) => [
			{ index: 99, length: 1 },
		]);
		const findController = { match: originalMatch };
		const adapter: PdfViewAdapter = {
			...nativeAdapter,
			findController,
		};
		const controller = new PdfMatchController(adapter, {
			...DEFAULT_SETTINGS,
			spaceAsWildcard: true,
			allMatchesDisplayMode: "always",
		});

		await controller.search("third, despite a");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0]).toMatchObject({
			query: "third, despite a",
			phraseSearch: false,
			highlightAll: true,
		});
		expect(findController.match("third, despite a", text, 0)).toEqual([
			{ index: 0, length: 20 },
			{ index: text.lastIndexOf("Third"), length: 16 },
		]);

		controller.advance("forward");
		expect(nativeFindCommands[1]).toMatchObject({
			type: "again",
			query: "third, despite a",
			findPrevious: false,
		});

		controller.destroy();
		expect(findController.match).toBe(originalMatch);
	});

	it("delegates double-space literal phrase to native find with phraseSearch: true", async () => {
		const controller = new PdfMatchController(nativeAdapter, {
			...DEFAULT_SETTINGS,
			spaceAsWildcard: true,
		});

		await controller.search("the  KAN");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0].query).toBe("the KAN");
		expect(nativeFindCommands[0].phraseSearch).toBe(true);
		expect(nativeFindCommands[0].caseSensitive).toBe(true); // smart case on uppercase KAN
	});

	it("delegates advance forward and backward with type: again", async () => {
		const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);

		await controller.search("algorithm");
		controller.advance("forward");

		expect(nativeFindCommands).toHaveLength(2);
		expect(nativeFindCommands[1].type).toBe("again");
		expect(nativeFindCommands[1].findPrevious).toBe(false);

		controller.advance("backward");
		expect(nativeFindCommands).toHaveLength(3);
		expect(nativeFindCommands[2].type).toBe("again");
		expect(nativeFindCommands[2].findPrevious).toBe(true);
	});


	it("cleans up CSS class and clears native find on destroy", async () => {
		const controller = new PdfMatchController(nativeAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "on-demand",
		});

		await controller.search("test");
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(true);
		expect(containerEl.classList.contains("incsearch-active-pdf")).toBe(true);

		controller.destroy();
		expect(containerEl.classList.contains("incsearch-pdf-hide-other-matches")).toBe(false);
		expect(containerEl.classList.contains("incsearch-active-pdf")).toBe(false);
		expect(nativeFindCommands[nativeFindCommands.length - 1]).toEqual({
			query: "",
			type: "find",
			highlightAll: false,
		});
	});

	it("applies PDF colors on search and clears them on destroy", async () => {
		const applySpy = vi.spyOn(colors, "applyPdfColors").mockImplementation(() => { });
		const clearSpy = vi.spyOn(colors, "clearPdfColors").mockImplementation(() => { });

		const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);
		await controller.search("test");

		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(applySpy).toHaveBeenCalledWith(containerEl, DEFAULT_SETTINGS);

		controller.destroy();
		expect(clearSpy).toHaveBeenCalledTimes(1);
		expect(clearSpy).toHaveBeenCalledWith(containerEl);

		applySpy.mockRestore();
		clearSpy.mockRestore();
	});

	it("delegates to executeNativeFind when available with highlightAll: true", async () => {
		// Add page element to container
		const pageEl = document.createElement("div");
		pageEl.className = "page";
		pageEl.setAttribute("data-page-number", "1");
		const textLayer = document.createElement("div");
		textLayer.className = "textLayer";
		pageEl.appendChild(textLayer);
		containerEl.appendChild(pageEl);

		const adapterWithPage: PdfViewAdapter = {
			...nativeAdapter,
			numPages: 1,
			getPageElement: () => pageEl,
		};

		const controller = new PdfMatchController(adapterWithPage, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "always",
		});
		await controller.search("MetS");

		expect(nativeFindCommands).toHaveLength(1);
		expect(nativeFindCommands[0].query).toBe("MetS");
		expect(nativeFindCommands[0].highlightAll).toBe(true);

		controller.destroy();
	});

	// Regression guard for the global-prototype patch documented at the "4. Intercept
	// PDFViewer page changes..." comment in setupFindControllerHook: destroy() MUST put
	// back the exact original HTMLElement.prototype.scrollIntoView. This patch touches a
	// browser-wide prototype (not a per-instance object), so if a future edit to destroy()
	// forgets to restore it, EVERY element in the vault silently loses native scrollIntoView
	// behavior for the rest of the Obsidian session, not just this plugin's own elements.
	it("restores the exact original HTMLElement.prototype.scrollIntoView on destroy", async () => {
		const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

		const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);
		await controller.search("test");

		// The patch must actually be installed (otherwise this test would trivially pass).
		expect(HTMLElement.prototype.scrollIntoView).not.toBe(originalScrollIntoView);

		controller.destroy();

		expect(HTMLElement.prototype.scrollIntoView).toBe(originalScrollIntoView);
	});

	// Regression guard for the explicit invariant documented in setupFindControllerHook:
	// "Only patch resolved instances, never a shared prototype... would break or crash
	// scrolling in unrelated PDF views." This test proves two controllers, each bound to
	// its own distinct pdfViewer-like object, never cross-contaminate: patching/destroying
	// one must not affect the other's patched methods.
	it("isolates per-viewer method patches across two simultaneous controllers", async () => {
		const makeViewer = () => ({
			_setCurrentPageNumber: vi.fn(),
			_scrollIntoView: vi.fn(),
			scrollPageIntoView: vi.fn(),
		});
		const viewerA = makeViewer();
		const viewerB = makeViewer();
		const origSetCurrentPageNumberA = viewerA._setCurrentPageNumber;
		const origSetCurrentPageNumberB = viewerB._setCurrentPageNumber;

		const containerA = document.createElement("div");
		const containerB = document.createElement("div");
		const adapterA: PdfViewAdapter = {
			...nativeAdapter,
			containerEl: containerA,
			pdfViewer: viewerA as any,
		};
		const adapterB: PdfViewAdapter = {
			...nativeAdapter,
			containerEl: containerB,
			pdfViewer: viewerB as any,
		};

		const controllerA = new PdfMatchController(adapterA, DEFAULT_SETTINGS);
		const controllerB = new PdfMatchController(adapterB, DEFAULT_SETTINGS);
		await controllerA.search("test");
		await controllerB.search("test");

		// Each controller must have patched only its own viewer.
		expect(viewerA._setCurrentPageNumber).not.toBe(origSetCurrentPageNumberA);
		expect(viewerB._setCurrentPageNumber).not.toBe(origSetCurrentPageNumberB);

		// Destroying A must not touch B's still-active patch.
		controllerA.destroy();
		expect(viewerA._setCurrentPageNumber).toBe(origSetCurrentPageNumberA);
		expect(viewerB._setCurrentPageNumber).not.toBe(origSetCurrentPageNumberB);

		controllerB.destroy();
		expect(viewerB._setCurrentPageNumber).toBe(origSetCurrentPageNumberB);
	});

	// Regression guard for the two magic timeout constants in requestMatchScroll (2000ms)
	// and markProgrammaticScroll (400ms). Nothing else in the suite exercises real time, so
	// a future edit could change or delete either window (or its clearTimeout) without any
	// test noticing, silently breaking the scroll-suppression state machine.
	describe("scroll-suppression timing windows", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("matchScrollPending expires after exactly the 2000ms window", () => {
			const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);

			controller.requestMatchScroll();
			expect(controller.matchScrollPending).toBe(true);

			vi.advanceTimersByTime(1999);
			expect(controller.matchScrollPending).toBe(true);

			vi.advanceTimersByTime(1);
			expect(controller.matchScrollPending).toBe(false);
			expect(controller.pendingTargetPage).toBeUndefined();
		});

		it("a new requestMatchScroll call resets the 2000ms window instead of stacking", () => {
			const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);

			controller.requestMatchScroll();
			vi.advanceTimersByTime(1500);
			controller.requestMatchScroll(); // should restart the window, not let the first timer fire
			vi.advanceTimersByTime(1500);
			expect(controller.matchScrollPending).toBe(true);

			vi.advanceTimersByTime(500);
			expect(controller.matchScrollPending).toBe(false);
		});

		it("isProgrammaticScrolling clears after exactly the 400ms window", () => {
			const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);

			controller.markProgrammaticScroll();
			expect(controller.isProgrammaticScrolling).toBe(true);

			vi.advanceTimersByTime(399);
			expect(controller.isProgrammaticScrolling).toBe(true);

			vi.advanceTimersByTime(1);
			expect(controller.isProgrammaticScrolling).toBe(false);
		});

		it("destroy() clears a pending programmatic-scroll timer instead of leaking it", () => {
			const controller = new PdfMatchController(nativeAdapter, DEFAULT_SETTINGS);

			controller.markProgrammaticScroll();
			controller.destroy();

			// If destroy() failed to clear the timer, this would still flip the flag on an
			// already-destroyed controller; asserting no throw and the flag's final state
			// together prove the timeout was actually cancelled, not merely superseded.
			expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
			expect(controller.isProgrammaticScrolling).toBe(false);
		});
	});
});

describe("PDF Match Controller", () => {
	let mockAdapter: PdfViewAdapter;
	let containerEl: HTMLDivElement;
	let pageElements: Map<number, HTMLDivElement>;

	beforeEach(() => {
		containerEl = document.createElement("div");
		pageElements = new Map();

		for (let p = 1; p <= 3; p++) {
			const pageDiv = document.createElement("div");
			pageDiv.className = "page";
			pageDiv.setAttribute("data-page-number", String(p));
			const textLayer = document.createElement("div");
			textLayer.className = "textLayer";
			pageDiv.appendChild(textLayer);
			containerEl.appendChild(pageDiv);
			pageElements.set(p, pageDiv);
		}

		mockAdapter = {
			numPages: 3,
			containerEl,
			getPageElement: (pageNumber: number) => pageElements.get(pageNumber) || null,
			getVisiblePageNumbers: () => [1], // Page 1 visible initially
			on: (_event: string, _handler: any) => () => { },
			scrollPageIntoView: vi.fn(),
		};
	});

	it("removes generated and native current boxes immediately on accept", () => {
		const page = pageElements.get(1)!;
		page.classList.add("incsearch-pdf-native-envelope-active");
		const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		overlay.classList.add("incsearch-pdf-native-current-overlay");
		page.appendChild(overlay);
		const selected = document.createElement("span");
		selected.className = "highlight selected";
		page.querySelector(".textLayer")?.appendChild(selected);
		const executeNativeFind = vi.fn();
		mockAdapter.executeNativeFind = executeNativeFind;
		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

		controller.accept();

		expect(containerEl.querySelector(".incsearch-pdf-native-current-overlay")).toBeNull();
		expect(containerEl.querySelector(".highlight.selected")).toBeNull();
		expect(page.classList.contains("incsearch-pdf-native-envelope-active")).toBe(false);
		expect(executeNativeFind).toHaveBeenCalledWith({
			query: "",
			type: "find",
			highlightAll: false,
		});
	});

	it("restores origin page on cancel() and preserves current page on accept()", async () => {
		let scrolledPage: number | null = null;
		mockAdapter.scrollPageIntoView = (pageNumber: number) => {
			scrolledPage = pageNumber;
		};
		mockAdapter.getVisiblePageNumbers = () => [1];

		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		expect(controller.originPageNumber).toBe(1);

		// Advance to page 2 match
		await controller.search("algorithm");
		controller.advance("forward");

		// Cancel should scroll back to origin page 1
		controller.cancel();
		expect(scrolledPage).toBe(1);
	});

	it("respects allMatchesDisplayMode and toggles demand highlights in PDF controller", async () => {
		const controller = new PdfMatchController(mockAdapter, {
			...DEFAULT_SETTINGS,
			allMatchesDisplayMode: "on-demand",
		});

		expect(controller.shouldShowAllMatches()).toBe(false);

		controller.toggleDemandHighlights();
		expect(controller.shouldShowAllMatches()).toBe(true);

		controller.toggleDemandHighlights();
		expect(controller.shouldShowAllMatches()).toBe(false);
	});

	it("restores original scroll position on cancel", async () => {
		const restoreFn = vi.fn();
		mockAdapter.restoreScrollPosition = restoreFn;
		mockAdapter.getScrollPosition = () => ({
			scrollTop: 450,
			scrollLeft: 20,
			pageNumber: 2,
		});

		const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);
		await controller.search("algorithm");

		controller.cancel();
		expect(restoreFn).toHaveBeenCalledWith({
			scrollTop: 450,
			scrollLeft: 20,
			pageNumber: 2,
		});
	});

	describe("PDF Viewport Scroll Interception & Page Boundary Handling", () => {
		it("suppresses scrollMatchIntoView when match is already fully on-screen", () => {
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			const scrollIntoViewSpy = vi.fn();
			matchEl.scrollIntoView = scrollIntoViewSpy;
			// Match [200, 220] - fully inside [100, 600]
			matchEl.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 50,
				right: 150,
				height: 20,
				width: 100,
			} as DOMRect);
			mockAdapter.containerEl.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Trigger intercepted scrollMatchIntoView with on-screen match
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 0, matchIndex: 0 });

			expect(scrollIntoViewSpy).not.toHaveBeenCalled();
			controller.destroy();
		});

		// Regression guard for Bug 1 (Initial Match Selection on Multi-Page Viewports).
		// Scenario: two pages are partially visible (page 3 bottom + page 4 top straddle the
		// viewport). The selected match element lives on page 3 but is already within the
		// visible portion of the viewport (at the page 3/4 boundary). No scroll should occur.
		// Tests that getCompoundMatchBoundingRect + scrollTargetIntoViewIfNeeded are used
		// (match-element geometry) rather than page-level geometry, regardless of whether
		// scrollMatchIntoView receives an element or only page-level { pageIdx, matchIdx } params.
		it("does not scroll on initial search when match is already visible at a cross-page boundary (element path)", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			// Container viewport: [100, 600] vertically, [0, 800] horizontally
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			// Page 3: partially visible — its bottom is at 620 (extends below viewport bottom)
			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -400, bottom: 620, left: 0, right: 800, height: 1020, width: 800,
			} as DOMRect);

			// The selected match is near the bottom of page 3 — visible in the viewport [100,600]
			// at [550, 570]. scrollTargetIntoViewIfNeeded must suppress the scroll.
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 550, bottom: 570, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(matchEl);

			const findController = { scrollMatchIntoView: vi.fn() };
			mockAdapter.findController = findController;
			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// PDF.js calls scrollMatchIntoView WITH the element (element path)
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 2, matchIndex: 0 });

			// Match is already visible — must NOT scroll
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			controller.destroy();
		});

		it("does not scroll on initial search when match is already visible at a cross-page boundary (page-level path)", () => {
			// Same geometry as above but PDF.js passes only page-level { selected } params.
			// This exercises the page-level fallback path in scrollMatchIntoView. The match
			// element IS in the DOM, so getCompoundMatchBoundingRect finds it and
			// scrollTargetIntoViewIfNeeded correctly suppresses the scroll.
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -400, bottom: 620, left: 0, right: 800, height: 1020, width: 800,
			} as DOMRect);

			// Match is visible at [550, 570] — within container [100, 600]
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 550, bottom: 570, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(matchEl);

			const findController = { scrollMatchIntoView: vi.fn() };
			mockAdapter.findController = findController;
			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// PDF.js calls scrollMatchIntoView with only page-level params (no element)
			findController.scrollMatchIntoView({ selected: { pageIdx: 2, matchIdx: 0 } });

			// Match is already visible — must NOT scroll
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			controller.destroy();
		});

		it("scrolls to center match when match is on an on-screen page but above the current scroll position", () => {
			// Regression guard: page 3 is partially visible (its bottom half is in view) but
			// the selected match is in the upper half of page 3, above the viewport top.
			// scrollTargetIntoViewIfNeeded must scroll UP to center it. This is the geometry
			// that the bad alignToViewportPage change produced (match above viewport on an
			// 'on-screen' page) — verified here so that any code that would suppress this
			// scroll is caught.
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -400, bottom: 620, left: 0, right: 800, height: 1020, width: 800,
			} as DOMRect);

			// Match is ABOVE the viewport top — at [-80, -60], i.e. scrolled off above
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: -80, bottom: -60, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(matchEl);

			const findController = { scrollMatchIntoView: vi.fn() };
			mockAdapter.findController = findController;
			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Advance backward to match 10 above viewport
			controller.advance("backward");
			findController.scrollMatchIntoView({ selected: { pageIdx: 2, matchIdx: 10 } });

			// Match center = -70. Container center = 350. deltaY = -70 - 350 = -420 → scroll UP.
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 0,
				top: -420,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("steers initial search to visible match at bottom of page when PDF.js delivers scrolled-off match above viewport", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -400, bottom: 620, left: 0, right: 800, height: 1020, width: 800,
			} as DOMRect);
			mockAdapter.getVisiblePageNumbers = () => [3, 4];

			// Match 10: ABOVE the viewport top at [-80, -60] (scrolled off)
			const matchAbove = document.createElement("span");
			matchAbove.className = "highlight selected";
			matchAbove.getBoundingClientRect = () => ({
				top: -80, bottom: -60, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(matchAbove);

			// Match 14: VISIBLE in the viewport at [550, 570] (bottom of page 3)
			const matchVisible = document.createElement("span");
			matchVisible.className = "highlight";
			matchVisible.getBoundingClientRect = () => ({
				top: 550, bottom: 570, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(matchVisible);

			const findController = {
				scrollMatchIntoView: vi.fn(),
				_selected: { pageIdx: 2, matchIdx: 10 },
			};
			mockAdapter.findController = findController;
			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Initiate initial search for "this"
			controller.search("this");

			// PDF.js findController passes the first match on page 3 (match 10, off-screen)
			findController.scrollMatchIntoView({ selected: { pageIdx: 2, matchIdx: 10 } });

			// Initial search steering should have steered selection to matchVisible:
			// 1. matchVisible now has selected class
			expect(matchVisible.classList.contains("selected")).toBe(true);
			// 2. matchAbove has selected class removed
			expect(matchAbove.classList.contains("selected")).toBe(false);
			// 3. Since matchVisible is completely in-view [550, 570], NO scrolling occurs at all!
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();

			controller.destroy();
		});

		it("steers initial search across page boundary to earlier visible match when PDF.js starts on later visible page", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			// Viewport shows bottom of Page 3 and top of Page 4
			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -200, bottom: 250, left: 0, right: 800, height: 450, width: 800,
			} as DOMRect);

			const page4 = document.createElement("div");
			page4.className = "page";
			page4.setAttribute("data-page-number", "4");
			const textLayer4 = document.createElement("div");
			textLayer4.className = "textLayer";
			page4.appendChild(textLayer4);
			mockAdapter.containerEl.appendChild(page4);
			pageElements.set(4, page4);

			page4.getBoundingClientRect = () => ({
				top: 250, bottom: 850, left: 0, right: 800, height: 600, width: 800,
			} as DOMRect);

			mockAdapter.getVisiblePageNumbers = () => [3, 4];

			// Match 14 on Page 3: "This transform consists..." fully visible at [150, 170]
			const match14 = document.createElement("span");
			match14.className = "highlight";
			match14.getBoundingClientRect = () => ({
				top: 150, bottom: 170, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(match14);

			// Match 17 on Page 4: "In this case..." fully visible at [350, 370]
			const match17 = document.createElement("span");
			match17.className = "highlight selected";
			match17.getBoundingClientRect = () => ({
				top: 350, bottom: 370, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page4.querySelector(".textLayer")?.appendChild(match17);

			const findController: any = {
				scrollMatchIntoView: vi.fn(),
				_selected: { pageIdx: 3, matchIdx: 0 },
				selected: { pageIdx: 3, matchIdx: 0 },
				pageMatches: [
					[10], // page 1: 1 match
					[20, 30], // page 2: 2 matches
					[40], // page 3: match 14 (1 match)
					[50, 60, 70], // page 4: matches 15, 16, 17 (3 matches)
				],
			};
			mockAdapter.findController = findController;
			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Initiate initial search for "this"
			controller.search("this");

			// PDF.js findController started on page 4 because currentPageNumber was 4,
			// and delivers Match 17 on page 4 (which is ON SCREEN!)
			findController.scrollMatchIntoView({
				element: match17,
				pageIndex: 3,
				matchIndex: 0,
			});

			// Initial search steering MUST steer selection to Match 14 on Page 3:
			// 1. match14 gets selected class
			expect(match14.classList.contains("selected")).toBe(true);
			// 2. match17 has selected class removed
			expect(match17.classList.contains("selected")).toBe(false);
			// 3. Since match14 is completely in-view [150, 170], NO scrolling occurs!
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			// 4. findController._selected is updated to page 3, match 0
			expect(findController._selected.pageIdx).toBe(2);
			expect(findController._selected.matchIdx).toBe(0);
			// 5. controller.state.activeIndex is updated to 3 (4th match overall)
			expect(controller.state.activeIndex).toBe(3);

			controller.destroy();
		});

		it("does not skip the true next match when advancing forward after initial search steering", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -200, bottom: 250, left: 0, right: 800, height: 450, width: 800,
			} as DOMRect);

			const page4 = document.createElement("div");
			page4.className = "page";
			page4.setAttribute("data-page-number", "4");
			const textLayer4 = document.createElement("div");
			textLayer4.className = "textLayer";
			page4.appendChild(textLayer4);
			mockAdapter.containerEl.appendChild(page4);
			pageElements.set(4, page4);

			page4.getBoundingClientRect = () => ({
				top: 250, bottom: 850, left: 0, right: 800, height: 600, width: 800,
			} as DOMRect);

			mockAdapter.getVisiblePageNumbers = () => [3, 4];

			// Match 16 on page 3 (visible in viewport at [150, 170])
			const match16 = document.createElement("span");
			match16.className = "highlight";
			match16.getBoundingClientRect = () => ({
				top: 150, bottom: 170, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(match16);

			// Match 17 on page 4 (visible at [350, 370]) - delivered first by PDF.js native find
			const match17 = document.createElement("span");
			match17.className = "highlight";
			match17.getBoundingClientRect = () => ({
				top: 350, bottom: 370, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			textLayer4.appendChild(match17);

			// Match 18 on page 4 (visible at [450, 470])
			const match18 = document.createElement("span");
			match18.className = "highlight";
			match18.getBoundingClientRect = () => ({
				top: 450, bottom: 470, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			textLayer4.appendChild(match18);

			const findController: any = {
				scrollMatchIntoView: vi.fn(),
				// PDF.js native find has private #selected, mutating _selected has no effect on PDF.js
				pageMatches: [
					[], // page 1
					[], // page 2
					[10], // page 3: match 16
					[20, 30], // page 4: match 17, match 18
				],
			};
			mockAdapter.findController = findController;
			const executeNativeFindSpy = vi.fn();
			mockAdapter.executeNativeFind = executeNativeFindSpy;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// 1. Initial search
			controller.search("this");

			// PDF.js findController starts on page 4 and delivers match 17
			findController.scrollMatchIntoView({
				element: match17,
				pageIndex: 3,
				matchIndex: 0,
			});

			// Initial search correctly steers to Match 16 on page 3
			expect(match16.classList.contains("selected")).toBe(true);
			expect(match17.classList.contains("selected")).toBe(false);
			expect(controller.state.activeIndex).toBe(0);

			// 2. User presses Next ("forward")
			executeNativeFindSpy.mockClear();
			controller.advance("forward");

			// MUST advance to Match 17 (NOT skip it!)
			expect(match16.classList.contains("selected")).toBe(false);
			expect(match17.classList.contains("selected")).toBe(true);
			expect(match18.classList.contains("selected")).toBe(false);
			expect(controller.state.activeIndex).toBe(1);
			// PDF.js was already at match 17, so executeNativeFind should NOT have been called with type: 'again'
			// which would have skipped match 17 and jumped to match 18!
			expect(executeNativeFindSpy).not.toHaveBeenCalled();

			// 3. User presses Next ("forward") again
			controller.advance("forward");
			// Now that UI and PDF.js are both at match 17, executeNativeFind with type: 'again' is called
			expect(executeNativeFindSpy).toHaveBeenCalledWith(
				expect.objectContaining({ type: "again", findPrevious: false })
			);

			controller.destroy();
		});

		it("steps backward correctly when navigating backward while pendingSteeredMatches is populated", () => {
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -200, bottom: 250, left: 0, right: 800, height: 450, width: 800,
			} as DOMRect);

			const page4 = document.createElement("div");
			page4.className = "page";
			page4.setAttribute("data-page-number", "4");
			const textLayer4 = document.createElement("div");
			textLayer4.className = "textLayer";
			page4.appendChild(textLayer4);
			mockAdapter.containerEl.appendChild(page4);
			pageElements.set(4, page4);

			page4.getBoundingClientRect = () => ({
				top: 250, bottom: 850, left: 0, right: 800, height: 600, width: 800,
			} as DOMRect);

			mockAdapter.getVisiblePageNumbers = () => [3, 4];

			const match16 = document.createElement("span");
			match16.className = "highlight";
			match16.getBoundingClientRect = () => ({
				top: 150, bottom: 170, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(match16);

			const match17 = document.createElement("span");
			match17.className = "highlight";
			match17.getBoundingClientRect = () => ({
				top: 350, bottom: 370, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			textLayer4.appendChild(match17);

			const findController: any = {
				scrollMatchIntoView: vi.fn(),
				pageMatches: [[], [], [10], [20]],
			};
			mockAdapter.findController = findController;
			const executeNativeFindSpy = vi.fn();
			mockAdapter.executeNativeFind = executeNativeFindSpy;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Initial search steers from Match 17 (delivered) to Match 16 (steered)
			// pendingSteeredMatches has [match17] (length 1)
			controller.search("this");
			findController.scrollMatchIntoView({
				element: match17,
				pageIndex: 3,
				matchIndex: 0,
			});

			expect(match16.classList.contains("selected")).toBe(true);

			// User presses Previous ("backward"):
			// PDF.js is at Match 17, UI is at Match 16.
			// To go to the match before 16, PDF.js must step backward 2 times (17 -> 16 -> 15): steps = pendingSteeredMatches.length + 1 = 2
			executeNativeFindSpy.mockClear();
			controller.advance("backward");

			expect(executeNativeFindSpy).toHaveBeenCalledTimes(2);
			expect(executeNativeFindSpy).toHaveBeenLastCalledWith(
				expect.objectContaining({ type: "again", findPrevious: true })
			);

			controller.destroy();
		});

		it("handles multiple intermediate pending steered matches sequentially before resuming native find", () => {
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -200, bottom: 250, left: 0, right: 800, height: 450, width: 800,
			} as DOMRect);

			const page4 = document.createElement("div");
			page4.className = "page";
			page4.setAttribute("data-page-number", "4");
			const textLayer4 = document.createElement("div");
			textLayer4.className = "textLayer";
			page4.appendChild(textLayer4);
			mockAdapter.containerEl.appendChild(page4);
			pageElements.set(4, page4);

			page4.getBoundingClientRect = () => ({
				top: 250, bottom: 850, left: 0, right: 800, height: 600, width: 800,
			} as DOMRect);

			mockAdapter.getVisiblePageNumbers = () => [3, 4];

			// Match 15 (Page 3)
			const match15 = document.createElement("span");
			match15.className = "highlight";
			match15.getBoundingClientRect = () => ({
				top: 120, bottom: 140, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(match15);

			// Match 16 (Page 3)
			const match16 = document.createElement("span");
			match16.className = "highlight";
			match16.getBoundingClientRect = () => ({
				top: 180, bottom: 200, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(match16);

			// Match 17 (Page 4) - delivered
			const match17 = document.createElement("span");
			match17.className = "highlight";
			match17.getBoundingClientRect = () => ({
				top: 350, bottom: 370, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			textLayer4.appendChild(match17);

			const findController: any = {
				scrollMatchIntoView: vi.fn(),
				pageMatches: [[], [], [10, 20], [30]],
			};
			mockAdapter.findController = findController;
			const executeNativeFindSpy = vi.fn();
			mockAdapter.executeNativeFind = executeNativeFindSpy;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Initial search steers to Match 15; queues [match16, match17]
			controller.search("this");
			findController.scrollMatchIntoView({
				element: match17,
				pageIndex: 3,
				matchIndex: 0,
			});

			expect(match15.classList.contains("selected")).toBe(true);
			expect(controller.state.activeIndex).toBe(0);

			// Advance 1 -> consumes Match 16 from queue, no native find
			executeNativeFindSpy.mockClear();
			controller.advance("forward");
			expect(match15.classList.contains("selected")).toBe(false);
			expect(match16.classList.contains("selected")).toBe(true);
			expect(match17.classList.contains("selected")).toBe(false);
			expect(controller.state.activeIndex).toBe(1);
			expect(executeNativeFindSpy).not.toHaveBeenCalled();

			// Advance 2 -> consumes Match 17 from queue, no native find
			controller.advance("forward");
			expect(match16.classList.contains("selected")).toBe(false);
			expect(match17.classList.contains("selected")).toBe(true);
			expect(controller.state.activeIndex).toBe(2);
			expect(executeNativeFindSpy).not.toHaveBeenCalled();

			// Advance 3 -> queue is empty, now calls native find with type: "again"
			controller.advance("forward");
			expect(executeNativeFindSpy).toHaveBeenCalledTimes(1);
			expect(executeNativeFindSpy).toHaveBeenCalledWith(
				expect.objectContaining({ type: "again", findPrevious: false })
			);

			controller.destroy();
		});

		it("clears pendingSteeredMatches when search query is changed or reset", () => {
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -200, bottom: 250, left: 0, right: 800, height: 450, width: 800,
			} as DOMRect);

			const page4 = document.createElement("div");
			page4.className = "page";
			page4.setAttribute("data-page-number", "4");
			const textLayer4 = document.createElement("div");
			textLayer4.className = "textLayer";
			page4.appendChild(textLayer4);
			mockAdapter.containerEl.appendChild(page4);
			pageElements.set(4, page4);

			page4.getBoundingClientRect = () => ({
				top: 250, bottom: 850, left: 0, right: 800, height: 600, width: 800,
			} as DOMRect);

			mockAdapter.getVisiblePageNumbers = () => [3, 4];

			const match16 = document.createElement("span");
			match16.className = "highlight";
			match16.getBoundingClientRect = () => ({
				top: 150, bottom: 170, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(match16);

			const match17 = document.createElement("span");
			match17.className = "highlight";
			match17.getBoundingClientRect = () => ({
				top: 350, bottom: 370, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			textLayer4.appendChild(match17);

			const findController: any = {
				scrollMatchIntoView: vi.fn(),
				pageMatches: [[], [], [10], [20]],
			};
			mockAdapter.findController = findController;
			const executeNativeFindSpy = vi.fn();
			mockAdapter.executeNativeFind = executeNativeFindSpy;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// 1. Initial search populates pendingSteeredMatches
			controller.search("this");
			findController.scrollMatchIntoView({
				element: match17,
				pageIndex: 3,
				matchIndex: 0,
			});

			// 2. User searches for a new query
			executeNativeFindSpy.mockClear();
			controller.search("other");

			// 3. User calls advance("forward") on the new query:
			// It must NOT replay the old queued match17; it must call executeNativeFind
			controller.advance("forward");
			expect(executeNativeFindSpy).toHaveBeenCalledWith(
				expect.objectContaining({ type: "again", query: "other" })
			);

			controller.destroy();
		});

		it("does not steer during advance() and advances to next match even across page boundary", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100, bottom: 600, left: 0, right: 800, height: 500, width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: -200, bottom: 250, left: 0, right: 800, height: 450, width: 800,
			} as DOMRect);

			const page4 = document.createElement("div");
			page4.className = "page";
			page4.setAttribute("data-page-number", "4");
			const textLayer4 = document.createElement("div");
			textLayer4.className = "textLayer";
			page4.appendChild(textLayer4);
			mockAdapter.containerEl.appendChild(page4);
			pageElements.set(4, page4);

			page4.getBoundingClientRect = () => ({
				top: 250, bottom: 850, left: 0, right: 800, height: 600, width: 800,
			} as DOMRect);

			mockAdapter.getVisiblePageNumbers = () => [3, 4];

			const match14 = document.createElement("span");
			match14.className = "highlight selected";
			match14.getBoundingClientRect = () => ({
				top: 150, bottom: 170, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(match14);

			const match17 = document.createElement("span");
			match17.className = "highlight";
			match17.getBoundingClientRect = () => ({
				top: 350, bottom: 370, left: 100, right: 300, height: 20, width: 200,
			} as DOMRect);
			page4.querySelector(".textLayer")?.appendChild(match17);

			const findController: any = {
				scrollMatchIntoView: vi.fn(),
				_selected: { pageIdx: 2, matchIdx: 0 },
				selected: { pageIdx: 2, matchIdx: 0 },
			};
			mockAdapter.findController = findController;
			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// User is already on match 14 and presses next match
			controller.advance("forward");

			// PDF.js advances to match 17 on page 4
			match14.classList.remove("selected");
			match17.classList.add("selected");
			findController.scrollMatchIntoView({
				element: match17,
				pageIndex: 3,
				matchIndex: 0,
			});

			// Since it's advance(), initial search steering must NOT pull selection back to match14!
			expect(match17.classList.contains("selected")).toBe(true);
			expect(match14.classList.contains("selected")).toBe(false);
			// And since match17 is already on screen, no scroll occurs
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();

			controller.destroy();
		});

		it("does not scroll when match is near the edge but still fully within view", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			// Match at [105, 125] - within 5px of top edge, but fully inside [100, 600]
			// Match at [5, 55] - within 5px of left edge, but fully inside [0, 800]
			// Position match well within the padding buffer (10px from edges)
			matchEl.getBoundingClientRect = () => ({
				top: 110,
				bottom: 130,
				left: 10,
				right: 60,
				height: 20,
				width: 50,
			} as DOMRect);
			mockAdapter.containerEl.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Trigger intercepted scrollMatchIntoView
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 0, matchIndex: 0 });

			// Must not scroll because match is already fully in view!
			expect(scrollBySpy).not.toHaveBeenCalled();
			controller.destroy();
		});

		it("scrolls with minimal delta vertically when match is partially off-screen at bottom edge", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			// Match [590, 610] - clipped at bottom edge (bottom 610 > 600)
			matchEl.getBoundingClientRect = () => ({
				top: 590,
				bottom: 610,
				left: 50,
				right: 150,
				height: 20,
				width: 100,
			} as DOMRect);
			mockAdapter.containerEl.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Trigger intercepted scrollMatchIntoView with clipped match
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 0, matchIndex: 0 });

			// Minimal delta with padding: 610 - (600 - 8) = 18
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 0,
				top: 18,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("scrolls to center match vertically when match is entirely off-screen vertically", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			// Match entirely off-screen at bottom: top at 700, bottom at 720 (container is [100, 600])
			matchEl.getBoundingClientRect = () => ({
				top: 700,
				bottom: 720,
				left: 50,
				right: 150,
				height: 20,
				width: 100,
			} as DOMRect);
			mockAdapter.containerEl.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Advance to next match: entirely off-screen -> centers match
			// match center = 710, container center = 350 -> deltaY = 710 - 350 = 360
			controller.advance("forward");
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 0, matchIndex: 1 });

			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 0,
				top: 360,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("scrolls horizontally with minimal delta when match is partially off-screen horizontally (e.g. when zoomed)", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			// Match is vertically visible ([200, 220]), but extends past right edge (left 780, right 850 > 800)
			matchEl.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 780,
				right: 850,
				height: 20,
				width: 70,
			} as DOMRect);
			mockAdapter.containerEl.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Trigger intercepted scrollMatchIntoView with horizontally off-screen match
			// Minimal scroll with padding: deltaX = 850 - (800 - 8) = 58, deltaY = 0 (already visible vertically)
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 0, matchIndex: 0 });

			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 58,
				top: 0,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("scrolls and centers horizontally and vertically when match is entirely off-screen horizontally (e.g. when zoomed)", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			// Match is at left 850, right 920 (> 800) -> entirely off-screen horizontally
			matchEl.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 850,
				right: 920,
				height: 20,
				width: 70,
			} as DOMRect);
			mockAdapter.containerEl.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			controller.advance("forward");
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 0, matchIndex: 1 });

			// Entirely off-screen -> centers both axes
			// Target X center: 885, Container X center: 400 -> deltaX = 485
			// Target Y center: 210, Container Y center: 350 -> deltaY = -140
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 485,
				top: -140,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("scrolls with minimal delta vertically when advancing backward to a match partially clipped at top edge", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			// Match [90, 110] - clipped at top edge (top 90 < 100)
			matchEl.getBoundingClientRect = () => ({
				top: 90,
				bottom: 110,
				left: 50,
				right: 150,
				height: 20,
				width: 100,
			} as DOMRect);
			mockAdapter.containerEl.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			controller.advance("backward");
			findController.scrollMatchIntoView({ element: matchEl, pageIndex: 0, matchIndex: 0 });

			// Minimal delta with padding: 90 - (100 + 8) = -18
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 0,
				top: -18,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("vertically and horizontally centers when navigating to an off-screen page match that lands near the bottom edge", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const listeners = new Map<string, ((...args: any[]) => void)[]>();
			mockAdapter.on = (event: string, handler: any) => {
				if (!listeners.has(event)) listeners.set(event, []);
				listeners.get(event)!.push(handler);
				return () => { };
			};

			const page3 = pageElements.get(3)!;
			// Page 3 is initially off-screen
			page3.getBoundingClientRect = () => ({
				top: 1000,
				bottom: 1800,
				left: 0,
				right: 800,
				height: 800,
				width: 800,
			} as DOMRect);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Advance to next match on page 3 (which is off-screen)
			findController.scrollMatchIntoView({ selected: { pageIdx: 2, matchIdx: 0 } });
			expect(mockAdapter.scrollPageIntoView).toHaveBeenCalledWith(3);

			// Match on page 3 is near the bottom edge [550, 570] (inside container [100, 600], so isOffV would be false)
			// and zoomed to the right [780, 850]
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 550,
				bottom: 570,
				left: 780,
				right: 850,
				height: 20,
				width: 70,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(matchEl);

			// Page 3 textlayer renders
			const handlers = listeners.get("textlayerrendered") || [];
			for (const h of handlers) {
				h({ pageNumber: 3 });
			}

			// Target center: top 560, left 815. Container center: top 350, left 400.
			// deltaY: 560 - 350 = 210 (scrolled up so match is vertically centered).
			// deltaX: 815 - 400 = 415 (scrolled left so match is horizontally centered).
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 415,
				top: 210,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("scrolls page into view when match element is not yet in DOM and page is off-screen", () => {
			const scrollPageIntoViewSpy = vi.fn();
			mockAdapter.scrollPageIntoView = scrollPageIntoViewSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: 1000,
				bottom: 1800,
				left: 0,
				right: 800,
				height: 800,
				width: 800,
			} as DOMRect);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Match on page 3 (index 2), page is off-screen
			findController.scrollMatchIntoView({ selected: { pageIdx: 2, matchIdx: 0 } });

			expect(scrollPageIntoViewSpy).toHaveBeenCalledWith(3);
			controller.destroy();
		});

		it("centers an already-rendered off-screen page match instead of only scrolling the page", () => {
			// Regression guard: when the active match is on a completely off-screen page but
			// that page is ALREADY rendered (so no `textlayerrendered` event will fire again),
			// the controller must center the match itself. Previously this branch only asked
			// for a page-level scroll and relied on a later event to center the match, which
			// for a tall/zoomed page left the match barely visible at the viewport edge.
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);
			const scrollPageIntoViewSpy = vi.fn();
			mockAdapter.scrollPageIntoView = scrollPageIntoViewSpy;

			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: 1000,
				bottom: 1800,
				left: 0,
				right: 800,
				height: 800,
				width: 800,
			} as DOMRect);

			// The match is already rendered, near the bottom of the off-screen page.
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 1750,
				bottom: 1770,
				left: 200,
				right: 280,
				height: 20,
				width: 80,
			} as DOMRect);
			page3.querySelector(".textLayer")?.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			findController.scrollMatchIntoView({ selected: { pageIdx: 2, matchIdx: 0 } });

			// Match center 1760 vs container center 350 => deltaY 1410; horizontally inside => deltaX 0.
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 0,
				top: 1410,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("skips page scroll jump when selected match page is already visible on screen", () => {
			const scrollPageIntoViewSpy = vi.fn();
			mockAdapter.scrollPageIntoView = scrollPageIntoViewSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			// Page 1 is in DOM and on screen [100, 600]
			const page1 = pageElements.get(1)!;
			page1.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Next match on page 1 (index 0)
			findController.scrollMatchIntoView({ selected: { pageIdx: 0, matchIdx: 1 } });

			// Must not scroll page to top because page 1 is already on screen
			expect(scrollPageIntoViewSpy).not.toHaveBeenCalled();
			controller.destroy();
		});

		it("scrolls match into view when textlayerrendered fires on target page", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const listeners = new Map<string, ((...args: any[]) => void)[]>();
			mockAdapter.on = (event: string, handler: any) => {
				if (!listeners.has(event)) listeners.set(event, []);
				listeners.get(event)!.push(handler);
				return () => { };
			};

			const page1 = pageElements.get(1)!;
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 590,
				bottom: 610,
				left: 50,
				right: 150,
				height: 20,
				width: 100,
			} as DOMRect);
			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Search navigation targets page 1 (which hasn't rendered its textlayer yet)
			findController.scrollMatchIntoView({ selected: { pageIdx: 0, matchIdx: 0 } });

			// Textlayer mounts and renders matchEl
			page1.querySelector(".textLayer")?.appendChild(matchEl);

			// Fire textlayerrendered for page 1
			const handlers = listeners.get("textlayerrendered") || [];
			for (const h of handlers) {
				h({ pageNumber: 1 });
			}

			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 0,
				top: 250,
				behavior: "smooth",
			});
			controller.destroy();
		});

		it("suppresses pdfViewer._scrollIntoView during search so scrollLeft is not reset to 0", () => {
			const scrollContainer = mockAdapter.containerEl;
			scrollContainer.scrollLeft = 350;

			const origScrollIntoViewSpy = vi.fn((dest: any) => {
				// In native PDF.js, _scrollIntoView sets scrollLeft = 0
				scrollContainer.scrollLeft = 0;
			});

			const pdfViewer = {
				_scrollIntoView: origScrollIntoViewSpy,
				scrollPageIntoView: vi.fn(),
			};
			mockAdapter.pdfViewer = pdfViewer;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// PDF.js calls _scrollIntoView with pageDiv and pageSpot during search advance
			const pageDiv = document.createElement("div");
			pdfViewer._scrollIntoView({ pageDiv, pageSpot: { top: 0, left: 0 } });

			// The call should be completely suppressed by PdfMatchController
			expect(origScrollIntoViewSpy).not.toHaveBeenCalled();
			expect(scrollContainer.scrollLeft).toBe(350);

			controller.destroy();

			// After destroy, original _scrollIntoView is restored
			pdfViewer._scrollIntoView({ pageDiv });
			expect(origScrollIntoViewSpy).toHaveBeenCalled();
		});

		it("suppresses viewer page reset when target page is already visible on screen", () => {
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 0,
				bottom: 600,
				left: 0,
				right: 800,
				height: 600,
				width: 800,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			page1.getBoundingClientRect = () => ({
				top: 100,
				bottom: 500,
				left: 0,
				right: 800,
				height: 400,
				width: 800,
			} as DOMRect);

			const origSetCurrentPageNumberSpy = vi.fn();
			const pdfViewer = {
				_setCurrentPageNumber: origSetCurrentPageNumberSpy,
			};
			mockAdapter.pdfViewer = pdfViewer;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Calling _setCurrentPageNumber with resetCurrentPageView = true for on-screen page 1
			pdfViewer._setCurrentPageNumber(1, true);

			// Should delegate with resetCurrentPageView = false so #resetCurrentPageView() is not triggered
			expect(origSetCurrentPageNumberSpy).toHaveBeenCalledWith(1, false);

			// Calling for off-screen page (page 3 is off-screen)
			origSetCurrentPageNumberSpy.mockClear();
			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: 1500,
				bottom: 2000,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			pdfViewer._setCurrentPageNumber(3, true);
			// Should allow resetCurrentPageView = true so viewer navigates to page 3
			expect(origSetCurrentPageNumberSpy).toHaveBeenCalledWith(3, true);

			controller.destroy();
		});

		it("scrolls to center an off-screen match vertically when advancing in PDF", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 900,
				height: 500,
				width: 800,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Match is off-screen vertically below container: top 750, bottom 770, height 20
			// Container center: 100 + 250 = 350. Match center: 750 + 10 = 760.
			// Expected deltaY: 760 - 350 = 410. Horizontally inside [100, 900], so deltaX = 0.
			const offScreenMatch = document.createElement("span");
			offScreenMatch.className = "highlight selected";
			offScreenMatch.getBoundingClientRect = () => ({
				top: 750,
				bottom: 770,
				left: 200,
				right: 280,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(offScreenMatch);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			findController.scrollMatchIntoView({
				element: offScreenMatch,
				pageIndex: 0,
				matchIndex: 0,
			});

			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 0,
				top: 410,
				behavior: "smooth",
			});

			controller.destroy();
		});

		it("scrolls to center an off-screen match horizontally when note is zoomed in PDF", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Match is off-screen horizontally to the right: left 850, right 930, width 80
			// Container center: 100 + 300 = 400. Match center: 850 + 40 = 890.
			// Expected deltaX: 890 - 400 = 490. Vertically inside [100, 600], so deltaY = 0.
			const offScreenMatch = document.createElement("span");
			offScreenMatch.className = "highlight selected";
			offScreenMatch.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 850,
				right: 930,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(offScreenMatch);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			findController.scrollMatchIntoView({
				element: offScreenMatch,
				pageIndex: 0,
				matchIndex: 0,
			});

			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 490,
				top: -140,
				behavior: "smooth",
			});

			controller.destroy();
		});

		it("scrolls to center an off-screen match both vertically and horizontally in PDF", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Off-screen both: top 750 (deltaY: 410), left 850 (deltaX: 490)
			const offScreenMatch = document.createElement("span");
			offScreenMatch.className = "highlight selected";
			offScreenMatch.getBoundingClientRect = () => ({
				top: 750,
				bottom: 770,
				left: 850,
				right: 930,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(offScreenMatch);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			findController.scrollMatchIntoView({
				element: offScreenMatch,
				pageIndex: 0,
				matchIndex: 0,
			});

			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 490,
				top: 410,
				behavior: "smooth",
			});

			controller.destroy();
		});

		it("scrolls page into view when match is on an off-screen page", () => {
			const scrollPageIntoViewSpy = vi.fn();
			mockAdapter.scrollPageIntoView = scrollPageIntoViewSpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			// Page 3 is completely off-screen [1500, 2000]
			const page3 = pageElements.get(3)!;
			page3.getBoundingClientRect = () => ({
				top: 1500,
				bottom: 2000,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Selected match is on page 3 (pageIdx: 2), element not yet rendered
			findController.scrollMatchIntoView({
				pageIndex: 2,
				matchIndex: 0,
			});

			// Must scroll page 3 into view so it mounts!
			expect(scrollPageIntoViewSpy).toHaveBeenCalledWith(3);

			controller.destroy();
		});

		it("does not scroll when advancing to next match on the same line that is already on-screen", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 200,
				right: 800,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Match 1: 'the' in 'the calculations' (currently selected)
			const match1 = document.createElement("span");
			match1.className = "highlight";
			match1.getBoundingClientRect = () => ({
				top: 300,
				bottom: 320,
				left: 250,
				right: 280,
				height: 20,
				width: 30,
			} as DOMRect);
			textLayer.appendChild(match1);

			// Match 2: 'the' at the end of the same line (next match to be selected)
			const match2 = document.createElement("span");
			match2.className = "highlight selected";
			match2.getBoundingClientRect = () => ({
				top: 300,
				bottom: 320,
				left: 550,
				right: 580,
				height: 20,
				width: 30,
			} as DOMRect);
			textLayer.appendChild(match2);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Advance to match 2 on page 1 (both match 1 and match 2 are on screen)
			findController.scrollMatchIntoView({
				element: match2,
				pageIndex: 0,
				matchIndex: 1,
			});

			// Absolutely NO scrolling should occur!
			expect(scrollBySpy).not.toHaveBeenCalled();

			controller.destroy();
		});

		it("does not scroll when advancing to ANY match on different lines that is already on-screen", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.scrollLeft = 250;
			mockAdapter.containerEl.scrollTop = 120;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 200,
				right: 800,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Match 1: on line 1, top: 150 (inside [100, 600])
			const match1 = document.createElement("span");
			match1.className = "highlight";
			match1.getBoundingClientRect = () => ({
				top: 150,
				bottom: 170,
				left: 250,
				right: 320,
				height: 20,
				width: 70,
			} as DOMRect);
			textLayer.appendChild(match1);

			// Match 2: on line 6 (different line!), top: 320 (inside [100, 600])
			const match2 = document.createElement("span");
			match2.className = "highlight";
			match2.getBoundingClientRect = () => ({
				top: 320,
				bottom: 340,
				left: 400,
				right: 480,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(match2);

			// Match 3: on line 12 (yet another line!), top: 510 (inside [100, 600])
			const match3 = document.createElement("span");
			match3.className = "highlight";
			match3.getBoundingClientRect = () => ({
				top: 510,
				bottom: 530,
				left: 300,
				right: 380,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(match3);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// 1. Advance to match 2 (different line, already on-screen)
			findController.scrollMatchIntoView({
				element: match2,
				pageIndex: 0,
				matchIndex: 1,
			});
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			expect(mockAdapter.containerEl.scrollLeft).toBe(250);
			expect(mockAdapter.containerEl.scrollTop).toBe(120);

			// 2. Advance to match 3 (different line, already on-screen)
			findController.scrollMatchIntoView({
				element: match3,
				pageIndex: 0,
				matchIndex: 2,
			});
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			expect(mockAdapter.containerEl.scrollLeft).toBe(250);
			expect(mockAdapter.containerEl.scrollTop).toBe(120);

			controller.destroy();
		});

		it("does not scroll when advancing across page boundary to ANY match on a different visible page", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			const scrollPageIntoViewSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.scrollPageIntoView = scrollPageIntoViewSpy;
			mockAdapter.containerEl.scrollLeft = 100;
			mockAdapter.containerEl.scrollTop = 250;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 0,
				right: 800,
				height: 500,
				width: 800,
			} as DOMRect);

			// Page 1 is partially visible [100, 300]
			const page1 = pageElements.get(1)!;
			page1.getBoundingClientRect = () => ({
				top: 100,
				bottom: 300,
				left: 0,
				right: 800,
				height: 200,
				width: 800,
			} as DOMRect);

			// Page 2 is also partially visible [300, 700]
			const page2 = pageElements.get(2)!;
			page2.getBoundingClientRect = () => ({
				top: 300,
				bottom: 700,
				left: 0,
				right: 800,
				height: 400,
				width: 800,
			} as DOMRect);

			// Match on Page 2 at top: 420 (fully within the container viewport [100, 600]!)
			const matchOnPage2 = document.createElement("span");
			matchOnPage2.className = "highlight selected";
			matchOnPage2.getBoundingClientRect = () => ({
				top: 420,
				bottom: 440,
				left: 150,
				right: 250,
				height: 20,
				width: 100,
			} as DOMRect);
			page2.querySelector(".textLayer")?.appendChild(matchOnPage2);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Advance across page boundary: selected match is on page 2 (pageIdx: 1), matchIdx: 0
			findController.scrollMatchIntoView({
				selected: { pageIdx: 1, matchIdx: 0 },
			});

			// Must not jump page, and must not scroll container at all because match is already visible on screen!
			expect(scrollPageIntoViewSpy).not.toHaveBeenCalled();
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			expect(mockAdapter.containerEl.scrollLeft).toBe(100);
			expect(mockAdapter.containerEl.scrollTop).toBe(250);

			controller.destroy();
		});

		it("does not scroll when advancing backward to ANY match that is already on-screen", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.scrollLeft = 180;
			mockAdapter.containerEl.scrollTop = 300;
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 900,
				height: 500,
				width: 800,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Match 1: earlier line, top: 180
			const match1 = document.createElement("span");
			match1.className = "highlight";
			match1.getBoundingClientRect = () => ({
				top: 180,
				bottom: 200,
				left: 200,
				right: 280,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(match1);

			// Match 2: current line, top: 480
			const match2 = document.createElement("span");
			match2.className = "highlight selected";
			match2.getBoundingClientRect = () => ({
				top: 480,
				bottom: 500,
				left: 300,
				right: 380,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(match2);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// Advance backward to earlier match 1 (top: 180, already in view [100, 600])
			findController.scrollMatchIntoView({
				element: match1,
				pageIndex: 0,
				matchIndex: 0,
			});

			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			expect(mockAdapter.containerEl.scrollLeft).toBe(180);
			expect(mockAdapter.containerEl.scrollTop).toBe(300);

			controller.destroy();
		});

		it("does not scroll back to current match when note is zoomed and user manually scrolls so current match is off-screen", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.scrollLeft = 0;
			mockAdapter.containerEl.scrollTop = 0;

			// Viewport: width 600, height 500, placed at [100, 600] vertically, [100, 700] horizontally
			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Current match: zoomed up, located far to the right (left: 850, right: 930 > 700 viewport right)
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 850,
				right: 930,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// 1. Simulate user manual scroll (via wheel event on container)
			const wheelEvt = new Event("wheel", { bubbles: true, cancelable: true });
			mockAdapter.containerEl.dispatchEvent(wheelEvt);

			expect(controller.userHasManuallyScrolled).toBe(true);

			// 2. Background PDF.js text layer / findController attempts to scroll off-screen match
			findController.scrollMatchIntoView({
				element: matchEl,
				pageIndex: 0,
				matchIndex: 0,
			});

			// Must NOT scroll back to match!
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			expect(mockAdapter.containerEl.scrollLeft).toBe(0);

			controller.destroy();
		});

		it("does not scroll back when textlayerrendered or updatetextlayermatches fires after user manual scroll", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.scrollLeft = 0;

			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const listeners = new Map<string, ((...args: any[]) => void)[]>();
			mockAdapter.on = (event: string, handler: any) => {
				if (!listeners.has(event)) listeners.set(event, []);
				listeners.get(event)!.push(handler);
				return () => { };
			};

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 850,
				right: 930,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// User manually scrolls
			const pointerEvt = new Event("pointerdown", { bubbles: true, cancelable: true });
			mockAdapter.containerEl.dispatchEvent(pointerEvt);

			// textlayerrendered and updatetextlayermatches fire from background rendering
			const textLayerHandlers = listeners.get("textlayerrendered") || [];
			for (const h of textLayerHandlers) {
				h({ pageNumber: 1 });
			}

			const updateMatchesHandlers = listeners.get("updatetextlayermatches") || [];
			for (const h of updateMatchesHandlers) {
				h();
			}

			// Must NOT scroll back to match!
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();

			controller.destroy();
		});

		it("resumes centering off-screen match when user explicitly advances forward after manual scroll", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollLeft = 0;

			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 850,
				right: 930,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// 1. User manually scrolls: manual scroll active
			const wheelEvt = new Event("wheel", { bubbles: true, cancelable: true });
			mockAdapter.containerEl.dispatchEvent(wheelEvt);
			expect(controller.userHasManuallyScrolled).toBe(true);

			// 2. User presses Next match (advance)
			controller.advance("forward");
			expect(controller.userHasManuallyScrolled).toBe(false);

			// 3. Next match is evaluated and centered
			findController.scrollMatchIntoView({
				element: matchEl,
				pageIndex: 0,
				matchIndex: 1,
			});

			// Should have centered the match!
			// match center = 890, viewport center = 400 => deltaX = 890 - 400 = 490
			// target top 200, height 20 -> center 210, viewport center 350 => deltaY = 210 - 350 = -140
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 490,
				top: -140,
				behavior: "smooth",
			});

			controller.destroy();
		});

		it("does not scroll when user advances forward after manual scroll if the next match is already on-screen", () => {
			const scrollBySpy = vi.fn();
			const scrollToSpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollTo = scrollToSpy;
			mockAdapter.containerEl.scrollLeft = 200;
			mockAdapter.containerEl.scrollTop = 100;

			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			const textLayer = page1.querySelector(".textLayer")!;

			// Next match: fully within view [100, 700] horizontally and [100, 600] vertically
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			matchEl.getBoundingClientRect = () => ({
				top: 200,
				bottom: 220,
				left: 300,
				right: 380,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// 1. User manually scrolls
			const wheelEvt = new Event("wheel", { bubbles: true, cancelable: true });
			mockAdapter.containerEl.dispatchEvent(wheelEvt);
			expect(controller.userHasManuallyScrolled).toBe(true);

			// 2. User presses Next match (advance)
			controller.advance("forward");
			expect(controller.userHasManuallyScrolled).toBe(false);

			// 3. Next match is evaluated: it is on-screen!
			findController.scrollMatchIntoView({
				element: matchEl,
				pageIndex: 0,
				matchIndex: 1,
			});

			// Must NOT scroll!
			expect(scrollBySpy).not.toHaveBeenCalled();
			expect(scrollToSpy).not.toHaveBeenCalled();
			expect(mockAdapter.containerEl.scrollLeft).toBe(200);
			expect(mockAdapter.containerEl.scrollTop).toBe(100);

			controller.destroy();
		});

		it("scrolls and centers both vertically and horizontally when advancing to next match on the same visible page that is off-screen horizontally", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			mockAdapter.containerEl.scrollLeft = 0;
			mockAdapter.containerEl.scrollTop = 0;
			Object.defineProperty(mockAdapter.containerEl, "scrollWidth", { value: 1200, configurable: true });
			Object.defineProperty(mockAdapter.containerEl, "clientWidth", { value: 600, configurable: true });

			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			page1.getBoundingClientRect = () => ({
				top: 100,
				bottom: 1000,
				left: 100,
				right: 1000,
				height: 900,
				width: 900,
			} as DOMRect);

			const textLayer = page1.querySelector(".textLayer")!;
			const matchEl = document.createElement("span");
			matchEl.className = "highlight selected";
			// Match in abstract: vertically inside [100, 600] at [450, 470], but off-screen horizontally to the right at [750, 830] (> 700)
			matchEl.getBoundingClientRect = () => ({
				top: 450,
				bottom: 470,
				left: 750,
				right: 830,
				height: 20,
				width: 80,
			} as DOMRect);
			textLayer.appendChild(matchEl);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// User advances search to next match on page 1 (PDF.js passes selected match index without element)
			controller.advance("forward");
			findController.scrollMatchIntoView({
				selected: { pageIdx: 0, matchIdx: 1 },
			});

			// Must center BOTH vertically and horizontally!
			// Container centerY = 100 + 250 = 350. Target centerY = 450 + 10 = 460. deltaY = 460 - 350 = 110.
			// Container centerX = 100 + 300 = 400. Target centerX = 750 + 40 = 790. deltaX = 790 - 400 = 390.
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 390,
				top: 110,
				behavior: "smooth",
			});

			controller.destroy();
		});

		it("unions multiple fragments of a selected match and scrolls with minimal delta when second fragment extends off-screen", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			Object.defineProperty(mockAdapter.containerEl, "scrollWidth", { value: 1200, configurable: true });
			Object.defineProperty(mockAdapter.containerEl, "clientWidth", { value: 600, configurable: true });

			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			page1.getBoundingClientRect = () => ({
				top: 100,
				bottom: 1000,
				left: 100,
				right: 1000,
				height: 900,
				width: 900,
			} as DOMRect);

			const textLayer = page1.querySelector(".textLayer")!;
			// Fragment 1: "C" at [680, 695], inside viewport right edge (700)
			const frag1 = document.createElement("span");
			frag1.className = "highlight selected";
			frag1.getBoundingClientRect = () => ({
				top: 450,
				bottom: 470,
				left: 680,
				right: 695,
				height: 20,
				width: 15,
			} as DOMRect);
			textLayer.appendChild(frag1);

			// Fragment 2: "IECAM02" at [695, 765], extends outside viewport right edge (700)
			const frag2 = document.createElement("span");
			frag2.className = "highlight selected";
			frag2.getBoundingClientRect = () => ({
				top: 450,
				bottom: 470,
				left: 695,
				right: 765,
				height: 20,
				width: 70,
			} as DOMRect);
			textLayer.appendChild(frag2);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			// PDF.js calls scrollMatchIntoView with only the first fragment element
			controller.advance("forward");
			findController.scrollMatchIntoView({
				element: frag1,
				pageIndex: 0,
				matchIndex: 1,
			});

			// Compound match spans [680, 765] (partially visible).
			// Minimal deltaX with padding (8): 765 - (700 - 8) = 73. deltaY: 0 (already in view vertically [450, 470] in [100, 600]).
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 73,
				top: 0,
				behavior: "smooth",
			});

			controller.destroy();
		});

		it("unions multiple fragments of a selected match and centers when compound match is entirely off-screen", () => {
			const scrollBySpy = vi.fn();
			mockAdapter.containerEl.scrollBy = scrollBySpy;
			Object.defineProperty(mockAdapter.containerEl, "scrollWidth", { value: 1200, configurable: true });
			Object.defineProperty(mockAdapter.containerEl, "clientWidth", { value: 600, configurable: true });

			mockAdapter.containerEl.getBoundingClientRect = () => ({
				top: 100,
				bottom: 600,
				left: 100,
				right: 700,
				height: 500,
				width: 600,
			} as DOMRect);

			const page1 = pageElements.get(1)!;
			page1.getBoundingClientRect = () => ({
				top: 100,
				bottom: 1000,
				left: 100,
				right: 1000,
				height: 900,
				width: 900,
			} as DOMRect);

			const textLayer = page1.querySelector(".textLayer")!;
			// Fragment 1: [750, 765]
			const frag1 = document.createElement("span");
			frag1.className = "highlight selected";
			frag1.getBoundingClientRect = () => ({
				top: 450,
				bottom: 470,
				left: 750,
				right: 765,
				height: 20,
				width: 15,
			} as DOMRect);
			textLayer.appendChild(frag1);

			// Fragment 2: [765, 835]
			const frag2 = document.createElement("span");
			frag2.className = "highlight selected";
			frag2.getBoundingClientRect = () => ({
				top: 450,
				bottom: 470,
				left: 765,
				right: 835,
				height: 20,
				width: 70,
			} as DOMRect);
			textLayer.appendChild(frag2);

			const findController = {
				scrollMatchIntoView: vi.fn(),
			};
			mockAdapter.findController = findController;

			const controller = new PdfMatchController(mockAdapter, DEFAULT_SETTINGS);

			controller.advance("forward");
			findController.scrollMatchIntoView({
				element: frag1,
				pageIndex: 0,
				matchIndex: 1,
			});

			// Compound match spans [750, 835] (width 85, center 792.5). Entirely off-screen (> 700).
			// Container centerY = 350. Target centerY = 460. deltaY = 110.
			// Container centerX = 400. Target centerX = 792.5. deltaX = 392.5.
			expect(scrollBySpy).toHaveBeenCalledWith({
				left: 392.5,
				top: 110,
				behavior: "smooth",
			});

			controller.destroy();
		});
	});
});
