import { MatchRect, PdfTextItem, PdfViewportAnchor, PdfScrollPosition } from "./types";
import {
	isPageCompletelyOffScreen,
	computeVerticalCenterDelta,
	scrollTargetIntoViewIfNeeded,
	getCompoundMatchBoundingRect,
} from "../utils/scroll";
import { logDebug, describeElement } from "../utils/logger";

export interface PdfPageProxyAdapter {
	pageNumber: number;
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
	getViewport(params: { scale: number; rotation?: number }): any;
}

export interface PdfViewAdapter {
	numPages: number;
	containerEl: HTMLElement;
	getPage(pageNumber: number): Promise<PdfPageProxyAdapter | null>;
	getPageElement(pageNumber: number): HTMLElement | null;
	getTextLayerElement(pageNumber: number): HTMLElement | null;
	getPageViewport(pageNumber: number): any;
	getVisiblePageNumbers(): number[];
	getViewportAnchor?(): PdfViewportAnchor;
	getScrollPosition?(): PdfScrollPosition;
	restoreScrollPosition?(pos: PdfScrollPosition): void;
	on(event: string, handler: (...args: any[]) => void): () => void;
	scrollToRect(pageNumber: number, rect?: MatchRect): void;
	scrollPageIntoView(pageNumber: number): void;
	findController?: any;
	pdfViewer?: any;
	getActiveFindMatchInfo?(): { pageIndex: number; matchIndex: number } | null;
	executeNativeFind?(command: {
		query: string;
		type?: string;
		findPrevious?: boolean;
		highlightAll?: boolean;
		caseSensitive?: boolean;
		phraseSearch?: boolean;
		entireWord?: boolean;
	}): boolean;
}

/**
 * Checks if an Obsidian view is a PDF view.
 */
export function isPdfView(view: any): boolean {
	if (!view) return false;
	if (typeof view.getViewType === "function") {
		return view.getViewType() === "pdf";
	}
	if (view.file && typeof view.file.extension === "string") {
		return view.file.extension.toLowerCase() === "pdf";
	}
	return Boolean(view.viewer || view.pdfViewer || view.child?.pdfViewer);
}

/**
 * Resolves the underlying PDF.js PDFViewer and PDFDocumentProxy from an Obsidian view.
 */
function resolveViewerComponents(view: any): {
	pdfViewer: any;
	pdfDocument: any;
	eventBus: any;
	containerEl: HTMLElement;
} | null {
	if (!view) return null;

	const containerEl: HTMLElement =
		view.contentEl || view.containerEl || view.viewer?.child?.containerEl || document.body;

	// Check if PDF++ plugin API is present on window
	const pdfPlus = (window as any).pdfPlus;
	if (pdfPlus?.lib) {
		try {
			const pv =
				pdfPlus.lib.getPDFViewer?.(view) ||
				pdfPlus.lib.getPDFViewerChild?.(view)?.pdfViewer;
			const doc =
				pdfPlus.lib.getPDFDocument?.(view) ||
				pv?.pdfDocument ||
				pdfPlus.lib.getPDFViewerChild?.(view)?.pdfDocument;
			if (doc && pv) {
				return {
					pdfViewer: pv,
					pdfDocument: doc,
					eventBus: pv.eventBus || pv.pdfViewer?.eventBus,
					containerEl,
				};
			}
		} catch {
			// Continue to native traversal fallback
		}
	}

	// Native Obsidian PDF view traversal
	const child = view.viewer?.child || view.child;
	const candidateViewers = [
		child?.pdfViewer?.pdfViewer,
		child?.pdfViewer,
		view.viewer?.pdfViewer,
		view.pdfViewer?.pdfViewer,
		view.pdfViewer,
		view.viewer,
	].filter(Boolean);

	for (const pv of candidateViewers) {
		const doc = pv.pdfDocument || child?.pdfDocument || view.viewer?.pdfDocument;
		if (doc && typeof doc.numPages === "number") {
			return {
				pdfViewer: pv,
				pdfDocument: doc,
				eventBus: pv.eventBus || child?.eventBus,
				containerEl,
			};
		}
	}

	// Fallback check if child has direct getPage
	if (child && typeof child.getPage === "function") {
		return {
			pdfViewer: child,
			pdfDocument: child.pdfDocument || child,
			eventBus: child.eventBus,
			containerEl,
		};
	}

	return null;
}

