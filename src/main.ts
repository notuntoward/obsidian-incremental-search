import { Plugin, PluginSettingTab, App, Setting, Editor, View, type SettingDefinitionItem } from "obsidian";
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
	commitMatch,
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
import { IncrementalSearchSuggestModal } from "./modal";
import { updateResolvedOutlineColor, applyPdfColors } from "./utils/colors";
import { getOrComputeSecondaryStyle, invalidateAppearanceCache } from "./utils/adaptive-highlight";
import { logDebug, describeElement, setDebugLogging } from "./utils/logger";
import { isPdfView, createPdfViewAdapter } from "./pdf/pdf-view-adapter";
import { PdfMatchController } from "./pdf/pdf-match-controller";
import { clearAllPdfHighlights } from "./pdf/highlight-layer";
import { clearSecondaryHighlights } from "./pdf/text-layer-highlighter";

export * from "./types";
export * from "./engine";
export * from "./session";
export * from "./widget";
export * from "./modal";
export * from "./pdf/types";
export * from "./pdf/highlight-layer";
export * from "./pdf/pdf-view-adapter";
export * from "./pdf/pdf-match-controller";
export * from "./utils/adaptive-highlight";
export * from "./utils/logger";
export * from "./utils/scroll";

export default class IncrementalSearchPlugin extends Plugin {
	settings: IncrementalSearchSettings;
	pdfController: PdfMatchController | null = null;
	activePdfView: any = null;
	lastInteractedLeaf: any = null;

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

			const leafEl = target.closest(".workspace-leaf") as HTMLElement | null;
			if (!leafEl) return;

			this.app.workspace.iterateAllLeaves?.((leaf: any) => {
				if (leaf.containerEl === leafEl) {
					this.lastInteractedLeaf = leaf;
					// `workspace.activeLeaf` is discouraged for reading "the current view" (use
					// `getActiveViewOfType` for that), but there is no supported way to compare
					// leaf identity to avoid a redundant `setActiveLeaf` call here. Reading the
					// DOM `mod-active` class instead would race against Obsidian's own
					// pointerdown/mousedown leaf-activation handling, since we cannot guarantee
					// listener ordering, so this narrower identity check is kept intentionally.
					if (this.app.workspace.activeLeaf !== leaf) {
						logDebug(
							"main",
							`handleLeafInteraction setting activeLeaf to ${describeElement(leafEl)}`
						);
						this.app.workspace.setActiveLeaf(leaf, { focus: true });
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
					if (isPdfView(leaf.view)) {
						leafEl.setAttribute("tabindex", "-1");
						leafEl.focus();
					}
				}
			});
		};

		this.registerDomEvent(document, "pointerdown", handleLeafInteraction, {
			capture: true,
		} as any);
		this.registerDomEvent(document, "mousedown", handleLeafInteraction, {
			capture: true,
		} as any);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				logDebug(
					"main",
					`active-leaf-change: leaf=${describeElement((leaf as any)?.containerEl)}, isPdf=${isPdfView(leaf?.view)}`
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
				if (leaf?.view && isPdfView(leaf.view)) {
					logDebug("main", "active-leaf-change: PDF view active, removing widget");
					removeWidget();
					// Clear any residue highlights left behind by previous sessions
					const adapter = createPdfViewAdapter(leaf.view);
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
			name: "Forward",
			checkCallback: (checking: boolean) => this.handleCommand(checking, "forward"),
		});

