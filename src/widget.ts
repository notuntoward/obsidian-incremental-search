import { EditorView } from "@codemirror/view";
import { App, setIcon } from "obsidian";
import { SearchDirection, IncrementalSearchSettings } from "./types";
import {
	searchSessionField,
	recomputeQuery,
	commitMatch,
	cancelSession,
	advance,
	toggleDemandHighlights,
} from "./session";
import { PdfMatchController } from "./pdf/pdf-match-controller";

let activeWidgetEl: HTMLDivElement | null = null;
let activeKeyCleanup: (() => void) | null = null;
let focusGuardUntil = 0;

/**
 * Controller abstraction that decouples search UI from the underlying search backend
 * (e.g. CodeMirror 6 markdown editor vs. PDF text layer / PdfMatchController).
 */
export interface SearchSessionController {
	/** Returns the container DOM element that the floating search widget is appended to. */
	readonly containerEl: HTMLElement;

	/** Returns current counter / status info for rendering the badge. */
	getCounterState(): {
		current: number;
		total: number;
		direction: SearchDirection;
		isScanning?: boolean;
		inTable?: boolean;
	};

	/** Called when user types in search input. */
	onInput(query: string): void;

	/** Called when user requests next/previous match. */
	advance(direction: SearchDirection): void;

	/** Called when user toggles demand highlight peek (Ctrl+Enter). */
	toggleDemandHighlights(): void;

	/** Called when search is committed (Enter in Emacs mode, Esc in Obsidian mode). */
	accept(): void;

	/** Called when search is cancelled (Esc in Emacs mode, Ctrl+G). */
	cancel(): void;

	/** Optional callback hook for asynchronous search state updates (e.g. PDF background scanning). */
	onStateChange?: (() => void) | null;
}

/**
 * Creates a SearchSessionController adapter for CodeMirror markdown editors.
 */
export function createMarkdownSessionController(
	view: EditorView,
	plugin: { app: App; settings: IncrementalSearchSettings; saveSettings: () => Promise<void> }
): SearchSessionController {
	return {
		containerEl: view.dom.parentElement ?? view.dom,
		getCounterState() {
			const session = view.state.field(searchSessionField, false);
			if (!session || !session.matches || session.matches.length === 0) {
				return {
					current: 0,
					total: 0,
					direction: session?.direction ?? "forward",
					inTable: false,
				};
			}
			const activeMatch = session.matches[session.activeIndex];
			return {
				current: session.activeIndex + 1,
				total: session.matches.length,
				direction: session.direction,
				inTable: Boolean(activeMatch && activeMatch.inTable),
			};
		},
		onInput(query: string) {
			const activeFile = plugin.app.workspace.getActiveFile();
			const linkCache = activeFile
				? (plugin.app.metadataCache.getFileCache(activeFile) ?? undefined)
				: undefined;
			recomputeQuery(
				view,
				query,
				view.state.field(searchSessionField, false)?.direction ?? "forward",
				plugin.settings.spaceAsWildcard,
				plugin.settings.matchOnlyVisibleLinks,
				linkCache,
				true, // isTyping
				plugin.settings.allMatchesDisplayMode
			);
		},
		advance(direction: SearchDirection) {
			advance(view, direction);
		},
		toggleDemandHighlights() {
			toggleDemandHighlights(view);
		},
		accept() {
			commitMatch(view, plugin);
		},
		cancel() {
			cancelSession(view, plugin);
		},
	};
}

/**
 * Creates a SearchSessionController adapter for PDF match controller.
 */
