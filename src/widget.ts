import { EditorView } from "@codemirror/view";
import { SearchDirection, IncrementalSearchSettings } from "./types";
import {
	searchSessionField,
	recomputeQuery,
	commitMatch,
	cancelSession,
	closeSession,
} from "./session";

let activeWidgetEl: HTMLDivElement | null = null;

export function getActiveWidget(): HTMLDivElement | null {
	return activeWidgetEl;
}

/**
 * Updates the match counter ("X/Y") and direction indicator ("▲"/"▼") in the widget.
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
	if (activeWidgetEl) {
		activeWidgetEl.remove();
		activeWidgetEl = null;
	}
}

/**
 * Sweeps all widget elements from the document (used during plugin unload/reload).
 */
export function removeAllWidgets() {
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
			true // isTyping
		);
		updateCounter();
	});

	input.addEventListener("blur", () => {
		window.setTimeout(() => {
			const session = view.state.field(searchSessionField, false);
			if (session) {
				closeSession(view, plugin);
			}
		}, 0);
	});

	input.addEventListener("keydown", (evt: KeyboardEvent) => {
		if (evt.key === "Enter") {
			evt.preventDefault();
			evt.stopPropagation();
			commitMatch(view, plugin);
		} else if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			cancelSession(view, plugin);
		}
	});

	input.focus();
	input.select();
	updateCounter();
}
