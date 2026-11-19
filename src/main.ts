import { focusLeafAndWindow, getActiveLeafInFocusedWindow, isLeafDetached } from "commons/workspace";
import { forEachWindow } from "commons/windows";
import { dispatchSearchNavigation, searchRepeatAction } from "commons/search";
import { Plugin, PluginSettingTab, App, Editor, Setting, View, type SettingDefinitionItem, type WorkspaceLeaf } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
	IncrementalSearchSettings,
	DEFAULT_SETTINGS,
	SearchDirection,
} from "./types";
import {
	searchSessionField,
	searchHighlightPlugin,
	setSession,
	recomputeQuery,
	advance,
	closeSession,
} from "./session";
import {
	renderWidget,
	renderPdfWidget,
	updateWidgetCounter,
	updatePdfWidgetCounter,
	removeAllWidgets,
	removeWidget,
	getActiveWidget,
	setFocusGuard,
} from "./widget";
import { updateResolvedOutlineColor, applyPdfColors } from "./utils/colors";
import { getOrComputeSecondaryStyle, invalidateAppearanceCache } from "./utils/adaptive-highlight";
import { logDebug, describeElement, setDebugLogging } from "./utils/logger";
import { isPdfView, createPdfViewAdapter } from "./pdf/pdf-view-adapter";
import { PdfMatchController } from "./pdf/pdf-match-controller";
import type { PdfMatchPosition } from "./pdf/types";
import { clearAllPdfHighlights } from "./pdf/highlight-layer";
import { clearSecondaryHighlights } from "./pdf/text-layer-highlighter";

export * from "./types";
export * from "./engine";
export * from "./session";
export * from "./widget";
export * from "./pdf/types";
export * from "./pdf/highlight-layer";
export * from "./pdf/pdf-view-adapter";
export * from "./pdf/pdf-match-controller";
export * from "./utils/adaptive-highlight";
export * from "./utils/logger";
export * from "./utils/scroll";

/**
 * Returns the text selected inside `root`, or "" when the selection is empty or lies
 * elsewhere (another note, pane or window). PDF line breaks become single spaces.
 */
export function getSelectionWithin(root: HTMLElement | null | undefined): string {
	const selection = root?.ownerDocument?.getSelection();
	if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return "";
	const { anchorNode, focusNode } = selection;
	if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) return "";
	return selection.toString().replace(/\s+/g, " ").trim();
}

function getViewEditor(view: View | undefined): Editor | undefined {
	return (view as { editor?: Editor } | undefined)?.editor;
}

interface RuntimeLeaf {
	containerEl: HTMLElement;
	view: View;
}

function getRuntimeLeaf(leaf: WorkspaceLeaf): RuntimeLeaf {
	return leaf as unknown as RuntimeLeaf;
}

// A repeat press (advance or recall) can move focus to the editor or PDF viewer while it
// scrolls to the match; the widget's blur handler would then accept and close the bar.
function keepSearchInputFocused(): void {
	const input = getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input");
	if (!input) return;
	setFocusGuard();
	input.focus();
	(input.ownerDocument.defaultView ?? activeWindow).requestAnimationFrame(() => {
		if (getActiveWidget() && input.ownerDocument.activeElement !== input) {
			logDebug("main", "repeat press RAF: refocusing input");
			input.focus();
		}
	});
}

export default class IncrementalSearchPlugin extends Plugin {
	settings: IncrementalSearchSettings;
	pdfController: PdfMatchController | null = null;
	activePdfView: unknown = null;
	/** Last accepted match per PDF file path; the next search there continues after it. */
	acceptedPdfMatches = new Map<string, PdfMatchPosition>();
	lastInteractedLeaf: WorkspaceLeaf | null = null;

