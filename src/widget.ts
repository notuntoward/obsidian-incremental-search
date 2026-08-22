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
	const session = view.state.field(searchSessionField, false);
	if (!counter || !dirIndicator || !session || !session.matches) return;

	if (session.matches.length === 0) {
		counter.textContent = "0/0";
		dirIndicator.textContent = session.direction === "backward" ? "▲" : "▼";
		return;
	}
	counter.textContent = `${session.activeIndex + 1}/${session.matches.length}`;
	dirIndicator.textContent = session.direction === "backward" ? "▲" : "▼";
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
	plugin: { settings: IncrementalSearchSettings; saveSettings: () => Promise<void> },
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

	const input = document.createElement("input");
	input.className = "incsearch-input";
	input.type = "text";
	input.value = initialQuery;

	const counter = document.createElement("span");
	counter.className = "incsearch-counter";

	el.appendChild(dirIndicator);
	el.appendChild(input);
	el.appendChild(counter);
	container.appendChild(el);
	activeWidgetEl = el;

	const updateCounter = () => updateWidgetCounter(view);

	input.addEventListener("input", () => {
		recomputeQuery(
			view,
			input.value,
			view.state.field(searchSessionField, false)?.direction ?? "forward",
			plugin.settings.fuzzyMode,
			plugin.settings.matchOnlyVisibleLinks
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