export function createPdfSessionController(
	controller: PdfMatchController,
	plugin: { settings: IncrementalSearchSettings; saveSettings: () => Promise<void> },
	onClose: () => void
): SearchSessionController {
	const saveQueryIfNeeded = () => {
		if (controller.state.query) {
			plugin.settings.lastQuery = controller.state.query;
			void plugin.saveSettings();
		}
	};

	return {
		containerEl: controller.adapter.containerEl,
		getCounterState() {
			const { matches, activeIndex, direction, isScanning, query, totalMatchesCount } =
				controller.state;
			if (totalMatchesCount !== undefined) {
				if (totalMatchesCount === 0) {
					return {
						current: 0,
						total: 0,
						direction,
						isScanning: false,
						inTable: false,
					};
				}
				return {
					current: activeIndex + 1,
					total: totalMatchesCount,
					direction,
					isScanning: false,
					inTable: false,
				};
			}
			if (matches.length === 0) {
				return {
					current: 0,
					total: 0,
					direction,
					isScanning: isScanning && query.length > 0,
					inTable: false,
				};
			}
			return {
				current: activeIndex + 1,
				total: matches.length,
				direction,
				isScanning: false,
				inTable: false,
			};
		},
		onInput(query: string) {
			void controller.search(query, controller.state.direction);
		},
		advance(direction: SearchDirection) {
			controller.advance(direction);
		},
		toggleDemandHighlights() {
			controller.toggleDemandHighlights();
		},
		accept() {
			saveQueryIfNeeded();
			if (typeof controller.accept === "function") {
				controller.accept();
			}
			onClose();
		},
		cancel() {
			saveQueryIfNeeded();
			if (typeof controller.cancel === "function") {
				controller.cancel();
			}
			onClose();
		},
		get onStateChange() {
			return controller.onStateChange
				? () => {
						controller.onStateChange?.(controller.state);
					}
				: null;
		},
		set onStateChange(cb: (() => void) | null | undefined) {
			controller.onStateChange = cb ? () => cb() : undefined;
		},
	};
}

/**
 * Arms a focus-guard that prevents the blur handler from closing the session
 * for `durationMs` milliseconds.  If something steals focus within that
 * window the guard re-focuses the input instead of tearing down the widget.
 */
export function setFocusGuard(durationMs = 200) {
	focusGuardUntil = Date.now() + durationMs;
}

export function getActiveWidget(): HTMLDivElement | null {
	return activeWidgetEl;
}

/**
 * Updates the match counter ("X/Y") and direction indicator ("▲"/"▼") in the active widget.
 */
export function updateWidgetCounter(target: SearchSessionController | EditorView) {
	if (!activeWidgetEl) return;
	const counter = activeWidgetEl.querySelector(".incsearch-counter");
	const dirIndicator = activeWidgetEl.querySelector(".incsearch-dir");
	const tableIcon = activeWidgetEl.querySelector(
		".incsearch-table-icon"
	) as HTMLSpanElement | null;
	if (!counter || !dirIndicator) return;

	let state: ReturnType<SearchSessionController["getCounterState"]>;
	if ("getCounterState" in target && typeof target.getCounterState === "function") {
		state = target.getCounterState();
	} else {
		// EditorView fallback
		const view = target as EditorView;
		const session = view.state.field(searchSessionField, false);
		if (!session || !session.matches || session.matches.length === 0) {
			counter.textContent = "0/0";
			dirIndicator.textContent = session?.direction === "backward" ? "▲" : "▼";
			if (tableIcon) tableIcon.style.display = "none";
			return;
		}
		const activeMatch = session.matches[session.activeIndex];
		const inTable = Boolean(activeMatch && activeMatch.inTable);
		counter.textContent = `${session.activeIndex + 1}/${session.matches.length}`;
		dirIndicator.textContent = session.direction === "backward" ? "▲" : "▼";
		if (tableIcon) {
			tableIcon.style.display = inTable ? "inline-flex" : "none";
		}
		return;
	}

	const { current, total, direction, inTable, isScanning } = state;
	if (tableIcon) {
		tableIcon.style.display = inTable ? "inline-flex" : "none";
	}

	if (total === 0) {
		counter.textContent = isScanning ? "..." : "0/0";
	} else {
		counter.textContent = `${current}/${total}`;
	}
	dirIndicator.textContent = direction === "backward" ? "▲" : "▼";
}

/**
 * Updates the match counter ("X/Y") and direction indicator ("▲"/"▼") in the widget for PDF.
 */
