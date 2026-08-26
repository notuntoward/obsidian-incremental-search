import { EditorView } from "@codemirror/view";
import { SearchDirection, IncrementalSearchSettings } from "./types";
import {
	searchSessionField,
	recomputeQuery,
	commitMatch,
	cancelSession,
	closeSession,
	advance,
	toggleDemandHighlights,
} from "./session";
import { PdfMatchController } from "./pdf/pdf-match-controller";

let activeWidgetEl: HTMLDivElement | null = null;
let activeKeyCleanup: (() => void) | null = null;

export function getActiveWidget(): HTMLDivElement | null {
	return activeWidgetEl;
}

/**
 * Updates the match counter ("X/Y") and direction indicator ("▲"/"▼") in the widget for Markdown.
 */
export function updateWidgetCounter(view: EditorView) {
	if (!activeWidgetEl) return;
	const counter = activeWidgetEl.querySelector(".incsearch-counter");
	const dirIndicator = activeWidgetEl.querySelector(".incsearch-dir");
	const tableIcon = activeWidgetEl.querySelector(".incsearch-table-icon") as HTMLSpanElement | null;
	const session = view.state.field(searchSessionField, false);
	if (!counter || !dirIndicator || !session || !session.matches) return;

	if (session.matches.length === 0) {
		counter.textContent = "0/0";
		dirIndicator.textContent = session.direction === "backward" ? "▲" : "▼";
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
}

/**
 * Updates the match counter ("X/Y") and direction indicator ("▲"/"▼") in the widget for PDF.
 */
export function updatePdfWidgetCounter(controller: PdfMatchController) {
	if (!activeWidgetEl) return;
	const counter = activeWidgetEl.querySelector(".incsearch-counter");
	const dirIndicator = activeWidgetEl.querySelector(".incsearch-dir");
	const tableIcon = activeWidgetEl.querySelector(".incsearch-table-icon") as HTMLSpanElement | null;
	if (!counter || !dirIndicator) return;

	if (tableIcon) tableIcon.style.display = "none";

	const { matches, activeIndex, direction, isScanning, query } = controller.state;

	if (matches.length === 0) {
		counter.textContent = isScanning && query.length > 0 ? "..." : "0/0";
	} else {
		counter.textContent = `${activeIndex + 1}/${matches.length}`;
	}
	dirIndicator.textContent = direction === "backward" ? "▲" : "▼";
}

export function showWidgetTableToast(data: NonNullable<import("./types").MatchRange["tableMatchData"]>) {
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

	toast.innerHTML = "";
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
 * Renders the floating search widget over the active editor.
 */
export function renderWidget(
	view: EditorView,
	plugin: { app: any; settings: IncrementalSearchSettings; saveSettings: () => Promise<void> },
	initialQuery: string,
	initialDirection: SearchDirection
) {
	removeWidget(view);

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
			toggleDemandHighlights(view);
		}
	};
	window.addEventListener("keydown", onGlobalKeyDown, { capture: true });
	activeKeyCleanup = () => {
		window.removeEventListener("keydown", onGlobalKeyDown, { capture: true } as any);
	};

	const container = view.dom.parentElement ?? view.dom;
	const el = document.createElement("div");
	el.className = "incsearch-widget";

	const dirIndicator = document.createElement("span");
	dirIndicator.className = "incsearch-dir";
	dirIndicator.textContent = initialDirection === "forward" ? "▼" : "▲";

	const tableIcon = document.createElement("span");
	tableIcon.className = "incsearch-table-icon";
	tableIcon.setAttribute("aria-label", "In table");
	tableIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-table"><path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>`;

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

	const updateCounter = () => updateWidgetCounter(view);

	input.addEventListener("input", () => {
		adjustInputSize();
		const activeFile = plugin.app.workspace.getActiveFile();
		const linkCache = activeFile ? plugin.app.metadataCache.getFileCache(activeFile) ?? undefined : undefined;
		recomputeQuery(
			view,
			input.value,
			view.state.field(searchSessionField, false)?.direction ?? "forward",
			plugin.settings.fuzzyMode,
			plugin.settings.matchOnlyVisibleLinks,
			linkCache,
			true, // isTyping
			plugin.settings.allMatchesDisplayMode
		);
		updateCounter();
	});

	input.addEventListener("blur", () => {
		window.setTimeout(() => {
			if (document.activeElement === input) return;
			if (el.contains(document.activeElement)) return;
			const session = view.state.field(searchSessionField, false);
			if (session) {
				closeSession(view, plugin);
			}
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
			advance(view, dir);
			updateCounter();
			return;
		}

		if (evt.key === "F3") {
			evt.preventDefault();
			evt.stopPropagation();
			const dir: SearchDirection = evt.shiftKey ? "backward" : "forward";
			advance(view, dir);
			updateCounter();
			return;
		}

		if (isCtrlOrMeta && keyLower === "g") {
			evt.preventDefault();
			evt.stopPropagation();
			cancelSession(view, plugin);
			return;
		}

		if (isCtrlOrMeta && isEnter) {
			evt.preventDefault();
			evt.stopPropagation();
			toggleDemandHighlights(view);
			return;
		}

		if (isEnter) {
			evt.preventDefault();
			evt.stopPropagation();
			if (plugin.settings.searchExitBehavior === "obsidian") {
				const session = view.state.field(searchSessionField, false);
				const currentDir = session?.direction ?? "forward";
				const dir: SearchDirection = evt.shiftKey
					? (currentDir === "forward" ? "backward" : "forward")
					: currentDir;
				advance(view, dir);
				updateCounter();
			} else {
				commitMatch(view, plugin);
			}
		} else if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			if (plugin.settings.searchExitBehavior === "obsidian") {
				commitMatch(view, plugin);
			} else {
				cancelSession(view, plugin);
			}
		}
	});

	input.focus();
	input.select();
	updateCounter();
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

	const container = controller.adapter.containerEl;
	const el = document.createElement("div");
	el.className = "incsearch-widget";

	const dirIndicator = document.createElement("span");
	dirIndicator.className = "incsearch-dir";
	dirIndicator.textContent = initialDirection === "forward" ? "▼" : "▲";

	const tableIcon = document.createElement("span");
	tableIcon.className = "incsearch-table-icon";
	tableIcon.style.display = "none";

	const input = document.createElement("input");
	input.className = "incsearch-input";
	input.type = "text";
	input.value = initialQuery;

	const counter = document.createElement("span");
	counter.className = "incsearch-counter";

	el.appendChild(dirIndicator);
	el.appendChild(tableIcon);
	el.appendChild(input);
	el.appendChild(counter);
	container.appendChild(el);
	activeWidgetEl = el;

	const adjustInputSize = () => {
		input.size = Math.max(12, input.value.length + 1);
	};
	adjustInputSize();

	const updateCounter = () => updatePdfWidgetCounter(controller);

	controller.onStateChange = () => {
		updateCounter();
	};

	input.addEventListener("input", () => {
		adjustInputSize();
		void controller.search(input.value, controller.state.direction);
		updateCounter();
	});

	input.addEventListener("blur", () => {
		window.setTimeout(() => {
			if (document.activeElement === input) return;
			if (el.contains(document.activeElement)) return;
			if (input.value) {
				plugin.settings.lastQuery = input.value;
				void plugin.saveSettings();
			}
			onClose();
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
			if (input.value) {
				plugin.settings.lastQuery = input.value;
				void plugin.saveSettings();
			}
			controller.cancel();
			onClose();
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
			if (plugin.settings.searchExitBehavior === "obsidian") {
				const currentDir = controller.state.direction || "forward";
				const dir: SearchDirection = evt.shiftKey
					? (currentDir === "forward" ? "backward" : "forward")
					: currentDir;
				controller.advance(dir);
				updateCounter();
			} else {
				if (input.value) {
					plugin.settings.lastQuery = input.value;
					void plugin.saveSettings();
				}
				controller.accept();
				onClose();
			}
		} else if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			if (input.value) {
				plugin.settings.lastQuery = input.value;
				void plugin.saveSettings();
			}
			if (plugin.settings.searchExitBehavior === "obsidian") {
				controller.accept();
			} else {
				controller.cancel();
			}
			onClose();
		}
	});

	input.focus();
	input.select();
	updateCounter();
}