	async onload() {
		await this.loadSettings();

		this.registerEditorExtension([searchSessionField, searchHighlightPlugin]);

		this.app.workspace.onLayoutReady(() => {
			updateResolvedOutlineColor();
			getOrComputeSecondaryStyle(this.settings);
			this.refreshAllPdfColors();
		});

		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				invalidateAppearanceCache();
				updateResolvedOutlineColor();
				getOrComputeSecondaryStyle(this.settings);
				this.refreshAllPdfColors();
			})
		);

		const handleLeafInteraction = (evt: MouseEvent | PointerEvent) => {
			const target = evt.target as HTMLElement | null;
			if (!target) return;

			const activeWidget = getActiveWidget();
			logDebug(
				"main",
				`handleLeafInteraction (${evt.type}) target=${describeElement(target)}, activeWidget=${describeElement(activeWidget)}`
			);

			if (activeWidget && activeWidget.contains(target)) {
				return;
			}

			const leafEl = target.closest<HTMLElement>(".workspace-leaf");
			if (!leafEl) return;

			this.app.workspace.iterateAllLeaves?.((leaf) => {
				const runtimeLeaf = getRuntimeLeaf(leaf);
				if (runtimeLeaf.containerEl === leafEl) {
					if (!isLeafDetached(leaf)) {
						this.lastInteractedLeaf = leaf;
					} else {
						this.lastInteractedLeaf = null;
					}
					if (this.app.workspace.getMostRecentLeaf?.() !== leaf) {
						logDebug(
							"main",
							`handleLeafInteraction setting activeLeaf to ${describeElement(leafEl)}`
						);
						focusLeafAndWindow(this.app, leaf);
					}
					if (activeWidget && !leafEl.contains(activeWidget)) {
						logDebug(
							"main",
							`handleLeafInteraction removing widget because click was outside widget leaf (${describeElement(leafEl)})`
						);
						const input = activeWidget.querySelector("input");
						if (input) {
							input.blur();
						}
						removeWidget();
					}
					if (isPdfView(runtimeLeaf.view)) {
						leafEl.setAttribute("tabindex", "-1");
						leafEl.focus();
					}
				}
			});
		};

		// Pop-out windows have their own document, so interaction listeners must be
		// attached to each window's document, not just the main one.
		const hookedDocs = new WeakSet<Document>();
		const hookDocument = (doc: Document | null | undefined) => {
			if (!doc || hookedDocs.has(doc)) return;
			hookedDocs.add(doc);
			this.registerDomEvent(doc, "pointerdown", handleLeafInteraction, {
				capture: true,
			});
			this.registerDomEvent(doc, "mousedown", handleLeafInteraction, {
				capture: true,
			});
		};

		forEachWindow(this, (win) => {
			hookDocument(win?.document);
		});
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves?.((leaf) => {
				const doc = getRuntimeLeaf(leaf).containerEl?.ownerDocument;
				if (doc) hookDocument(doc);
			});
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const runtimeLeaf = leaf ? getRuntimeLeaf(leaf) : null;
				logDebug(
					"main",
					`active-leaf-change: leaf=${describeElement(leaf ? getRuntimeLeaf(leaf).containerEl : null)}, isPdf=${isPdfView(leaf ? getRuntimeLeaf(leaf).view : null)}`
				);
				if (leaf) {
					this.lastInteractedLeaf = leaf;
				}
				if (this.pdfController && leaf?.view !== this.activePdfView) {
					logDebug("main", "active-leaf-change: destroying pdfController and removing widget");
					this.pdfController.destroy();
					this.pdfController = null;
					this.activePdfView = null;
					removeWidget();
				}
				if (runtimeLeaf?.view && isPdfView(runtimeLeaf.view)) {
					logDebug("main", "active-leaf-change: PDF view active, removing widget");
					removeWidget();
					// Clear any residue highlights left behind by previous sessions
					const adapter = createPdfViewAdapter(runtimeLeaf.view);
					if (adapter) {
						clearSecondaryHighlights(adapter.containerEl);
						clearAllPdfHighlights(adapter.containerEl);
						if (adapter.executeNativeFind) {
							adapter.executeNativeFind({
								query: "",
								type: "find",
								highlightAll: false,
							});
						}
					}
				}
			})
		);

		this.addCommand({
			id: "forward",
			name: "Forward Emacs",
			checkCallback: (checking: boolean) => this.handleCommand(checking, "forward"),
		});

		this.addCommand({
			id: "backward",
			name: "Reverse Emacs",
			checkCallback: (checking: boolean) => this.handleCommand(checking, "backward"),
		});

		this.addSettingTab(new IncrementalSearchSettingTab(this.app, this));
	}

	onunload() {
		logDebug("main", "onunload called, sweeping widgets");
		if (this.pdfController) {
			this.pdfController.destroy();
			this.pdfController = null;
			this.activePdfView = null;
		}
		this.lastInteractedLeaf = null;
		removeAllWidgets();
	}

	private getActiveTarget():
		{ type: "editor"; editor: Editor } | { type: "pdf"; view: unknown } | null {
		const activeEl = activeDocument.activeElement;
		logDebug("main", `getActiveTarget: activeElement=${describeElement(activeEl)}`);

		// 1. If document.activeElement is inside a specific workspace leaf, use that leaf
		if (activeEl && activeEl !== activeDocument.body) {
			const focusedLeaves: WorkspaceLeaf[] = [];
			this.app.workspace.iterateAllLeaves?.((leaf) => {
				if (getRuntimeLeaf(leaf).containerEl?.contains(activeEl)) {
					focusedLeaves.push(leaf);
				}
			});
			const focusedLeaf = focusedLeaves[0];
			const focusedRuntime = focusedLeaf ? getRuntimeLeaf(focusedLeaf) : null;
			if (focusedLeaf && focusedRuntime?.view && !isLeafDetached(focusedLeaf)) {
				if (isPdfView(focusedRuntime.view)) {
					logDebug("main", "getActiveTarget [1]: activeElement in focused leaf -> PDF view");
					return { type: "pdf", view: focusedRuntime.view };
				}
				const editor = getViewEditor(focusedRuntime.view);
				if (editor) {
					logDebug("main", "getActiveTarget [1]: activeElement in focused leaf -> Editor view");
					return { type: "editor", editor };
				}
			}
		}

		// 2. If the user recently clicked/interacted with a specific leaf
		const lastInteractedRuntime = this.lastInteractedLeaf
			? getRuntimeLeaf(this.lastInteractedLeaf)
			: null;
		if (this.lastInteractedLeaf && lastInteractedRuntime?.view && !isLeafDetached(this.lastInteractedLeaf)) {
			if (isPdfView(lastInteractedRuntime.view)) {
				logDebug("main", "getActiveTarget [2]: lastInteractedLeaf -> PDF view");
				return { type: "pdf", view: lastInteractedRuntime.view };
			}
			const editor = getViewEditor(lastInteractedRuntime.view);
			if (editor) {
				logDebug("main", "getActiveTarget [2]: lastInteractedLeaf -> Editor view");
				return { type: "editor", editor };
			}
		} else if (this.lastInteractedLeaf && isLeafDetached(this.lastInteractedLeaf)) {
			this.lastInteractedLeaf = null;
		}

		// 3. Check leaf with .mod-active in DOM
		const modActiveLeafEl = activeDocument.querySelector(".workspace-leaf.mod-active");
		if (modActiveLeafEl) {
			const activeLeafObjects: WorkspaceLeaf[] = [];
			this.app.workspace.iterateAllLeaves?.((leaf) => {
				if (getRuntimeLeaf(leaf).containerEl === modActiveLeafEl) {
					activeLeafObjects.push(leaf);
				}
			});
			const activeLeafObj = activeLeafObjects[0];
			const activeRuntime = activeLeafObj ? getRuntimeLeaf(activeLeafObj) : null;
			if (activeLeafObj && activeRuntime?.view && !isLeafDetached(activeLeafObj)) {
				if (isPdfView(activeRuntime.view)) {
					logDebug("main", "getActiveTarget [3]: mod-active leaf -> PDF view");
					return { type: "pdf", view: activeRuntime.view };
				}
				const editor = getViewEditor(activeRuntime.view);
				if (editor) {
					logDebug("main", "getActiveTarget [3]: mod-active leaf -> Editor view");
					return { type: "editor", editor };
				}
			}
		}

		// 4. Prefer the active leaf in the focused window
		const activeInWindow = getActiveLeafInFocusedWindow(this.app);
		const activeInWindowRuntime = activeInWindow ? getRuntimeLeaf(activeInWindow) : null;
		if (activeInWindow && activeInWindowRuntime?.view && !isLeafDetached(activeInWindow)) {
			if (isPdfView(activeInWindowRuntime.view)) {
				logDebug("main", "getActiveTarget [4]: getActiveLeafInFocusedWindow -> PDF view");
				return { type: "pdf", view: activeInWindowRuntime.view };
			}
			const editor = getViewEditor(activeInWindowRuntime.view);
			if (editor) {
				logDebug("main", "getActiveTarget [4]: getActiveLeafInFocusedWindow -> Editor view");
				return { type: "editor", editor };
			}
		}

		// 5. Prefer the documented `getMostRecentLeaf()` API over reading `workspace.activeLeaf`
		// directly; fall back to the discouraged property only if that returns nothing.
		const activeLeaf = this.app.workspace.getMostRecentLeaf?.();
		const activeView = activeLeaf ? getRuntimeLeaf(activeLeaf).view : undefined;

		if (activeView && !isLeafDetached(activeLeaf)) {
			if (isPdfView(activeView)) {
				logDebug("main", "getActiveTarget [5]: getMostRecentLeaf -> PDF view");
				return { type: "pdf", view: activeView };
			}
			const editor = getViewEditor(activeView);
			if (editor) {
				logDebug("main", "getActiveTarget [5]: getMostRecentLeaf -> Editor view");
				return { type: "editor", editor };
			}
		}

		// 6. Fallback to activeLeaf on workspace
		const fallbackView = this.app.workspace.getActiveViewOfType(View);
		if (fallbackView) {
			if (isPdfView(fallbackView)) {
				logDebug("main", "getActiveTarget [6]: getActiveViewOfType -> PDF view");
				return { type: "pdf", view: fallbackView };
			}
			const editor = (fallbackView as View & { editor?: Editor }).editor;
			if (editor) {
				logDebug("main", "getActiveTarget [6]: getActiveViewOfType -> Editor view");
				return { type: "editor", editor };
			}
		}

		logDebug("main", "getActiveTarget: no active target found (returning null)");
		return null;
	}

	handleCommand(checking: boolean, direction: SearchDirection, explicitEditor?: Editor): boolean {
		logDebug(
			"main",
			`handleCommand: direction=${direction}, checking=${checking}, explicitEditor=${Boolean(explicitEditor)}`
		);
		if (explicitEditor) {
			if (!checking) {
				this.invoke(explicitEditor, direction);
			}
			return true;
		}
		if (dispatchSearchNavigation(activeDocument.activeElement, direction, checking)) return true;

		const target = this.getActiveTarget();
		logDebug("main", `handleCommand: target=${target?.type ?? "null"}`);
		if (!target) return false;

		if (!checking && this.lastInteractedLeaf && !isLeafDetached(this.lastInteractedLeaf)) {
			focusLeafAndWindow(this.app, this.lastInteractedLeaf);
		}

		if (target.type === "pdf") {
			if (!checking) {
				this.invokePdf(target.view, direction);
			}
			return true;
		}

		if (target.type === "editor") {
			if (!checking) {
				this.invoke(target.editor, direction);
			}
			return true;
		}

		return false;
	}

	invokePdf(view: unknown, direction: SearchDirection) {
		logDebug("main", `invokePdf: direction=${direction}, hasController=${Boolean(this.pdfController)}`);
		// Repeat-press behavior (advance / recall the last query) applies only while this
		// PDF's search bar is open; otherwise a fresh search starts empty.
		if (this.pdfController && (this.activePdfView !== view || !getActiveWidget())) {
			logDebug("main", "invokePdf: discarding stale PDF search");
			this.pdfController.destroy();
			this.pdfController = null;
		}
		this.activePdfView = view;

		if (this.pdfController) {
			if (searchRepeatAction(true, this.pdfController.state.query, this.settings.lastQuery) === "recall") {
				logDebug("main", `invokePdf: double-tap recall query="${this.settings.lastQuery}"`);
				void this.pdfController.search(this.settings.lastQuery, direction);
				const input = getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input");
				if (input) {
					input.value = this.settings.lastQuery;
					input.setSelectionRange(input.value.length, input.value.length);
				}
				keepSearchInputFocused();
			} else {
				logDebug("main", `invokePdf: advancing in direction ${direction}`);
				this.pdfController.advance(direction);
				keepSearchInputFocused();
			}
			updatePdfWidgetCounter(this.pdfController);
			return;
		}

		removeWidget();

		const adapter = createPdfViewAdapter(view);
		if (!adapter) {
			logDebug("main", "invokePdf: createPdfViewAdapter returned null");
			return;
		}

		this.pdfController = new PdfMatchController(adapter, this.settings, direction, () => {
			if (this.pdfController) {
				updatePdfWidgetCounter(this.pdfController);
			}
		});
		const pdfPath = (view as { file?: { path?: string } }).file?.path;
		this.pdfController.startAfter = (pdfPath && this.acceptedPdfMatches.get(pdfPath)) || null;

		const startingQuery = getSelectionWithin(adapter.containerEl);
		logDebug("main", `invokePdf: rendering PDF widget with startingQuery="${startingQuery}"`);
		renderPdfWidget(this.pdfController, this, startingQuery, direction, () => {
			logDebug("main", "invokePdf: onClose callback triggered");
			const accepted = this.pdfController?.acceptedPosition;
			if (pdfPath && accepted) this.acceptedPdfMatches.set(pdfPath, accepted);
			this.pdfController?.destroy();
			this.pdfController = null;
			this.activePdfView = null;
			removeWidget();
		});

		if (startingQuery) {
			void this.pdfController.search(startingQuery, direction);
		}
	}

	invoke(editor: Editor, direction: SearchDirection) {
		logDebug("main", `invoke (markdown): direction=${direction}`);
		// If switching to markdown while a PDF search was active, clean up PDF controller
		if (this.pdfController) {
			logDebug("main", "invoke: cleaning up PDF controller");
			this.pdfController.destroy();
			this.pdfController = null;
			this.activePdfView = null;
			removeWidget();
		}

		const view = (editor as Editor & { cm?: EditorView }).cm;
		if (!view) {
			logDebug("main", "invoke: editor.cm view is undefined");
			return;
		}

		let session = view.state.field(searchSessionField, false);
		// Repeat-press behavior (advance / recall the last query) applies only while this
		// note's search bar is open. A session left behind when the bar was closed elsewhere
		// (pane click, leaf switch, search started in another note) is discarded.
		const widget = getActiveWidget();
		if (session && !widget?.parentElement?.contains(view.dom)) {
			logDebug("main", "invoke: discarding stale session without a visible search bar");
			closeSession(view, this);
			session = null;
		}
		if (session) {
			logDebug("main", `invoke: existing session found (query="${session.query}", activeIndex=${session.activeIndex})`);
			if (searchRepeatAction(true, session.query, this.settings.lastQuery) === "recall") {
				logDebug("main", `invoke: double-tap recall query="${this.settings.lastQuery}"`);
				const activeFile = this.app.workspace.getActiveFile();
				const linkCache = activeFile
					? (this.app.metadataCache.getFileCache(activeFile) ?? undefined)
					: undefined;
				recomputeQuery(
					view,
					this.settings.lastQuery,
					direction,
					this.settings.spaceAsWildcard,
					this.settings.matchOnlyVisibleLinks,
					linkCache,
					false,
					this.settings.allMatchesDisplayMode
				);
				const input = getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input");
				if (input) {
					input.value = this.settings.lastQuery;
					input.setSelectionRange(input.value.length, input.value.length);
				}
				keepSearchInputFocused();
			} else {
				logDebug("main", `invoke: advancing existing session in direction ${direction}`);
				advance(view, direction);
				keepSearchInputFocused();
			}
			updateWidgetCounter(view);
			return;
		}

		const sel = view.state?.selection?.main;
		let selectedText = "";
		if (sel && !sel.empty && sel.from !== undefined && sel.to !== undefined) {
			if (typeof view.state.sliceDoc === "function") {
				selectedText = view.state.sliceDoc(sel.from, sel.to);
			} else if (typeof view.state.doc.sliceString === "function") {
				selectedText = view.state.doc.sliceString(sel.from, sel.to);
			} else if (typeof view.state.doc?.toString === "function") {
				selectedText = view.state.doc.toString().slice(sel.from, sel.to);
			}
		}
		const startingQuery = selectedText;
		logDebug(
			"main",
			`invoke: creating new markdown session from cursor [${sel.anchor}, ${sel.head}], startingQuery="${startingQuery}"`
		);

		view.dispatch({
			effects: setSession.of({
				query: startingQuery,
				direction,
				matches: [],
				activeIndex: 0,
				originSelection: { anchor: sel.anchor, head: sel.head },
				allMatchesDisplayMode: this.settings.allMatchesDisplayMode,
				isDemandPeekActive: false,
			}),
		});

		if (startingQuery) {
			const activeFile = this.app.workspace.getActiveFile();
			const linkCache = activeFile
				? (this.app.metadataCache.getFileCache(activeFile) ?? undefined)
				: undefined;
			recomputeQuery(
				view,
				startingQuery,
				direction,
				this.settings.spaceAsWildcard,
				this.settings.matchOnlyVisibleLinks,
				linkCache,
				false,
				this.settings.allMatchesDisplayMode
			);
		}
		logDebug("main", "invoke: rendering floating search widget");
		renderWidget(view, this, startingQuery, direction);
	}

	async loadSettings() {
		type PersistedSettings = Omit<Partial<IncrementalSearchSettings>, "searchInterface"> & {
			highlightAllMatches?: boolean;
			fuzzyMode?: boolean;
			searchInterface?: IncrementalSearchSettings["searchInterface"] | "popup";
			usePopupModal?: boolean;
		};
		const loaded = ((await this.loadData()) || {}) as PersistedSettings;
		if (
			loaded.allMatchesDisplayMode === undefined &&
			typeof loaded.highlightAllMatches === "boolean"
		) {
			loaded.allMatchesDisplayMode = loaded.highlightAllMatches ? "always" : "off";
		}
		delete loaded.highlightAllMatches;

		if (loaded.spaceAsWildcard === undefined && typeof loaded.fuzzyMode === "boolean") {
			loaded.spaceAsWildcard = loaded.fuzzyMode;
		}
		delete loaded.fuzzyMode;

		if (loaded.searchInterface === undefined || loaded.searchInterface === "popup") {
			loaded.searchInterface = DEFAULT_SETTINGS.searchInterface;
		}
		delete loaded.usePopupModal;

		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		setDebugLogging(this.settings.debugLogging);
		await this.saveSettings();
	}

	async saveSettings() {
		if (this.settings.searchInterface === "obsidian" && this.settings.allMatchesDisplayMode === "off") {
			this.settings.allMatchesDisplayMode = "on-demand";
		}
		setDebugLogging(this.settings.debugLogging);
		invalidateAppearanceCache();
		updateResolvedOutlineColor();
		getOrComputeSecondaryStyle(this.settings);
		this.refreshAllPdfColors();
		await this.saveData(this.settings);
	}

	/**
	 * Recomputes white-page-optimized match colors on every open PDF viewer so
	 * searches are immediately ready after any theme or match-style change.
	 */
	refreshAllPdfColors() {
		this.app.workspace.iterateAllLeaves?.((leaf) => {
			const runtimeLeaf = getRuntimeLeaf(leaf);
			if (runtimeLeaf.view && isPdfView(runtimeLeaf.view)) {
				const adapter = createPdfViewAdapter(runtimeLeaf.view);
				if (adapter?.containerEl) {
					applyPdfColors(adapter.containerEl, this.settings);
				}
			}
		});
	}
}