export function updatePdfWidgetCounter(controller: PdfMatchController) {
	if (!activeWidgetEl) return;
	const counter = activeWidgetEl.querySelector(".incsearch-counter");
	const dirIndicator = activeWidgetEl.querySelector(".incsearch-dir");
	const tableIcon = activeWidgetEl.querySelector(
		".incsearch-table-icon"
	) as HTMLSpanElement | null;
	if (!counter || !dirIndicator) return;

	if (tableIcon) tableIcon.style.display = "none";

	const { matches, activeIndex, direction, isScanning, query, totalMatchesCount } =
		controller.state;

	if (totalMatchesCount !== undefined) {
		if (totalMatchesCount === 0) {
			counter.textContent = query.length > 0 ? "0/0" : "";
		} else {
			counter.textContent = `${activeIndex + 1}/${totalMatchesCount}`;
		}
	} else if (matches.length === 0) {
		counter.textContent = isScanning && query.length > 0 ? "..." : "0/0";
	} else {
		counter.textContent = `${activeIndex + 1}/${matches.length}`;
	}
	dirIndicator.textContent = direction === "backward" ? "▲" : "▼";
}

export function showWidgetTableToast(
	data: NonNullable<import("./types").MatchRange["tableMatchData"]>
) {
	if (!activeWidgetEl) return;
	const toast = activeWidgetEl.querySelector(".incsearch-table-toast") as HTMLDivElement;
	if (!toast) return;

	const { cellText, matchStartInCell, matchEndInCell } = data;
	const before = cellText.slice(0, matchStartInCell);
	const matched = cellText.slice(matchStartInCell, matchEndInCell);
	const after = cellText.slice(matchEndInCell);

	const fragment = document.createDocumentFragment();
	const container = document.createElement("span");
	container.appendChild(document.createTextNode(before));
	const mark = document.createElement("span");
	mark.className = "incsearch-table-toast-mark";
	mark.textContent = matched;
	container.appendChild(mark);
	container.appendChild(document.createTextNode(after));
	fragment.appendChild(container);

	toast.textContent = "";
	toast.appendChild(fragment);
	toast.style.display = "block";
}

export function hideWidgetTableToast() {
	if (!activeWidgetEl) return;
	const toast = activeWidgetEl.querySelector(".incsearch-table-toast") as HTMLDivElement;
	if (toast) {
		toast.style.display = "none";
	}
}

/**
 * Removes the currently active widget element from the DOM.
 */
export function removeWidget(_view?: EditorView) {
	if (activeKeyCleanup) {
		activeKeyCleanup();
		activeKeyCleanup = null;
	}
	if (activeWidgetEl) {
		activeWidgetEl.remove();
		activeWidgetEl = null;
	}
}

/**
 * Sweeps all widget elements from the document (used during plugin unload/reload).
 */
export function removeAllWidgets() {
	if (activeKeyCleanup) {
		activeKeyCleanup();
		activeKeyCleanup = null;
	}
	document.querySelectorAll(".incsearch-widget").forEach((w) => w.remove());
	if (activeWidgetEl) {
		activeWidgetEl = null;
	}
}

/**
 * Unified renderer for the floating search widget over any target view (Markdown or PDF).
 */