		this.addCommand({
			id: "backward",
			name: "Backward",
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
		{ type: "editor"; editor: Editor } | { type: "pdf"; view: any } | null {
		const activeEl = document.activeElement;
		logDebug("main", `getActiveTarget: activeElement=${describeElement(activeEl)}`);

		// 1. If document.activeElement is inside a specific workspace leaf, use that leaf
		if (activeEl && activeEl !== document.body) {
			let focusedLeaf: any = null;
			this.app.workspace.iterateAllLeaves?.((leaf: any) => {
				if (leaf.containerEl?.contains(activeEl)) {
					focusedLeaf = leaf;
				}
			});
			if (focusedLeaf?.view) {
				if (isPdfView(focusedLeaf.view)) {
					logDebug("main", "getActiveTarget [1]: activeElement in focused leaf -> PDF view");
					return { type: "pdf", view: focusedLeaf.view };
				}
				if (focusedLeaf.view.editor) {
					logDebug("main", "getActiveTarget [1]: activeElement in focused leaf -> Editor view");
					return { type: "editor", editor: focusedLeaf.view.editor };
				}
			}
		}

		// 2. If the user recently clicked/interacted with a specific leaf
		if (this.lastInteractedLeaf?.view) {
			if (isPdfView(this.lastInteractedLeaf.view)) {
				logDebug("main", "getActiveTarget [2]: lastInteractedLeaf -> PDF view");
				return { type: "pdf", view: this.lastInteractedLeaf.view };
			}
			if (this.lastInteractedLeaf.view.editor) {
				logDebug("main", "getActiveTarget [2]: lastInteractedLeaf -> Editor view");
				return { type: "editor", editor: this.lastInteractedLeaf.view.editor };
			}
		}

		// 3. Check leaf with .mod-active in DOM
		const modActiveLeafEl = document.querySelector(".workspace-leaf.mod-active");
		if (modActiveLeafEl) {
			let activeLeafObj: any = null;
			this.app.workspace.iterateAllLeaves?.((leaf: any) => {
				if (leaf.containerEl === modActiveLeafEl) {
					activeLeafObj = leaf;
				}
			});
			if (activeLeafObj?.view) {
				if (isPdfView(activeLeafObj.view)) {
					logDebug("main", "getActiveTarget [3]: mod-active leaf -> PDF view");
					return { type: "pdf", view: activeLeafObj.view };
				}
				if (activeLeafObj.view.editor) {
					logDebug("main", "getActiveTarget [3]: mod-active leaf -> Editor view");
					return { type: "editor", editor: activeLeafObj.view.editor };
				}
			}
		}

		// 4. Prefer the documented `getMostRecentLeaf()` API over reading `workspace.activeLeaf`
		// directly; fall back to the discouraged property only if that returns nothing.
		const activeLeaf =
			this.app.workspace.getMostRecentLeaf?.() || (this.app.workspace as any).activeLeaf;
		const activeView = activeLeaf?.view;

		if (activeView && isPdfView(activeView)) {
			logDebug("main", "getActiveTarget [4]: getMostRecentLeaf -> PDF view");
			return { type: "pdf", view: activeView };
		}
		if (activeView?.editor) {
			logDebug("main", "getActiveTarget [4]: getMostRecentLeaf -> Editor view");
			return { type: "editor", editor: activeView.editor };
		}

		// 5. Fallback to activeLeaf on workspace
		const fallbackView = this.app.workspace.getActiveViewOfType(View as any);
		if (fallbackView && isPdfView(fallbackView)) {
			logDebug("main", "getActiveTarget [5]: getActiveViewOfType -> PDF view");
			return { type: "pdf", view: fallbackView };
		}
		if ((fallbackView as any)?.editor) {
			logDebug("main", "getActiveTarget [5]: getActiveViewOfType -> Editor view");
			return { type: "editor", editor: (fallbackView as any).editor };
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

		const target = this.getActiveTarget();
		logDebug("main", `handleCommand: target=${target?.type ?? "null"}`);
		if (!target) return false;

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

	invokePdf(view: any, direction: SearchDirection) {
		logDebug("main", `invokePdf: direction=${direction}, hasController=${Boolean(this.pdfController)}`);
		this.activePdfView = view;

		if (this.pdfController) {
			if (this.pdfController.state.query === "" && this.settings.lastQuery) {
				logDebug("main", `invokePdf: double-tap recall query="${this.settings.lastQuery}"`);
				void this.pdfController.search(this.settings.lastQuery, direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector(".incsearch-input") as HTMLInputElement;
					if (input) {
						input.value = this.settings.lastQuery;
						const len = input.value.length;
						input.setSelectionRange(len, len);
					}
				}
			} else {
				logDebug("main", `invokePdf: advancing in direction ${direction}`);
				this.pdfController.advance(direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector<HTMLInputElement>(".incsearch-input");
					if (input) {
						setFocusGuard();
						input.focus();
						window.requestAnimationFrame(() => {
							if (getActiveWidget() && document.activeElement !== input) {
								logDebug("main", "invokePdf RAF: refocusing input");
								input.focus();
							}
						});
					}
				}
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

		const startingQuery =
			typeof window !== "undefined"
				? window.getSelection()?.toString().trim() ?? ""
				: "";
		logDebug("main", `invokePdf: rendering PDF widget with startingQuery="${startingQuery}"`);
		renderPdfWidget(this.pdfController, this, startingQuery, direction, () => {
			logDebug("main", "invokePdf: onClose callback triggered");
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

		// @ts-expect-error CodeMirror view is attached to editor.cm in Obsidian runtime
		const view: EditorView | undefined = editor.cm;
		if (!view) {
			logDebug("main", "invoke: editor.cm view is undefined");
			return;
		}

		const session = view.state.field(searchSessionField, false);
		if (session) {
			logDebug("main", `invoke: existing session found (query="${session.query}", activeIndex=${session.activeIndex})`);
			if (session.query === "" && this.settings.lastQuery) {
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
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector(".incsearch-input") as HTMLInputElement;
					if (input) {
						input.value = this.settings.lastQuery;
						const len = input.value.length;
						input.setSelectionRange(len, len);
					}
				}
			} else {
				logDebug("main", `invoke: advancing existing session in direction ${direction}`);
				advance(view, direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector<HTMLInputElement>(".incsearch-input");
					if (input) {
						setFocusGuard();
						input.focus();
						window.requestAnimationFrame(() => {
							if (getActiveWidget() && document.activeElement !== input) {
								logDebug("main", "invoke RAF: refocusing input");
								input.focus();
							}
						});
					}
				}
			}
			updateWidgetCounter(view);
			return;
		}

		const sel = view.state?.selection?.main;
		let selectedText = "";
		if (sel && !sel.empty && sel.from !== undefined && sel.to !== undefined) {
			if (typeof view.state.sliceDoc === "function") {
				selectedText = view.state.sliceDoc(sel.from, sel.to);
			} else if (typeof (view.state.doc as any)?.sliceString === "function") {
				selectedText = (view.state.doc as any).sliceString(sel.from, sel.to);
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

		if (this.settings.usePopupModal) {
			logDebug("main", "invoke: opening modal search dialog");
			const modal = new IncrementalSearchSuggestModal(
				this.app,
				this,
				editor,
				view,
				direction
			);
			modal.open();
			if (startingQuery) {
				modal.inputEl.value = startingQuery;
				modal.inputEl.dispatchEvent(new Event("input"));
				modal.inputEl.select();
			}
		} else {
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
	}

	async loadSettings() {
		const loaded = (await this.loadData()) || {};
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

		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		setDebugLogging(this.settings.debugLogging);
		await this.saveSettings();
	}

	async saveSettings() {
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
		this.app.workspace.iterateAllLeaves?.((leaf: any) => {
			if (leaf?.view && isPdfView(leaf.view)) {
				const adapter = createPdfViewAdapter(leaf.view);
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
		// Custom-color rows only render when this style is selected; visibility is a
		// predicate, so re-evaluate it in place rather than rebuilding the tab.
		if (key === "secondaryHighlightStyle") {
			this.refreshDomState();
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Search exit behavior",
				desc: "Determines how Enter and Escape end an active incremental search session.",
				control: {
					type: "dropdown",
					key: "searchExitBehavior",
					options: {
						emacs: "Emacs-style (Enter accepts, Escape cancels)",
						obsidian: "Obsidian-style (Enter finds next, Escape accepts)",
					},
				},
			},
			{
				name: "Highlight all matches",
				desc: "Controls when matches other than the current match are highlighted during incremental search.",
				control: {
					type: "dropdown",
					key: "allMatchesDisplayMode",
					options: {
						always: "Always",
						"on-demand": "On demand (Ctrl+Enter to toggle)",
						off: "Off",
					},
				},
			},
			{
				name: "Secondary match highlight style",
				desc: "Visual styling strategy for non-current matches. 'Adaptive' automatically derives fill and edge colors from the active theme and current match.",
				control: {
					type: "dropdown",
					key: "secondaryHighlightStyle",
					options: {
						adaptive: "Adaptive (Theme-matched fill + edge)",
						underline: "Dotted underline only",
						tint: "Subtle background tint only",
						theme: "Obsidian highlight default",
						custom: "Custom colors",
					},
				},
			},
			{
				name: "Secondary match prominence",
				desc: "Controls the visual strength and subordination level of secondary matches relative to the active match.",
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
				desc: "Automatically fall back to a dotted underline if background tinting would compromise normal text contrast.",
				control: {
					type: "toggle",
					key: "secondaryEnforceLegibility",
				},
			},

			{
				name: "Custom color (Light theme)",
				desc: "Custom CSS color (hex, rgb, or rgba) for secondary highlights in light mode.",
				visible: () => this.plugin.settings.secondaryHighlightStyle === "custom",
				control: {
					type: "text",
					key: "secondaryCustomLightColor",
					placeholder: "#ffe066 or rgba(255, 224, 102, 0.5)",
				},
			},
			{
				name: "Custom color (Dark theme)",
				desc: "Custom CSS color (hex, rgb, or rgba) for secondary highlights in dark mode.",
				visible: () => this.plugin.settings.secondaryHighlightStyle === "custom",
				control: {
					type: "text",
					key: "secondaryCustomDarkColor",
					placeholder: "#705dcf or rgba(112, 93, 207, 0.5)",
				},
			},
			{
				name: "Highlighting live preview",
				desc: "Preview of the current and secondary match styles in the active theme.",
				render: (setting: Setting) => {
					// Full-width preview: stack the row and append the sample beneath it,
					// reusing the .incsearch-settings-preview box styling.
					setting.settingEl.addClass("incsearch-settings-preview-row");
					const box = setting.settingEl.createDiv({ cls: "incsearch-settings-preview" });
					box.createSpan({ text: "Example text demonstrating an " });
					box.createSpan({ cls: "incsearch-match-exact is-current", text: "active match" });
					box.createSpan({ text: " and a " });
					box.createSpan({ cls: "incsearch-match-exact", text: "secondary match" });
					box.createSpan({ text: " in the active theme." });
				},
			},
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
				desc: "Ignore hidden URLs in markdown links and hidden destinations in wikilinks.",
				control: {
					type: "toggle",
					key: "matchOnlyVisibleLinks",
				},
			},
			{
				name: "Use popup modal interface",
				desc: "If enabled, use a center-screen popup instead of the inline floating widget.",
				control: {
					type: "toggle",
					key: "usePopupModal",
				},
			},
			{
				name: "Debug logging",
				desc: "Write detailed diagnostic messages to the developer console. Leave this off unless you are troubleshooting.",
				control: {
					type: "toggle",
					key: "debugLogging",
				},
			},
		];
	}
}
