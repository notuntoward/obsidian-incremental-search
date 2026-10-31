import { EditorView } from "@codemirror/view";
import { App, Notice, Platform, setIcon } from "obsidian";
import { renderKeyHints } from "commons/modal";
import { searchKeyHints } from "./search-controls";
import { SearchDirection, IncrementalSearchSettings, AllMatchesDisplayMode } from "./types";
import {
	searchSessionField,
	recomputeQuery,
	commitMatch,
	cancelSession,
	advance,
	toggleDemandHighlights,
	setAllMatchesDisplayMode,
} from "./session";
import { PdfMatchController } from "./pdf/pdf-match-controller";
import { logDebug, describeElement } from "./utils/logger";

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

	/** Applies and persists a highlight mode without restarting the search. */
	setAllMatchesDisplayMode(mode: AllMatchesDisplayMode): Promise<void>;

	/** Called when search is committed (Enter in Emacs mode, Esc in Obsidian mode). */
	/** `refocus` is false when focus deliberately moved elsewhere (e.g. a click in another pane). */
	accept(refocus?: boolean): void;

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
		async setAllMatchesDisplayMode(mode) {
			plugin.settings.allMatchesDisplayMode = mode;
			setAllMatchesDisplayMode(view, mode);
			await plugin.saveSettings();
		},
		accept(refocus = true) {
			logDebug("widget", "createMarkdownSessionController: accept called");
			commitMatch(view, plugin, refocus);
		},
		cancel() {
			logDebug("widget", "createMarkdownSessionController: cancel called");
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
			// The native PDF.js find path (always used in production; see the
			// "PDF search always uses the native path" note in AGENTS.md) never
			// populates `controller.state.matches` — counts come solely from
			// `totalMatchesCount`, which is `undefined` only in the brief window
			// while a search is in flight (hence the `isScanning` fallback below).
			const { activeIndex, direction, isScanning, query, totalMatchesCount } =
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
			return {
				current: 0,
				total: 0,
				direction,
				isScanning: isScanning && query.length > 0,
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
		async setAllMatchesDisplayMode(mode) {
			plugin.settings.allMatchesDisplayMode = mode;
			controller.setAllMatchesDisplayMode(mode);
			await plugin.saveSettings();
		},
		accept() {
			logDebug("widget", "createPdfSessionController: accept called");
			saveQueryIfNeeded();
			if (typeof controller.accept === "function") {
				controller.accept();
			}
			onClose();
		},
		cancel() {
			logDebug("widget", "createPdfSessionController: cancel called");
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
	logDebug("widget", `setFocusGuard: armed for ${durationMs}ms (until ${focusGuardUntil})`);
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
			if (tableIcon) tableIcon.classList.add("is-hidden");
			return;
		}
		const activeMatch = session.matches[session.activeIndex];
		const inTable = Boolean(activeMatch && activeMatch.inTable);
		counter.textContent = `${session.activeIndex + 1}/${session.matches.length}`;
		dirIndicator.textContent = session.direction === "backward" ? "▲" : "▼";
		if (tableIcon) {
			tableIcon.classList.toggle("is-hidden", !inTable);
		}
		return;
	}

	const { current, total, direction, inTable, isScanning } = state;
	if (tableIcon) {
		tableIcon.classList.toggle("is-hidden", !inTable);
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

	if (tableIcon) tableIcon.classList.add("is-hidden");

	// See the matching comment in createPdfSessionController.getCounterState: the native
	// find path never populates `controller.state.matches`, so counts come solely from
	// `totalMatchesCount` (undefined only while a search is in flight).
	const { activeIndex, direction, isScanning, query, totalMatchesCount } = controller.state;

	if (totalMatchesCount !== undefined) {
		if (totalMatchesCount === 0) {
			counter.textContent = query.length > 0 ? "0/0" : "";
		} else {
			counter.textContent = `${activeIndex + 1}/${totalMatchesCount}`;
		}
	} else {
		counter.textContent = isScanning && query.length > 0 ? "..." : "0/0";
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

	toast.textContent = "";
	const line = toast.createSpan();
	line.appendText(before);
	line.createSpan({ cls: "incsearch-table-toast-mark", text: matched });
	line.appendText(after);
	toast.classList.remove("is-hidden");
}

export function hideWidgetTableToast() {
	if (!activeWidgetEl) return;
	const toast = activeWidgetEl.querySelector(".incsearch-table-toast") as HTMLDivElement;
	if (toast) {
		toast.classList.add("is-hidden");
	}
}

/**
 * Removes the currently active widget element from the DOM.
 */
export function removeWidget(_view?: EditorView) {
	logDebug("widget", `removeWidget called: activeWidgetEl=${describeElement(activeWidgetEl)}`);
	if (activeKeyCleanup) {
		activeKeyCleanup();
		activeKeyCleanup = null;
	}
	if (activeWidgetEl) {
		activeWidgetEl.parentElement?.classList.remove("incsearch-bar-host");
		activeWidgetEl.remove();
		activeWidgetEl = null;
	}
}

/**
 * Sweeps all widget elements from the document (used during plugin unload/reload).
 */
export function removeAllWidgets() {
	logDebug("widget", "removeAllWidgets called");
	const docs = new Set<Document>();
	if (typeof activeDocument !== "undefined") docs.add(activeDocument);
	if (typeof document !== "undefined") docs.add(document);
	if (activeWidgetEl) docs.add(activeWidgetEl.ownerDocument);
	removeWidget();
	docs.forEach((d) => d.querySelectorAll(".incsearch-widget").forEach((w) => {
		w.parentElement?.classList.remove("incsearch-bar-host");
		w.remove();
	}));
}

/**
 * Unified renderer for the floating search widget over any target view (Markdown or PDF).
 */
export function renderSearchWidget(
	controller: SearchSessionController,
	settings: IncrementalSearchSettings,
	initialQuery: string,
	initialDirection: SearchDirection,
	app?: App
) {
	logDebug(
		"widget",
		`renderSearchWidget: container=${describeElement(controller.containerEl)}, initialQuery="${initialQuery}", initialDir=${initialDirection}`
	);
	removeWidget();

	const container = controller.containerEl;
	// Pop-out windows have their own document/window; the globals refer to the main window.
	const doc = container.ownerDocument;
	const win = doc.defaultView ?? window;
	const keyTarget = doc.defaultView ?? doc;

	const onGlobalKeyDown = (evt: KeyboardEvent) => {
		const isCtrlOrMeta = evt.ctrlKey || evt.metaKey;
		// Capture before Obsidian's document shortcut handling can swallow cancel.
		if (isCtrlOrMeta && evt.key.toLowerCase() === "g" && evt.composedPath().includes(el)) {
			evt.preventDefault();
			evt.stopImmediatePropagation();
			logDebug("widget", "Ctrl/Cmd+G: cancelling incremental search");
			controller.cancel();
			return;
		}
		const isEnter =
			evt.key === "Enter" ||
			evt.code === "Enter" ||
			evt.code === "NumpadEnter" ||
			evt.keyCode === 13;
		if (isCtrlOrMeta && isEnter) {
			logDebug("widget", "globalKeyDown: Ctrl+Enter demand highlights toggle");
			evt.preventDefault();
			evt.stopPropagation();
			evt.stopImmediatePropagation();
			controller.toggleDemandHighlights();
		}
	};
	keyTarget.addEventListener("keydown", onGlobalKeyDown as EventListener, { capture: true });
	activeKeyCleanup = () => {
		keyTarget.removeEventListener("keydown", onGlobalKeyDown as EventListener, { capture: true });
	};

	const isObsidianBar = settings.searchInterface === "obsidian";
	const host = isObsidianBar
		? container.closest<HTMLElement>(".view-content") ?? container
		: container;
	const el = host.createDiv({
		cls: isObsidianBar
			? "incsearch-widget incsearch-widget-obsidian document-search-container"
			: "incsearch-widget",
		attr: { role: "search", "aria-label": "Incremental search" },
	});
	if (isObsidianBar) {
		host.prepend(el);
		host.classList.add("incsearch-bar-host");
	}

	const row = isObsidianBar ? el.createDiv({ cls: "document-search" }) : el;
	const inputHost = isObsidianBar
		? row.createDiv({ cls: "search-input-container document-search-input" })
		: el;

	inputHost.createSpan({
		cls: "incsearch-dir",
		text: initialDirection === "forward" ? "▼" : "▲",
	});

	const tableIcon = inputHost.createSpan({
		cls: "incsearch-table-icon is-hidden",
		attr: { "aria-label": "In table" },
	});
	setIcon(tableIcon, "table");

	const input = inputHost.createEl("input", {
		cls: "incsearch-input",
		type: "text",
		value: initialQuery,
		placeholder: isObsidianBar ? "Find..." : "",
		attr: { "aria-label": "Incremental search", spellcheck: "false" },
	});

	const countHost = isObsidianBar
		? row.createSpan({ cls: "document-search-count incsearch-count-container" })
		: inputHost;
	if (isObsidianBar) {
		countHost.appendChild(tableIcon);
		const methodIcon = row.createSpan({
			cls: "incsearch-method-indicator",
			attr: { "aria-label": "Incremental Search plugin", title: "Incremental Search plugin" },
		});
		row.prepend(methodIcon);
		setIcon(methodIcon, "scan-search");
	}
	countHost.createSpan({ cls: "incsearch-counter", attr: { "aria-live": "polite", "aria-atomic": "true" } });

	const hints = isObsidianBar ? el.createDiv({ cls: "incsearch-key-hints" }) : null;
	const updateHints = () => {
		if (hints) renderKeyHints(hints, [searchKeyHints(settings, app)], "incsearch");
	};
	updateHints();
	let highlightButton: HTMLButtonElement | undefined;
	const updateHighlightButton = () => {
		if (!highlightButton) return;
		const always = settings.allMatchesDisplayMode === "always";
		highlightButton.setAttribute("aria-pressed", String(always));
		highlightButton.classList.toggle("is-active", always);
		highlightButton.title = always
			? "Highlight all matches: Always. Click to use On demand."
			: `Highlight all matches: On demand. ${Platform.isMacOS ? "Cmd" : "Ctrl"}+Enter toggles highlights. Click to use Always.`;
		updateHints();
	};
	if (isObsidianBar) {
		const buttons = row.createDiv({ cls: "document-search-buttons" });
		const addButton = (icon: string, label: string, action: () => void) => {
			const button = buttons.createEl("button", {
				cls: "clickable-icon document-search-button",
				attr: { type: "button", "aria-label": label, title: label },
			});
			setIcon(button, icon);
			button.addEventListener("mousedown", (evt) => evt.preventDefault());
			button.addEventListener("click", action);
			return button;
		};
		addButton("arrow-up", "Incremental Search: Backward", () => {
			controller.advance("backward");
			updateWidgetCounter(controller);
		});
		addButton("arrow-down", "Incremental Search: Forward", () => {
			controller.advance("forward");
			updateWidgetCounter(controller);
		});
		highlightButton = addButton("text-select", "Highlight all matches", () => {
			const next = settings.allMatchesDisplayMode === "always" ? "on-demand" : "always";
			void controller.setAllMatchesDisplayMode(next).catch((error: unknown) => {
				console.error("Incremental Search: could not save highlight mode", error);
				new Notice("Could not save Highlight all matches. Check the developer console for details.");
			});
			updateHighlightButton();
		});
		addButton("x", "Cancel search", () => controller.cancel()).title =
			"Cancel search and restore the original position";
		updateHighlightButton();
	}

	el.createDiv({ cls: "incsearch-table-toast is-hidden" });

	activeWidgetEl = el;

	const adjustInputSize = () => {
		if (!isObsidianBar) input.size = Math.max(12, input.value.length + 1);
	};
	adjustInputSize();

	const updateCounter = () => updateWidgetCounter(controller);

	controller.onStateChange = () => {
		updateCounter();
	};

	input.addEventListener("input", () => {
		logDebug("widget", `input event: value="${input.value}"`);
		adjustInputSize();
		controller.onInput(input.value);
		updateCounter();
	});

	const onBlur = (evt: FocusEvent) => {
		const related = evt.relatedTarget as HTMLElement | null;
		const activeNow = doc.activeElement;
		logDebug(
			"widget",
			`input blur event fired! relatedTarget=${describeElement(related)}, activeElementNow=${describeElement(activeNow)}`
		);
		win.setTimeout(() => {
			if (activeWidgetEl !== el) return;
			const activeEl = doc.activeElement;
			const now = Date.now();
			const guardRemaining = focusGuardUntil - now;
			logDebug(
				"widget",
				`blur timeout (100ms): activeElement=${describeElement(activeEl)}, inWidget=${el.contains(activeEl)}, guardRemaining=${guardRemaining}ms`
			);
			if (activeEl === input) {
				logDebug("widget", "blur timeout: activeElement is input, keeping widget");
				return;
			}
			if (el.contains(activeEl)) {
				logDebug("widget", "blur timeout: activeElement inside widget, keeping widget");
				return;
			}
			if (now < focusGuardUntil) {
				logDebug(
					"widget",
					`blur timeout: focusGuard active (${guardRemaining}ms remaining), refocusing input`
				);
				input.focus();
				return;
			}
			logDebug(
				"widget",
				`blur timeout: focus lost to ${describeElement(activeEl)} after guard expired, calling controller.accept()`
			);
			// Focus moved to a real element elsewhere (e.g. a click in another pane/window):
			// close the search but do not steal focus back to the editor.
			const isAnotherWindowActive =
				Boolean(typeof activeWindow !== "undefined" && activeWindow && win && activeWindow !== win) ||
				Boolean(typeof activeDocument !== "undefined" && activeDocument && doc && activeDocument !== doc);
			const focusMovedElsewhere = isAnotherWindowActive || (Boolean(activeEl) && activeEl !== doc.body);
			controller.accept(!focusMovedElsewhere);
		}, 100);
	};
	input.addEventListener("blur", onBlur);
	el.addEventListener("focusout", (evt) => {
		if (evt.target !== input) onBlur(evt);
	});

	el.addEventListener("keydown", (evt: KeyboardEvent) => {
		const isCtrlOrMeta = evt.ctrlKey || evt.metaKey;
		const isEnter =
			evt.key === "Enter" ||
			evt.code === "Enter" ||
			evt.code === "NumpadEnter" ||
			evt.keyCode === 13;

		logDebug(
			"widget",
			`input keydown: key="${evt.key}", code="${evt.code}", ctrl=${evt.ctrlKey}, meta=${evt.metaKey}, shift=${evt.shiftKey}`
		);

		if (evt.key === "F3") {
			evt.preventDefault();
			evt.stopPropagation();
			const dir: SearchDirection = evt.shiftKey ? "backward" : "forward";
			controller.advance(dir);
			updateCounter();
			return;
		}

		if (isCtrlOrMeta && isEnter) {
			evt.preventDefault();
			evt.stopPropagation();
			controller.toggleDemandHighlights();
			return;
		}

		if (isEnter) {
			if (evt.target !== input) return;
			evt.preventDefault();
			evt.stopPropagation();
			if (settings.searchExitBehavior === "obsidian") {
				controller.advance(evt.shiftKey ? "backward" : "forward");
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
	logDebug("widget", `renderSearchWidget: focusing input, activeElement before=${describeElement(doc.activeElement)}`);
	input.focus();
	logDebug("widget", `renderSearchWidget: focused input, activeElement after=${describeElement(doc.activeElement)}`);
	if (initialQuery.length > 0) {
		input.select();
	} else {
		const len = input.value.length;
		input.setSelectionRange(len, len);
	}
	updateCounter();
	win.requestAnimationFrame(() => {
		logDebug(
			"widget",
			`renderSearchWidget RAF: activeWidgetEl=${describeElement(activeWidgetEl)}, activeElement=${describeElement(doc.activeElement)}`
		);
		if (activeWidgetEl && doc.activeElement !== input) {
			logDebug("widget", "renderSearchWidget RAF: refocusing input");
			input.focus();
			if (initialQuery.length > 0) {
				input.select();
			}
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
	renderSearchWidget(controller, plugin.settings, initialQuery, initialDirection, plugin.app);
}

/**
 * Renders the floating search widget over an active PDF view.
 */
export function renderPdfWidget(
	controller: PdfMatchController,
	plugin: { app: App; settings: IncrementalSearchSettings; saveSettings: () => Promise<void> },
	initialQuery: string,
	initialDirection: SearchDirection,
	onClose: () => void
) {
	const sessionController = createPdfSessionController(controller, plugin, onClose);
	renderSearchWidget(sessionController, plugin.settings, initialQuery, initialDirection, plugin.app);
}
