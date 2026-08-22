import { Plugin, PluginSettingTab, App, Setting, Editor } from "obsidian";
import { EditorView } from "@codemirror/view";
import { SwiperSearchSettings, DEFAULT_SETTINGS, SearchDirection } from "./types";
import {
	searchSessionField,
	swiperHighlightPlugin,
	setSession,
	recomputeQuery,
	advance,
} from "./session";
import { renderWidget, updateWidgetCounter, removeAllWidgets, getActiveWidget } from "./widget";
import { SwiperSuggestModal } from "./modal";

export * from "./types";
export * from "./engine";
export * from "./session";
export * from "./widget";
export * from "./modal";

export default class SwiperSearchPlugin extends Plugin {
	settings: SwiperSearchSettings;

	async onload() {
		await this.loadSettings();

		this.registerEditorExtension([searchSessionField, swiperHighlightPlugin]);

		this.addCommand({
			id: "swiper-search-forward",
			name: "Swiper-style search (forward)",
			editorCallback: (editor: Editor) => this.invoke(editor, "forward"),
		});

		this.addCommand({
			id: "swiper-search-backward",
			name: "Swiper-style search (backward)",
			editorCallback: (editor: Editor) => this.invoke(editor, "backward"),
		});

		this.addSettingTab(new SwiperSearchSettingTab(this.app, this));
	}

	onunload() {
		removeAllWidgets();
	}

	private invoke(editor: Editor, direction: SearchDirection) {
		// @ts-expect-error CodeMirror view is attached to editor.cm in Obsidian runtime
		const view: EditorView | undefined = editor.cm;
		if (!view) return;

		const session = view.state.field(searchSessionField, false);
		if (session) {
			if (session.query === "" && this.settings.lastQuery) {
				recomputeQuery(view, this.settings.lastQuery, direction, this.settings.fuzzyMode);
				const widget = getActiveWidget();
				if (widget) {
					const input = widget.querySelector(".swiper-search-input") as HTMLInputElement;
					if (input) {
						input.value = this.settings.lastQuery;
						input.select();
					}
				}
			} else {
				advance(view, direction);
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
			}),
		});

		if (this.settings.usePopupModal) {
			const modal = new SwiperSuggestModal(this.app, this, view, direction);
			modal.open();
			if (startingQuery) {
				modal.inputEl.value = startingQuery;
				modal.inputEl.dispatchEvent(new Event("input"));
			}
		} else {
			if (startingQuery) {
				recomputeQuery(view, startingQuery, direction, this.settings.fuzzyMode);
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

class SwiperSearchSettingTab extends PluginSettingTab {
	plugin: SwiperSearchPlugin;

	constructor(app: App, plugin: SwiperSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Fuzzy matching")
			.setDesc(
				"Match characters out of order (like Ivy/swiper), instead of literal substring matches."
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
