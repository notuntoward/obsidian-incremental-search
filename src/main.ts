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

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (this.pdfController && leaf?.view !== this.activePdfView) {
					this.pdfController.destroy();
					this.pdfController = null;
					this.activePdfView = null;
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
		removeAllWidgets();
	}

	private getActiveTarget(): { type: "editor"; editor: Editor } | { type: "pdf"; view: any } | null {
		const activeLeaf = (this.app.workspace as any).activeLeaf ||
			(this.app.workspace as any).getMostRecentLeaf?.();
		const activeView = activeLeaf?.view;

		// 1. If active view is a PDF view
		if (activeView && isPdfView(activeView)) {
			return { type: "pdf", view: activeView };
		}

		// 2. If active view or workspace has an active editor
		const editor = (this.app.workspace as any).activeEditor?.editor ||
			(activeView as any)?.editor;

		if (editor) {
			return { type: "editor", editor };
		}

		// 3. Fallback check for activeView of type View
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

		if (this.pdfController && this.activePdfView) {
			if (!checking) {
				this.invokePdf(this.activePdfView, direction);
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