/**
 * Helper to check if an element is a valid scrollable container.
 */
function isScrollableElement(el: HTMLElement | null | undefined): boolean {
	if (!el || typeof el.getBoundingClientRect !== "function") return false;
	try {
		const style = window.getComputedStyle(el);
		const overflow = `${style.overflow} ${style.overflowY} ${style.overflowX}`;
		if (/(auto|scroll|overlay)/.test(overflow)) {
			return true;
		}
	} catch {
		// Ignore if getComputedStyle fails in mock environments
	}
	return Boolean(el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
}

/**
 * Finds the actual scrollable element containing the PDF pages.
 */
export function getScrollContainer(containerEl: HTMLElement, pageEl?: HTMLElement | null): HTMLElement {
	// 1. Look for known PDF.js / Obsidian scrollable container classes first
	const knownCandidates = [
		containerEl.querySelector?.("#viewerContainer"),
		containerEl.querySelector?.(".viewerContainer"),
		containerEl.querySelector?.(".pdf-container"),
		containerEl.querySelector?.(".pdf-viewer-container"),
		containerEl.classList?.contains("pdf-container") ? containerEl : null,
	].filter(Boolean) as HTMLElement[];

	for (const el of knownCandidates) {
		if (isScrollableElement(el)) {
			return el;
		}
	}

	// 2. Walk up from pageEl to containerEl looking for the scrollable ancestor
	let cur = (pageEl?.parentElement || containerEl.querySelector?.(".page")?.parentElement) as HTMLElement | null;
	while (cur && cur !== document.body && cur !== document.documentElement) {
		if (isScrollableElement(cur)) {
			return cur;
		}
		if (cur === containerEl) break;
		cur = cur.parentElement;
	}

	// 3. Prefer containerEl itself when it is scrollable, before falling back to a
	// known candidate that failed the scrollability check above (e.g. before the PDF
	// viewer's overflow container has any overflow yet).
	if (isScrollableElement(containerEl)) {
		return containerEl;
	}

	if (knownCandidates.length > 0) {
		return knownCandidates[0];
	}

	return containerEl;
}

/**
 * Creates a normalized PdfViewAdapter for interacting with an active PDF view.
 */
export function createPdfViewAdapter(view: any): PdfViewAdapter | null {
	if (!isPdfView(view)) {
		return null;
	}

	const components = resolveViewerComponents(view);
	if (!components || !components.pdfDocument) {
		return null;
	}

	const { pdfViewer, pdfDocument, eventBus, containerEl } = components;
	const numPages = pdfDocument.numPages || pdfViewer.pagesCount || 0;

	// Ensure PDF container is focusable so clicking it shifts focus away from inputs
	if (containerEl && typeof containerEl.setAttribute === "function") {
		containerEl.setAttribute("tabindex", "-1");
	}
	const child = (view as any)?.viewer?.child || (view as any)?.child;
	const findController =
		pdfViewer?.findController ||
		child?.findController ||
		child?.pdfViewer?.findController ||
		(view as any)?.viewer?.findController ||
		(view as any)?.findController;
	const findEventBus = findController?._eventBus || findController?.eventBus || eventBus;

	return {
		numPages,
		containerEl,
		findController,
		pdfViewer,

		async getPage(pageNumber: number): Promise<PdfPageProxyAdapter | null> {
			if (pageNumber < 1 || pageNumber > numPages) return null;
			try {
				if (typeof pdfDocument.getPage === "function") {
					const page = await pdfDocument.getPage(pageNumber);
					return {
						pageNumber,
						getTextContent: () => page.getTextContent(),
						getViewport: (params) => page.getViewport(params),
					};
				}
			} catch (e) {
				console.error(`Incremental Search: failed to get PDF page ${pageNumber}`, e);
			}
			return null;
		},

		getPageElement(pageNumber: number): HTMLElement | null {
			// Query by data-page-number attribute
			const el = containerEl.querySelector(
				`.page[data-page-number="${pageNumber}"], [data-page-number="${pageNumber}"]`
			) as HTMLElement | null;
			if (el) return el;

			// Fallback to pdfViewer._pages or getPageView
			try {
				const pageView =
					pdfViewer.getPageView?.(pageNumber - 1) ||
					pdfViewer._pages?.[pageNumber - 1] ||
					pdfViewer.pages?.[pageNumber - 1];
				if (pageView?.div) return pageView.div;
			} catch {
				// Ignore
			}
			return null;
		},

		getTextLayerElement(pageNumber: number): HTMLElement | null {
			const pageEl = this.getPageElement(pageNumber);
			if (pageEl) {
				const textLayer = pageEl.querySelector(
					".textLayer, .text-layer"
				) as HTMLElement | null;
				if (textLayer) return textLayer;
			}
			try {
				const pageView =
					pdfViewer.getPageView?.(pageNumber - 1) || pdfViewer._pages?.[pageNumber - 1];
				if (pageView?.textLayer?.div) return pageView.textLayer.div;
				if (pageView?.textLayer?.textLayerDiv) return pageView.textLayer.textLayerDiv;
			} catch {
				// Ignore
			}
			return null;
		},

		getPageViewport(pageNumber: number): any {
			try {
				const pageView =
					pdfViewer.getPageView?.(pageNumber - 1) ||
					pdfViewer._pages?.[pageNumber - 1] ||
					pdfViewer.pages?.[pageNumber - 1];
				if (pageView?.viewport) return pageView.viewport;
				const scale = pdfViewer.currentScale || pdfViewer._currentScale || 1.0;
				if (pageView?.pdfPage?.getViewport) {
					return pageView.pdfPage.getViewport({ scale });
				}
			} catch {
				return null;
			}
			return null;
		},

		getActiveFindMatchInfo(): { pageIndex: number; matchIndex: number } | null {
			const child = (view as any)?.viewer?.child || (view as any)?.child;
			const findController =
				pdfViewer?.findController ||
				child?.findController ||
				child?.pdfViewer?.findController ||
				(view as any)?.viewer?.findController ||
				(view as any)?.findController;
			if (findController) {
				const sel = findController.selected || findController._selected;
				if (
					sel &&
					typeof sel.pageIdx === "number" &&
					typeof sel.matchIdx === "number" &&
					sel.pageIdx >= 0 &&
					sel.matchIdx >= 0
				) {
					return { pageIndex: sel.pageIdx, matchIndex: sel.matchIdx };
				}
			}
			return null;
		},

		getVisiblePageNumbers(): number[] {
			// Try pdfViewer visible pages API
			try {
				const visible = pdfViewer.getVisiblePages?.() || pdfViewer._getVisiblePages?.();
				if (visible && Array.isArray(visible.views) && visible.views.length > 0) {
					return visible.views.map((v: any) => v.id || v.pageNumber || v.index + 1);
				}
			} catch {
				// Fallback to DOM intersection
			}

			const visibleNumbers: number[] = [];
			const pageElements = Array.from(
				containerEl.querySelectorAll(".page[data-page-number]")
			) as HTMLElement[];

			if (pageElements.length > 0) {
				const containerRect = containerEl.getBoundingClientRect();
				for (const pageEl of pageElements) {
					const pageNumAttr = pageEl.getAttribute("data-page-number");
					if (!pageNumAttr) continue;
					const pageNum = parseInt(pageNumAttr, 10);
					const rect = pageEl.getBoundingClientRect();
					if (rect.bottom >= containerRect.top && rect.top <= containerRect.bottom) {
						visibleNumbers.push(pageNum);
					}
				}
			}

			if (visibleNumbers.length === 0 && numPages > 0) {
				// Default to first page if visibility calculation is inconclusive
				visibleNumbers.push(1);
			}

			return visibleNumbers;
		},

		getViewportAnchor(): PdfViewportAnchor {
			const visible = this.getVisiblePageNumbers();
			const topPageNumber = visible.length > 0 ? Math.min(...visible) : 1;
			const bottomPageNumber = visible.length > 0 ? Math.max(...visible) : topPageNumber;

			const containerRect = containerEl.getBoundingClientRect();
			const topPageEl = this.getPageElement(topPageNumber);
			const bottomPageEl = this.getPageElement(bottomPageNumber);

			let topPageY = 0;
			let topPageX = 0;
			if (topPageEl) {
				const topRect = topPageEl.getBoundingClientRect();
				topPageY = Math.max(0, containerRect.top - topRect.top);
				topPageX = Math.max(0, containerRect.left - topRect.left);
			}

			let bottomPageY = Infinity;
			let bottomPageX = Infinity;
			if (bottomPageEl) {
				const bottomRect = bottomPageEl.getBoundingClientRect();
				bottomPageY = Math.max(
					0,
					Math.min(bottomRect.height, containerRect.bottom - bottomRect.top)
				);
				bottomPageX = Math.max(
					0,
					Math.min(bottomRect.width, containerRect.right - bottomRect.left)
				);
			}

			return {
				topPageNumber,
				topPageY,
				topPageX,
				bottomPageNumber,
				bottomPageY,
				bottomPageX,
			};
		},

		getScrollPosition(): PdfScrollPosition {
			const scrollContainer = getScrollContainer(containerEl);
			const visible = this.getVisiblePageNumbers();
			return {
				scrollTop: scrollContainer.scrollTop || 0,
				scrollLeft: scrollContainer.scrollLeft || 0,
				pageNumber: visible.length > 0 ? visible[0] : 1,
			};
		},

		restoreScrollPosition(pos: PdfScrollPosition) {
			const scrollContainer = getScrollContainer(containerEl);
			if (typeof scrollContainer.scrollTo === "function") {
				scrollContainer.scrollTo({
					top: pos.scrollTop,
					left: pos.scrollLeft,
					behavior: "smooth",
				});
			} else {
				scrollContainer.scrollTop = pos.scrollTop;
				scrollContainer.scrollLeft = pos.scrollLeft;
			}
			if (pos.pageNumber) {
				const pageEl = this.getPageElement(pos.pageNumber);
				if (
					pageEl &&
					typeof pageEl.scrollIntoView === "function" &&
					Math.abs(scrollContainer.scrollTop - pos.scrollTop) > 50
				) {
					pageEl.scrollIntoView({ block: "nearest", inline: "nearest" });
				}
			}
		},

		on(event: string, handler: (...args: any[]) => void): () => void {
			const unsubs: (() => void)[] = [];
			if (findEventBus && typeof findEventBus.on === "function") {
				try {
					findEventBus.on(event, handler);
					unsubs.push(() => {
						try {
							if (typeof findEventBus.off === "function") {
								findEventBus.off(event, handler);
							}
						} catch {
							// Ignore
						}
					});
				} catch {
					// Fallback to DOM events
				}
			}

			const domListener = (evt: any) => handler(evt.detail || evt);
			containerEl.addEventListener(event, domListener);
			unsubs.push(() => containerEl.removeEventListener(event, domListener));

			return () => {
				for (const u of unsubs) u();
			};
		},

		scrollPageIntoView(pageNumber: number) {
			const pageEl = this.getPageElement(pageNumber);
			const scrollContainer = getScrollContainer(containerEl, pageEl);
			const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;

			logDebug(
				"pdf",
				`adapter.scrollPageIntoView: page=${pageNumber}, hasPageEl=${Boolean(pageEl)}, scrollContainer=${describeElement(scrollContainer)}`
			);

			if (pageEl && scrollContainer && containerRect) {
				const pageBounds = pageEl.getBoundingClientRect();
				const isOffScreen = isPageCompletelyOffScreen(pageBounds, containerRect);
				logDebug(
					"pdf",
					`adapter.scrollPageIntoView: pageBounds=[${pageBounds.top.toFixed(1)}, ${pageBounds.bottom.toFixed(1)}], containerRect=[${containerRect.top.toFixed(1)}, ${containerRect.bottom.toFixed(1)}], isOffScreen=${isOffScreen}`
				);
				if (!isOffScreen) {
					logDebug("pdf", `adapter.scrollPageIntoView: page ${pageNumber} is already on-screen, skipping scroll`);
					return;
				}
				logDebug("pdf", `adapter.scrollPageIntoView: page ${pageNumber} is off-screen, centering page`);
				scrollTargetIntoViewIfNeeded(pageBounds, scrollContainer, { behavior: "smooth" });
				return;
			}

			try {
				if (typeof pdfViewer.scrollPageIntoView === "function") {
					logDebug("pdf", `adapter.scrollPageIntoView: delegating to pdfViewer.scrollPageIntoView`);
					pdfViewer.scrollPageIntoView({ pageNumber });
					return;
				} else if (typeof pdfViewer.currentPageNumber === "number") {
					logDebug("pdf", `adapter.scrollPageIntoView: setting pdfViewer.currentPageNumber=${pageNumber}`);
					pdfViewer.currentPageNumber = pageNumber;
				}
			} catch (e) {
				logDebug("pdf", "adapter.scrollPageIntoView: error in pdfViewer scroll", e);
			}

			const child = (view as any)?.viewer?.child || (view as any)?.child;
			try {
				if (typeof child?.scrollToPage === "function") {
					logDebug("pdf", `adapter.scrollPageIntoView: delegating to child.scrollToPage`);
					child.scrollToPage(pageNumber);
					return;
				} else if (typeof child?.goToPage === "function") {
					logDebug("pdf", `adapter.scrollPageIntoView: delegating to child.goToPage`);
					child.goToPage(pageNumber);
				}
			} catch (e) {
				logDebug("pdf", "adapter.scrollPageIntoView: error in child scroll", e);
			}
		},

		scrollToRect(pageNumber: number, rect?: MatchRect) {
			const pageEl = this.getPageElement(pageNumber);
			const scrollContainer = getScrollContainer(containerEl, pageEl);
			const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;

			logDebug(
				"pdf",
				`adapter.scrollToRect: page=${pageNumber}, hasPageEl=${Boolean(pageEl)}, hasRect=${Boolean(rect)}, scrollContainer=${describeElement(scrollContainer)}`
			);

			if (!pageEl) {
				this.scrollPageIntoView(pageNumber);
				return;
			}

			// 1. If rect is provided, calculate target rect directly from page bounds and match rect
			if (rect && scrollContainer && containerRect) {
				const pageBounds = pageEl.getBoundingClientRect();
				const isPageOff = isPageCompletelyOffScreen(pageBounds, containerRect);
				const scaleX = pageEl.offsetWidth > 0 ? pageBounds.width / pageEl.offsetWidth : 1;
				const scaleY = pageEl.offsetHeight > 0 ? pageBounds.height / pageEl.offsetHeight : 1;

				const targetTop = pageBounds.top + rect.top * scaleY;
				const targetBottom = targetTop + rect.height * scaleY;
				const targetLeft = pageBounds.left + rect.left * scaleX;
				const targetRight = targetLeft + rect.width * scaleX;
				const targetWidth = rect.width * scaleX;
				const targetHeight = rect.height * scaleY;

				const targetRect = {
					top: targetTop,
					bottom: targetBottom,
					left: targetLeft,
					right: targetRight,
					width: targetWidth,
					height: targetHeight,
				};

				logDebug(
					"pdf",
					`adapter.scrollToRect: rectTarget=[${targetTop.toFixed(1)}, ${targetBottom.toFixed(1)}, ${targetLeft.toFixed(1)}, ${targetRight.toFixed(1)}], containerRect=[${containerRect.top.toFixed(1)}, ${containerRect.bottom.toFixed(1)}, ${containerRect.left.toFixed(1)}, ${containerRect.right.toFixed(1)}]`
				);

				const scrolled = scrollTargetIntoViewIfNeeded(targetRect, scrollContainer, {
					behavior: "smooth",
					forceCenter: isPageOff,
				});
				if (!scrolled) {
					logDebug("pdf", "adapter.scrollToRect: rect is already on-screen, skipping scroll");
				} else {
					logDebug("pdf", "adapter.scrollToRect: scrolled container for rect");
				}
				return;
			}

			// 2. Otherwise try to measure current active match element in DOM
			const compoundRect = getCompoundMatchBoundingRect(containerEl, pageEl);
			const currentHighlight = compoundRect
				? null
				: (pageEl.querySelector(
						".incsearch-pdf-match.is-current, .highlight.selected"
				  ) as HTMLElement | null);

			const targetRect = compoundRect ?? (currentHighlight?.getBoundingClientRect() ?? null);
			const targetHeight = targetRect?.height ?? (targetRect ? targetRect.bottom - targetRect.top : 0);
			const targetWidth = targetRect?.width ?? (targetRect ? targetRect.right - targetRect.left : 0);

			if (targetRect && (targetHeight > 0 || targetWidth > 0) && scrollContainer) {
				const pageBounds = pageEl.getBoundingClientRect();
				const isPageOff = isPageCompletelyOffScreen(pageBounds, containerRect ?? scrollContainer.getBoundingClientRect());
				logDebug(
					"pdf",
					`adapter.scrollToRect: targetRect=[${targetRect.top.toFixed(1)}, ${targetRect.bottom.toFixed(1)}, ${targetRect.left.toFixed(1)}, ${targetRect.right.toFixed(1)}], containerRect=[${containerRect?.top.toFixed(1) ?? 0}, ${containerRect?.bottom.toFixed(1) ?? 0}, ${containerRect?.left.toFixed(1) ?? 0}, ${containerRect?.right.toFixed(1) ?? 0}]`
				);
				const scrolled = scrollTargetIntoViewIfNeeded(targetRect, scrollContainer, {
					behavior: "smooth",
					forceCenter: isPageOff,
				});
				if (!scrolled) {
					logDebug("pdf", "adapter.scrollToRect: highlight is already on-screen, skipping scroll");
				} else {
					logDebug("pdf", "adapter.scrollToRect: scrolled container for highlight");
				}
				return;
			}

			this.scrollPageIntoView(pageNumber);
		},

		executeNativeFind(command: {
			query: string;
			type?: string;
			findPrevious?: boolean;
			highlightAll?: boolean;
			caseSensitive?: boolean;
			phraseSearch?: boolean;
			entireWord?: boolean;
		}): boolean {
			const {
				query,
				type = "",
				findPrevious = false,
				highlightAll = true,
				caseSensitive = false,
				phraseSearch = true,
				entireWord = false,
			} = command;

			logDebug(
				"pdf",
				`adapter.executeNativeFind: query="${query}", type="${type}", findPrevious=${findPrevious}, highlightAll=${highlightAll}`
			);
			const child = (view as any)?.viewer?.child || (view as any)?.child;
			const findController =
				pdfViewer?.findController ||
				child?.findController ||
				child?.pdfViewer?.findController ||
				(view as any)?.viewer?.findController ||
				(view as any)?.findController;

			if (findController) {
				try {
					findController._highlightAll = highlightAll;
					findController.highlightAll = highlightAll;
					if (findController.state) {
						findController.state.highlightAll = highlightAll;
					}
				} catch {
					// Ignore
				}
			}

			if (findEventBus && typeof findEventBus.dispatch === "function") {
				try {
					findEventBus.dispatch("find", {
						type,
						query,
						phraseSearch,
						caseSensitive,
						entireWord,
						highlightAll,
						findPrevious,
					});
					return true;
				} catch (e) {
					console.error("Incremental Search: error dispatching to eventBus", e);
				}
			}

			if (findController && typeof findController.executeCommand === "function") {
				try {
					try {
						findController.executeCommand("highlightallchange", {
							highlightAll,
						});
					} catch {
						// Ignore
					}
					try {
						findController.executeCommand("findhighlightallchange", {
							highlightAll,
						});
					} catch {
						// Ignore
					}
					const cmd = type === "again" ? "findagain" : "find";
					findController.executeCommand(cmd, {
						query,
						phraseSearch,
						caseSensitive,
						entireWord,
						highlightAll,
						findPrevious,
					});
					try {
						findController._updateAllPages?.();
					} catch {
						// Ignore
					}
					return true;
				} catch (e) {
					console.error(
						"Incremental Search: error executing command on findController",
						e
					);
				}
			}

			return false;
		},
	};
}
