import { App, SuggestModal, Editor } from "obsidian";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { SearchDirection, IncrementalSearchSettings, MatchRange } from "./types";
import {
	searchSessionField,
	recomputeQuery,
	setActiveIndex,
	saveSessionQuery,
	setSession,
} from "./session";

export class IncrementalSearchSuggestModal extends SuggestModal<number> {
	plugin: { settings: IncrementalSearchSettings; saveSettings: () => Promise<void> };
	editor: Editor | null;
	cm: EditorView;
	direction: SearchDirection;
	observer: MutationObserver | null = null;
	chosen: boolean = false;
	selectedMatch: MatchRange | null = null;

	constructor(
		app: App,
		plugin: { settings: IncrementalSearchSettings; saveSettings: () => Promise<void> },
		editor: Editor | null,
		cm: EditorView,
		direction: SearchDirection
	) {
		super(app);
		this.plugin = plugin;
		this.editor = editor;
		this.cm = cm;
		this.direction = direction;
		this.setPlaceholder("Search...");
	}

	getSuggestions(query: string): number[] {
		recomputeQuery(this.cm, query, this.direction, this.plugin.settings.fuzzyMode);
		const session = this.cm.state.field(searchSessionField, false);
		if (!session || !session.matches || session.matches.length === 0) return [];

		return session.matches.map((_, i) => i);
	}

	renderSuggestion(index: number, el: HTMLElement) {
		const session = this.cm.state.field(searchSessionField, false);
		if (!session) return;
		const m = session.matches[index];
		const doc = this.cm.state.doc;
		const line = doc.lineAt(m.from);

		el.setAttribute("data-index", index.toString());

		const lineSpan = el.createSpan({ cls: "incsearch-line-number" });
		lineSpan.textContent = `${line.number}: `;

		const textSpan = el.createSpan();

		if (m.chars && m.chars.length > 0) {
			let last = 0;
			for (const c of m.chars) {
				const localCharStart = c.from - line.from;
				const localCharEnd = c.to - line.from;
				textSpan.appendChild(
					document.createTextNode(line.text.substring(last, localCharStart))
				);
				const hl = textSpan.createSpan({ cls: "incsearch-match" });
				hl.textContent = line.text.substring(localCharStart, localCharEnd);
				last = localCharEnd;
			}
			textSpan.appendChild(document.createTextNode(line.text.substring(last)));
		} else {
			const localStart = m.from - line.from;
			const localEnd = m.to - line.from;

			if (localStart >= 0 && localEnd <= line.length) {
				textSpan.appendChild(document.createTextNode(line.text.substring(0, localStart)));
				const hl = textSpan.createSpan({ cls: "incsearch-match" });
				hl.textContent = line.text.substring(localStart, localEnd);
				textSpan.appendChild(document.createTextNode(line.text.substring(localEnd)));
			} else {
				textSpan.textContent = line.text;
			}
		}

		el.appendChild(textSpan);
	}

	onOpen() {
		super.onOpen();
		this.observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === "attributes" && mutation.attributeName === "class") {
					const target = mutation.target as HTMLElement;
					if (target.classList.contains("is-selected")) {
						const indexAttr = target.getAttribute("data-index");
						if (indexAttr) {
							const index = parseInt(indexAttr, 10);
							setActiveIndex(this.cm, index);
						}
					}
				}
			}
		});
		this.observer.observe(this.resultContainerEl, {
			attributes: true,
			subtree: true,
			attributeFilter: ["class"],
		});
	}

	onClose() {
		super.onClose();
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}

		if (!this.chosen) {
			const session = this.cm.state.field(searchSessionField, false);
			if (session) {
				saveSessionQuery(session, this.plugin);
				const originHead = session.originSelection.head;
				const originAnchor = session.originSelection.anchor;

				const restoreOrigin = () => {
					this.cm.dispatch({
						selection: EditorSelection.range(originAnchor, originHead),
						effects: [
							setSession.of(null),
							EditorView.scrollIntoView(
								EditorSelection.range(originAnchor, originHead),
								{ y: "center", x: "nearest" }
							),
						],
					});

					if (this.editor) {
						const anchorPos = this.editor.offsetToPos(originAnchor);
						const headPos = this.editor.offsetToPos(originHead);
						if (originAnchor === originHead) {
							this.editor.setCursor(headPos);
						} else {
							this.editor.setSelection(anchorPos, headPos);
						}
						this.editor.scrollIntoView({ from: anchorPos, to: headPos }, true);
						this.editor.focus();
					} else {
						this.cm.focus();
					}
				};

				restoreOrigin();
			} else {
				this.cm.dispatch({ effects: setSession.of(null) });
			}
		}
	}

	onChooseSuggestion(index: number, _evt: MouseEvent | KeyboardEvent) {
		this.chosen = true;
		const session = this.cm.state.field(searchSessionField, false);
		if (session && session.matches[index]) {
			const match = session.matches[index];
			this.selectedMatch = match;
			saveSessionQuery(session, this.plugin);

			const applyMatch = () => {
				if (this.editor) {
					const pos = this.editor.offsetToPos(match.to);
					const fromPos = this.editor.offsetToPos(match.from);

					console.log(
						`[incsearch] applyMatch - Match bounds: from=${match.from}, to=${match.to}`
					);
					console.log(
						`[incsearch] applyMatch - Calculated pos: line=${pos.line}, ch=${pos.ch}`
					);
					console.log(
						`[incsearch] applyMatch - Editor cursor BEFORE setCursor: line=${this.editor.getCursor().line}, ch=${this.editor.getCursor().ch}`
					);

					this.editor.setCursor(pos);
					this.editor.scrollIntoView({ from: fromPos, to: pos }, true);

					console.log(
						`[incsearch] applyMatch - Editor cursor AFTER setCursor: line=${this.editor.getCursor().line}, ch=${this.editor.getCursor().ch}`
					);

					// Also log CM6 state
					console.log(
						`[incsearch] applyMatch - CM6 state BEFORE dispatch: anchor=${this.cm.state.selection.main.anchor}, head=${this.cm.state.selection.main.head}`
					);
				}

				this.cm.dispatch({
					selection: EditorSelection.cursor(match.to),
					effects: [
						setSession.of(null),
						EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), {
							y: "center",
							x: "nearest",
						}),
					],
				});

				if (this.editor) {
					console.log(
						`[incsearch] applyMatch - Editor cursor AFTER CM6 dispatch: line=${this.editor.getCursor().line}, ch=${this.editor.getCursor().ch}`
					);
					console.log(
						`[incsearch] applyMatch - CM6 state AFTER dispatch: anchor=${this.cm.state.selection.main.anchor}, head=${this.cm.state.selection.main.head}`
					);
					this.editor.focus();
				} else {
					this.cm.focus();
				}
			};

			applyMatch();

			// Diagnostics: trace cursor after a short delay to see if Obsidian clobbered it
			window.setTimeout(() => {
				if (this.editor) {
					console.log(
						`[incsearch] applyMatch (50ms delay) - Editor cursor: line=${this.editor.getCursor().line}, ch=${this.editor.getCursor().ch}`
					);
				}
			}, 50);
		}
	}
}
