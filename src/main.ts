import { Plugin, PluginSettingTab, App, Setting, Editor, View } from "obsidian";
import { EditorView } from "@codemirror/view";
import { IncrementalSearchSettings, DEFAULT_SETTINGS, SearchDirection } from "./types";
import {
	searchSessionField,
	searchHighlightPlugin,
	setSession,
	recomputeQuery,
	advance,
} from "./session";
import {
	renderWidget,
	renderPdfWidget,
	updateWidgetCounter,
	updatePdfWidgetCounter,
	removeAllWidgets,
	removeWidget,
	getActiveWidget,
} from "./widget";
import { IncrementalSearchSuggestModal } from "./modal";
import { updateResolvedOutlineColor } from "./utils/colors";
import { isPdfView, createPdfViewAdapter } from "./pdf/pdf-view-adapter";
import { PdfMatchController } from "./pdf/pdf-match-controller";

export * from "./types";
export * from "./engine";
export * from "./session";
export * from "./widget";
export * from "./modal";
export * from "./pdf/types";
export * from "./pdf/text-model";
export * from "./pdf/pattern-matcher";
export * from "./pdf/match-geometry";
export * from "./pdf/highlight-layer";
export * from "./pdf/pdf-view-adapter";
export * from "./pdf/pdf-match-controller";

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
		});

		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				updateResolvedOutlineColor();
			})
		);

		const handleLeafInteraction = (evt: MouseEvent | PointerEvent) => {
			const target = evt.target as HTMLElement | null;
			if (!target) return;

			const activeWidget = getActiveWidget();
			if (activeWidget && activeWidget.contains(target)) {
				return;
			}

			const leafEl = target.closest(".workspace-leaf") as HTMLElement | null;
			if (!leafEl) return;

			this.app.workspace.iterateAllLeaves?.((leaf: any) => {
				if (leaf.containerEl === leafEl) {
					this.lastInteractedLeaf = leaf;
					if (this.app.workspace.activeLeaf !== leaf) {
						this.app.workspace.setActiveLeaf(leaf, { focus: true });
					}
					if (activeWidget && !leafEl.contains(activeWidget)) {
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

		this.registerDomEvent(document, "pointerdown", handleLeafInteraction, { capture: true } as any);
		this.registerDomEvent(document, "mousedown", handleLeafInteraction, { capture: true } as any);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf) {
					this.lastInteractedLeaf = leaf;
				}
				if (this.pdfController && leaf?.view !== this.activePdfView) {
					this.pdfController.destroy();
					this.pdfController = null;
					this.activePdfView = null;
					removeWidget();
				}
				if (leaf?.view && isPdfView(leaf.view)) {
					removeWidget();
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
		if (this.pdfController) {
			this.pdfController.destroy();
			this.pdfController = null;
			this.activePdfView = null;
		}
		this.lastInteractedLeaf = null;
		removeAllWidgets();
	}

	private getActiveTarget(): { type: "editor"; editor: Editor } | { type: "pdf"; view: any } | null {
		const activeEl = document.activeElement;

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
					return { type: "pdf", view: focusedLeaf.view };
				}
				if (focusedLeaf.view.editor) {
					return { type: "editor", editor: focusedLeaf.view.editor };
				}
			}
		}

		// 2. If the user recently clicked/interacted with a specific leaf
		if (this.lastInteractedLeaf?.view) {
			if (isPdfView(this.lastInteractedLeaf.view)) {
				return { type: "pdf", view: this.lastInteractedLeaf.view };
			}
			if (this.lastInteractedLeaf.view.editor) {
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
					return { type: "pdf", view: activeLeafObj.view };
				}
				if (activeLeafObj.view.editor) {
					return { type: "editor", editor: activeLeafObj.view.editor };
				}
			}
		}

		// 4. Check workspace.activeLeaf
		const activeLeaf = (this.app.workspace as any).activeLeaf ||
			(this.app.workspace as any).getMostRecentLeaf?.();
		const activeView = activeLeaf?.view;

		if (activeView && isPdfView(activeView)) {
			return { type: "pdf", view: activeView };
		}
		if (activeView?.editor) {
			return { type: "editor", editor: activeView.editor };
		}

		// 5. Fallback check for activeView of type View
		const fallbackView = (this.app.workspace as any).getActiveViewOfType?.(View);
		if (fallbackView && isPdfView(fallbackView)) {
			return { type: "pdf", view: fallbackView };
		}
		if ((fallbackView as any)?.editor) {
			return { type: "editor", editor: (fallbackView as any).editor };
		}

		return null;
	}

	handleCommand(checking: boolean, direction: SearchDirection, explicitEditor?: Editor): boolean {
		if (explicitEditor) {
			if (!checking) {
				this.invoke(explicitEditor, direction);
			}
			return true;
		}

		const target = this.getActiveTarget();
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
		this.activePdfView = view;

		if (this.pdfController) {
			if (this.pdfController.state.query === "" && this.settings.lastQuery) {
				void this.pdfController.search(this.settings.lastQuery, direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector(".incsearch-input") as HTMLInputElement;
					if (input) {
						input.value = this.settings.lastQuery;
						input.select();
					}
				}
			} else {
				this.pdfController.advance(direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector<HTMLInputElement>(".incsearch-input");
					input?.focus();
				}
			}
			updatePdfWidgetCounter(this.pdfController);
			return;
		}

		removeWidget();

		const adapter = createPdfViewAdapter(view);
		if (!adapter) return;

		this.pdfController = new PdfMatchController(
			adapter,
			this.settings,
			direction,
			() => {
				if (this.pdfController) {
					updatePdfWidgetCounter(this.pdfController);
				}
			}
		);

		const startingQuery = "";
		renderPdfWidget(
			this.pdfController,
			this,
			startingQuery,
			direction,
			() => {
				this.pdfController?.destroy();
				this.pdfController = null;
				this.activePdfView = null;
				removeWidget();
			}
		);
	}

	invoke(editor: Editor, direction: SearchDirection) {
		// If switching to markdown while a PDF search was active, clean up PDF controller
		if (this.pdfController) {
			this.pdfController.destroy();
			this.pdfController = null;
			this.activePdfView = null;
			removeWidget();
		}

		// @ts-expect-error CodeMirror view is attached to editor.cm in Obsidian runtime
		const view: EditorView | undefined = editor.cm;
		if (!view) return;

		const session = view.state.field(searchSessionField, false);
		if (session) {
			if (session.query === "" && this.settings.lastQuery) {
				const activeFile = this.app.workspace.getActiveFile();
				const linkCache = activeFile ? this.app.metadataCache.getFileCache(activeFile) ?? undefined : undefined;
				recomputeQuery(
					view,
					this.settings.lastQuery,
					direction,
					this.settings.fuzzyMode,
					this.settings.matchOnlyVisibleLinks,
					linkCache,
					false,
					this.settings.highlightAllMatches
				);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector(".incsearch-input") as HTMLInputElement;
					if (input) {
						input.value = this.settings.lastQuery;
						input.select();
					}
				}
			} else {
				advance(view, direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector<HTMLInputElement>(".incsearch-input");
					input?.focus();
				}
			}
			updateWidgetCounter(view);
			return;
		}

		const sel = view.state.selection.main;
		const startingQuery = "";

		view.dispatch({
			effects: setSession.of({
				query: startingQuery,
				direction,
				matches: [],
				activeIndex: 0,
				originSelection: { anchor: sel.anchor, head: sel.head },
				highlightAllMatches: this.settings.highlightAllMatches,
			}),
		});

		if (this.settings.usePopupModal) {
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
			}
		} else {
			if (startingQuery) {
				recomputeQuery(
					view,
					startingQuery,
					direction,
					this.settings.fuzzyMode,
					this.settings.matchOnlyVisibleLinks,
					undefined,
					false,
					this.settings.highlightAllMatches
				);
			}
			renderWidget(view, this, startingQuery, direction);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class IncrementalSearchSettingTab extends PluginSettingTab {
	plugin: IncrementalSearchPlugin;

	constructor(app: App, plugin: IncrementalSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Highlight all matches")
			.setDesc("Highlight all matches across the note or PDF, not just the active match.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.highlightAllMatches)
					.onChange(async (value) => {
						this.plugin.settings.highlightAllMatches = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Fuzzy matching")
			.setDesc(
				"Match words separated by wildcard spaces instead of literal substring matches."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.fuzzyMode).onChange(async (value) => {
					this.plugin.settings.fuzzyMode = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Double-tap window (ms)")
			.setDesc("How quickly you must press the search hotkey twice to reuse your last query.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.doubleTapWindowMs))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed)) {
							this.plugin.settings.doubleTapWindowMs = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Match only visible part of links")
			.setDesc("Ignore hidden URLs in markdown links and hidden destinations in wikilinks.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.matchOnlyVisibleLinks)
					.onChange(async (value) => {
						this.plugin.settings.matchOnlyVisibleLinks = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Use popup modal interface")
			.setDesc("If enabled, use a center-screen popup instead of the inline floating widget.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.usePopupModal).onChange(async (value) => {
					this.plugin.settings.usePopupModal = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
