import { Plugin, PluginSettingTab, App, Setting, Editor, View } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
	IncrementalSearchSettings,
	DEFAULT_SETTINGS,
	SearchDirection,
	AllMatchesDisplayMode,
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
export * from "./pdf/text-model";
export * from "./pdf/pattern-matcher";
export * from "./pdf/match-geometry";
export * from "./pdf/highlight-layer";
export * from "./pdf/pdf-view-adapter";
export * from "./pdf/pdf-match-controller";
export * from "./utils/adaptive-highlight";

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

		this.registerDomEvent(document, "pointerdown", handleLeafInteraction, {
			capture: true,
		} as any);
		this.registerDomEvent(document, "mousedown", handleLeafInteraction, {
			capture: true,
		} as any);

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
		const activeLeaf =
			(this.app.workspace as any).activeLeaf ||
			(this.app.workspace as any).getMostRecentLeaf?.();
		const activeView = activeLeaf?.view;

		if (activeView && isPdfView(activeView)) {
			return { type: "pdf", view: activeView };
		}
		if (activeView?.editor) {
			return { type: "editor", editor: activeView.editor };
		}

		// 5. Fallback to activeLeaf on workspace
		const fallbackView = this.app.workspace.getActiveViewOfType(View as any);
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
						const len = input.value.length;
						input.setSelectionRange(len, len);
					}
				}
			} else {
				this.pdfController.advance(direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector<HTMLInputElement>(".incsearch-input");
					if (input) {
						setFocusGuard();
						input.focus();
						window.requestAnimationFrame(() => {
							if (getActiveWidget() && document.activeElement !== input) {
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
		if (!adapter) return;

		this.pdfController = new PdfMatchController(adapter, this.settings, direction, () => {
			if (this.pdfController) {
				updatePdfWidgetCounter(this.pdfController);
			}
		});

		const startingQuery = "";
		renderPdfWidget(this.pdfController, this, startingQuery, direction, () => {
			this.pdfController?.destroy();
			this.pdfController = null;
			this.activePdfView = null;
			removeWidget();
		});
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
				advance(view, direction);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector<HTMLInputElement>(".incsearch-input");
					if (input) {
						setFocusGuard();
						input.focus();
						window.requestAnimationFrame(() => {
							if (getActiveWidget() && document.activeElement !== input) {
								input.focus();
							}
						});
					}
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
				allMatchesDisplayMode: this.settings.allMatchesDisplayMode,
				isDemandPeekActive: false,
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
					this.settings.spaceAsWildcard,
					this.settings.matchOnlyVisibleLinks,
					undefined,
					false,
					this.settings.allMatchesDisplayMode
				);
			}
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
		await this.saveSettings();
	}

	async saveSettings() {
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
			.setName("Search exit behavior")
			.setDesc("Determines how Enter and Escape end an active incremental search session.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("emacs", "Emacs-style (Enter accepts, Escape cancels)")
					.addOption("obsidian", "Obsidian-style (Enter finds next, Escape accepts)")
					.setValue(this.plugin.settings.searchExitBehavior)
					.onChange(async (value) => {
						this.plugin.settings.searchExitBehavior = value as any;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Highlight all matches")
			.setDesc(
				"Controls when matches other than the current match are highlighted during incremental search."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("always", "Always")
					.addOption("on-demand", "On demand (Ctrl+Enter to toggle)")
					.addOption("off", "Off")
					.setValue(this.plugin.settings.allMatchesDisplayMode)
					.onChange(async (value) => {
						this.plugin.settings.allMatchesDisplayMode = value as AllMatchesDisplayMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Secondary match highlight style")
			.setDesc(
				"Visual styling strategy for non-current matches. 'Adaptive' automatically derives fill and edge colors from the active theme and current match."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("adaptive", "Adaptive (Theme-matched fill + edge)")
					.addOption("underline", "Dotted underline only")
					.addOption("tint", "Subtle background tint only")
					.addOption("theme", "Obsidian highlight default")
					.addOption("custom", "Custom colors")
					.setValue(this.plugin.settings.secondaryHighlightStyle)
					.onChange(async (value) => {
						this.plugin.settings.secondaryHighlightStyle = value as any;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Secondary match prominence")
			.setDesc(
				"Controls the visual strength and subordination level of secondary matches relative to the active match."
			)
			.addSlider((slider) =>
				slider
					.setLimits(20, 100, 5)
					.setValue(Math.round(this.plugin.settings.secondaryProminence * 100))
					.setDynamicTooltip()
					.onChange(async (val) => {
						this.plugin.settings.secondaryProminence = val / 100;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enforce text legibility (WCAG)")
			.setDesc(
				"Automatically fall back to a dotted underline if background tinting would compromise normal text contrast."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.secondaryEnforceLegibility)
					.onChange(async (value) => {
						this.plugin.settings.secondaryEnforceLegibility = value;
						await this.plugin.saveSettings();
					})
			);

		if (this.plugin.settings.secondaryHighlightStyle === "custom") {
			new Setting(containerEl)
				.setName("Custom color (Light theme)")
				.setDesc(
					"Custom CSS color (hex, rgb, or rgba) for secondary highlights in light mode."
				)
				.addText((text) =>
					text
						.setPlaceholder("#ffe066 or rgba(255, 224, 102, 0.5)")
						.setValue(this.plugin.settings.secondaryCustomLightColor)
						.onChange(async (val) => {
							this.plugin.settings.secondaryCustomLightColor = val;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Custom color (Dark theme)")
				.setDesc(
					"Custom CSS color (hex, rgb, or rgba) for secondary highlights in dark mode."
				)
				.addText((text) =>
					text
						.setPlaceholder("#705dcf or rgba(112, 93, 207, 0.5)")
						.setValue(this.plugin.settings.secondaryCustomDarkColor)
						.onChange(async (val) => {
							this.plugin.settings.secondaryCustomDarkColor = val;
							await this.plugin.saveSettings();
						})
				);
		}

		// Preview swatch
		const previewContainer = containerEl.createDiv({ cls: "incsearch-settings-preview" });
		const previewHeader = previewContainer.createDiv({
			cls: "incsearch-settings-preview-label",
		});
		previewHeader.setText("Highlighting Live Preview");
		const previewBody = previewContainer.createDiv();
		previewBody.createSpan({ text: "Example text demonstrating an " });
		previewBody.createSpan({ cls: "incsearch-match-exact is-current", text: "active match" });
		previewBody.createSpan({ text: " and a " });
		previewBody.createSpan({ cls: "incsearch-match-exact", text: "secondary match" });
		previewBody.createSpan({ text: " in the active theme." });

		new Setting(containerEl)
			.setName("Space-as-wildcard matching")
			.setDesc(
				"Match words separated by wildcard spaces instead of literal substring matches."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.spaceAsWildcard).onChange(async (value) => {
					this.plugin.settings.spaceAsWildcard = value;
					await this.plugin.saveSettings();
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