export function renderSearchWidget(
	controller: SearchSessionController,
	settings: IncrementalSearchSettings,
	initialQuery: string,
	initialDirection: SearchDirection
) {
	removeWidget();

	const onGlobalKeyDown = (evt: KeyboardEvent) => {
		const isCtrlOrMeta = evt.ctrlKey || evt.metaKey;
		const isEnter =
			evt.key === "Enter" ||
			evt.code === "Enter" ||
			evt.code === "NumpadEnter" ||
			evt.keyCode === 13;
		if (isCtrlOrMeta && isEnter) {
			evt.preventDefault();
			evt.stopPropagation();
			evt.stopImmediatePropagation();
			controller.toggleDemandHighlights();
		}
	};
	window.addEventListener("keydown", onGlobalKeyDown, { capture: true });
	activeKeyCleanup = () => {
		window.removeEventListener("keydown", onGlobalKeyDown, { capture: true } as any);
	};

	const container = controller.containerEl;
	const el = document.createElement("div");
	el.className = "incsearch-widget";

	const dirIndicator = document.createElement("span");
	dirIndicator.className = "incsearch-dir";
	dirIndicator.textContent = initialDirection === "forward" ? "▼" : "▲";

	const tableIcon = document.createElement("span");
	tableIcon.className = "incsearch-table-icon";
	tableIcon.setAttribute("aria-label", "In table");
	tableIcon.style.display = "none";
	setIcon(tableIcon, "table");

	const input = document.createElement("input");
	input.className = "incsearch-input";
	input.type = "text";
	input.value = initialQuery;

	const counter = document.createElement("span");
	counter.className = "incsearch-counter";

	const toast = document.createElement("div");
	toast.className = "incsearch-table-toast";

	el.appendChild(dirIndicator);
	el.appendChild(tableIcon);
	el.appendChild(input);
	el.appendChild(counter);
	el.appendChild(toast);
	container.appendChild(el);
	activeWidgetEl = el;

	const adjustInputSize = () => {
		input.size = Math.max(12, input.value.length + 1);
	};
	adjustInputSize();

	const updateCounter = () => updateWidgetCounter(controller);

	controller.onStateChange = () => {
		updateCounter();
	};

	input.addEventListener("input", () => {
		adjustInputSize();
		controller.onInput(input.value);
		updateCounter();
	});

	input.addEventListener("blur", () => {
		window.setTimeout(() => {
			if (document.activeElement === input) return;
			if (el.contains(document.activeElement)) return;
			if (Date.now() < focusGuardUntil) {
				input.focus();
				return;
			}
			controller.cancel();
		}, 100);
	});

	input.addEventListener("keydown", (evt: KeyboardEvent) => {
		const isCtrlOrMeta = evt.ctrlKey || evt.metaKey;
		const keyLower = evt.key.toLowerCase();
		const isEnter =
			evt.key === "Enter" ||
			evt.code === "Enter" ||
			evt.code === "NumpadEnter" ||
			evt.keyCode === 13;

		if (isCtrlOrMeta && (keyLower === "s" || keyLower === "r")) {
			evt.preventDefault();
			evt.stopPropagation();
			const dir: SearchDirection = keyLower === "s" ? "forward" : "backward";
			controller.advance(dir);
			updateCounter();
			return;
		}

		if (evt.key === "F3") {
			evt.preventDefault();
			evt.stopPropagation();
			const dir: SearchDirection = evt.shiftKey ? "backward" : "forward";
			controller.advance(dir);
			updateCounter();
			return;
		}

		if (isCtrlOrMeta && keyLower === "g") {
			evt.preventDefault();
			evt.stopPropagation();
			controller.cancel();
			return;
		}

		if (isCtrlOrMeta && isEnter) {
			evt.preventDefault();
			evt.stopPropagation();
			controller.toggleDemandHighlights();
			return;
		}

		if (isEnter) {
			evt.preventDefault();
			evt.stopPropagation();
			if (settings.searchExitBehavior === "obsidian") {
				const currentDir = controller.getCounterState().direction || "forward";
				const dir: SearchDirection = evt.shiftKey
					? currentDir === "forward"
						? "backward"
						: "forward"
					: currentDir;
				controller.advance(dir);
				updateCounter();
			} else {
				controller.accept();
			}
		} else if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			if (settings.searchExitBehavior === "obsidian") {
				controller.accept();
			} else {
				controller.cancel();
			}
		}
	});

	setFocusGuard();
	input.focus();
	const len = input.value.length;
	input.setSelectionRange(len, len);
	updateCounter();
	window.requestAnimationFrame(() => {
		if (activeWidgetEl && document.activeElement !== input) {
			input.focus();
		}
	});
}

/**
 * Renders the floating search widget over the active editor (Markdown).
 */
export function renderWidget(
	view: EditorView,
	plugin: { app: any; settings: IncrementalSearchSettings; saveSettings: () => Promise<void> },
	initialQuery: string,
	initialDirection: SearchDirection
) {
	const controller = createMarkdownSessionController(view, plugin);
	renderSearchWidget(controller, plugin.settings, initialQuery, initialDirection);
}

/**
 * Renders the floating search widget over an active PDF view.
 */
export function renderPdfWidget(
	controller: PdfMatchController,
	plugin: { settings: IncrementalSearchSettings; saveSettings: () => Promise<void> },
	initialQuery: string,
	initialDirection: SearchDirection,
	onClose: () => void
) {
	const sessionController = createPdfSessionController(controller, plugin, onClose);
	renderSearchWidget(sessionController, plugin.settings, initialQuery, initialDirection);
}
