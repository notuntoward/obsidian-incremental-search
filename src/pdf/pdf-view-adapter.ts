import { MatchRect, PdfTextItem } from "./types";

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
	on(event: string, handler: (...args: any[]) => void): () => void;
	scrollToRect(pageNumber: number, rect?: MatchRect): void;
	scrollPageIntoView(pageNumber: number): void;
	findController?: any;
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
 * Finds the actual scrollable element containing the PDF pages.
 */
function getScrollContainer(containerEl: HTMLElement, pageEl?: HTMLElement | null): HTMLElement {
	let cur = pageEl?.parentElement || containerEl.querySelector(".page")?.parentElement;
	while (cur && cur !== document.body && cur !== document.documentElement) {
		if (cur.scrollHeight > cur.clientHeight) {
			return cur;
		}
		if (cur === containerEl) break;
		cur = cur.parentElement;
	}

	const candidates = [
		containerEl.querySelector?.(".pdf-container"),
		containerEl.querySelector?.(".pdfViewer"),
		containerEl.querySelector?.(".viewerContainer"),
		containerEl,
	].filter(Boolean) as HTMLElement[];

	for (const el of candidates) {
		if (el && el.scrollHeight > el.clientHeight) {
			return el;
		}
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

	return {
		numPages,
		containerEl,
		findController,

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
				const textLayer = pageEl.querySelector(".textLayer, .text-layer") as HTMLElement | null;
				if (textLayer) return textLayer;
			}
			try {
				const pageView =
					pdfViewer.getPageView?.(pageNumber - 1) ||
					pdfViewer._pages?.[pageNumber - 1];
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

		on(event: string, handler: (...args: any[]) => void): () => void {
			const unsubs: (() => void)[] = [];
			if (eventBus && typeof eventBus.on === "function") {
				try {
					eventBus.on(event, handler);
					unsubs.push(() => {
						try {
							if (typeof eventBus.off === "function") {
								eventBus.off(event, handler);
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
			try {
				if (typeof pdfViewer.scrollPageIntoView === "function") {
					pdfViewer.scrollPageIntoView({ pageNumber });
				} else if (typeof pdfViewer.currentPageNumber === "number") {
					pdfViewer.currentPageNumber = pageNumber;
				}
			} catch {
				// Ignore
			}

			const child = (view as any)?.viewer?.child || (view as any)?.child;
			try {
				if (typeof child?.scrollToPage === "function") {
					child.scrollToPage(pageNumber);
				} else if (typeof child?.goToPage === "function") {
					child.goToPage(pageNumber);
				}
			} catch {
				// Ignore
			}

			const pageEl = this.getPageElement(pageNumber);
			if (pageEl && typeof pageEl.scrollIntoView === "function") {
				pageEl.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
			}
		},

		scrollToRect(pageNumber: number, rect?: MatchRect) {
			const pageEl = this.getPageElement(pageNumber);
			if (!pageEl) {
				this.scrollPageIntoView(pageNumber);
				return;
			}

			// 1. If an active match element is present in DOM, scroll it directly into center
			const currentHighlight = pageEl.querySelector(".incsearch-pdf-match.is-current") as HTMLElement | null;
			if (currentHighlight && typeof currentHighlight.scrollIntoView === "function") {
				currentHighlight.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
				return;
			}

			// 2. Otherwise calculate scroll offset relative to the scroll container
			const scrollContainer = getScrollContainer(containerEl, pageEl);
			if (rect && scrollContainer) {
				const containerRect = scrollContainer.getBoundingClientRect();
				const pageBounds = pageEl.getBoundingClientRect();

				const targetY = pageBounds.top + rect.top + rect.height / 2;
				const deltaY = targetY - (containerRect.top + containerRect.height / 2);

				const targetX = pageBounds.left + rect.left + rect.width / 2;
				const deltaX = targetX - (containerRect.left + containerRect.width / 2);

				if (typeof scrollContainer.scrollBy === "function") {
					scrollContainer.scrollBy({ top: deltaY, left: deltaX, behavior: "smooth" });
				} else {
					scrollContainer.scrollTop += deltaY;
					scrollContainer.scrollLeft += deltaX;
				}
			} else {
				pageEl.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
			}
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
			const child = (view as any)?.viewer?.child || (view as any)?.child;
			const findController =
				pdfViewer?.findController ||
				child?.findController ||
				child?.pdfViewer?.findController ||
				(view as any)?.viewer?.findController ||
				(view as any)?.findController;

			if (eventBus && typeof eventBus.dispatch === "function") {
				try {
					eventBus.dispatch("find", {
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
					const cmd = type === "again" ? "findagain" : "find";
					findController.executeCommand(cmd, {
						query,
						phraseSearch,
						caseSensitive,
						entireWord,
						highlightAll,
						findPrevious,
					});
					return true;
				} catch (e) {
					console.error("Incremental Search: error executing command on findController", e);
				}
			}

			return false;
		},
	};
}