/**
 * Synthetic control key for the secondary-prominence slider. The persisted
 * setting (`secondaryProminence`) is a 0..1 fraction, but the slider is a
 * 0..100 control, so the value is scaled in getControlValue()/setControlValue().
 * This key is never written to the settings object.
 */
const PROMINENCE_PERCENT_KEY = "secondaryProminencePercent";

class IncrementalSearchSettingTab extends PluginSettingTab {
	plugin: IncrementalSearchPlugin;

	constructor(app: App, plugin: IncrementalSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Reads a control's current value from plugin settings. `key` is normally a
	 * settings property name; `PROMINENCE_PERCENT_KEY` is synthetic (see below).
	 */
	getControlValue(key: string): unknown {
		if (key === PROMINENCE_PERCENT_KEY) {
			return Math.round(this.plugin.settings.secondaryProminence * 100);
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	/**
	 * Persists a control change and applies its side effects (recoloring, cache
	 * invalidation) through saveSettings().
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === PROMINENCE_PERCENT_KEY) {
			this.plugin.settings.secondaryProminence = Number(value) / 100;
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		}
		await this.plugin.saveSettings();
		if (key === "searchInterface") {
			// The highlight dropdown's options change with the selected interface.
			this.update();
		} else if (key === "secondaryHighlightStyle" || key === "allMatchesDisplayMode") {
			this.refreshDomState();
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const showSecondary = () => this.plugin.settings.allMatchesDisplayMode !== "off";
		return [
			{
				type: "group",
				heading: "Interface",
				cls: "incsearch-settings-group",
				items: [
					{
						name: "Search interface",
						desc: "Choose Compact or the Obsidian-style bar for notes and PDFs. Matching and keyboard settings stay the same.",
						control: {
							type: "dropdown",
							key: "searchInterface",
							options: {
								compact: "Compact",
								obsidian: "Obsidian-style bar",
							},
						},
					},
				],
			},
			{
				type: "group",
				heading: "Matching",
				cls: "incsearch-settings-group",
				items: [
					{
						name: "Space-as-wildcard matching",
						desc: "Match words separated by wildcard spaces instead of literal substring matches.",
						control: {
							type: "toggle",
							key: "spaceAsWildcard",
						},
					},
					{
						name: "Match only visible part of links",
						desc: "Ignore hidden URLs in markdown links and hidden destinations in wikilinks. Applies to Markdown.",
						control: {
							type: "toggle",
							key: "matchOnlyVisibleLinks",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Navigation & exit",
				cls: "incsearch-settings-group",
				items: [
					{
						name: "Search keyboard behavior",
						desc: "Emacs: Enter accepts; Escape cancels. Obsidian: Enter next; Shift+Enter previous; Escape accepts. Ctrl/Cmd+G cancels in every interface.",
						control: {
							type: "dropdown",
							key: "searchExitBehavior",
							options: {
								emacs: "Emacs-style",
								obsidian: "Obsidian-style",
							},
						},
					},
				],
			},
			{
				type: "group",
				heading: "Match highlighting",
				cls: "incsearch-settings-group",
				items: [
					{
						name: "Highlight all matches",
						desc:
							this.plugin.settings.searchInterface === "obsidian"
								? "The bar button saves Always / On demand. Ctrl/Cmd+Enter toggles other matches in On demand. Off is unavailable for this bar."
								: "Controls when other matches are highlighted. In On demand, Ctrl/Cmd+Enter temporarily toggles them.",
						control: {
							type: "dropdown",
							key: "allMatchesDisplayMode",
							options: {
								always: "Always",
								"on-demand": "On demand",
								...(this.plugin.settings.searchInterface === "obsidian"
									? {}
									: { off: "Off" }),
							},
						},
					},
					{
						name: "Secondary match highlight style",
						visible: showSecondary,
						desc: "Appearance of other matches. Adaptive uses theme-matched fill and borders.",
						control: {
							type: "dropdown",
							key: "secondaryHighlightStyle",
							options: {
								adaptive: "Adaptive",
								underline: "Dotted underline",
								tint: "Background tint",
								theme: "Obsidian default",
								custom: "Custom colors",
							},
						},
					},
					{
						name: "Secondary match prominence",
						visible: showSecondary,
						desc: "Strength of other matches relative to the current match.",
						control: {
							type: "slider",
							key: PROMINENCE_PERCENT_KEY,
							min: 20,
							max: 100,
							step: 5,
							displayFormat: (value: number) => `${value}%`,
						},
					},
					{
						name: "Enforce text legibility (WCAG)",
						visible: () =>
							showSecondary() &&
							this.plugin.settings.secondaryHighlightStyle !== "underline" &&
							this.plugin.settings.secondaryHighlightStyle !== "theme",
						desc: "Use a dotted underline if tinting would reduce text contrast.",
						control: {
							type: "toggle",
							key: "secondaryEnforceLegibility",
						},
					},

					{
						name: "Custom color (Light theme)",
						desc: "Custom CSS color (hex, rgb, or rgba) for secondary highlights in light mode.",
						visible: () =>
							showSecondary() &&
							this.plugin.settings.secondaryHighlightStyle === "custom",
						control: {
							type: "text",
							key: "secondaryCustomLightColor",
							placeholder: "#ffe066 or rgba(255, 224, 102, 0.5)",
						},
					},
					{
						name: "Custom color (Dark theme)",
						desc: "Custom CSS color (hex, rgb, or rgba) for secondary highlights in dark mode.",
						visible: () =>
							showSecondary() &&
							this.plugin.settings.secondaryHighlightStyle === "custom",
						control: {
							type: "text",
							key: "secondaryCustomDarkColor",
							placeholder: "#705dcf or rgba(112, 93, 207, 0.5)",
						},
					},
					{
						name: "Highlighting live preview",
						visible: showSecondary,
						desc: "Preview of the current and secondary match styles in the active theme.",
						render: (setting: Setting) => {
							// Full-width preview: stack the row and append the sample beneath it,
							// reusing the .incsearch-settings-preview box styling.
							setting.settingEl.addClass("incsearch-settings-preview-row");
							const box = setting.settingEl.createDiv({
								cls: "incsearch-settings-preview",
							});
							box.createSpan({ text: "Example text demonstrating an " });
							box.createSpan({
								cls: "incsearch-match-exact is-current",
								text: "active match",
							});
							box.createSpan({ text: " and a " });
							box.createSpan({
								cls: "incsearch-match-exact",
								text: "secondary match",
							});
							box.createSpan({ text: " in the active theme." });
						},
					},
				],
			},
			{
				type: "group",
				heading: "Troubleshooting",
				cls: "incsearch-settings-group",
				items: [
					{
						name: "Debug logging",
						desc: "Write detailed diagnostic messages to the developer console. Leave this off unless you are troubleshooting.",
						control: {
							type: "toggle",
							key: "debugLogging",
						},
					},
				],
			},
		];
	}
}
