import { App, SuggestModal } from "obsidian";
import { EditorView } from "@codemirror/view";
import { SearchDirection, SwiperSearchSettings } from "./types";
import {
	searchSessionField,
	recomputeQuery,
	setActiveIndex,
	commitMatch,
	cancelSession,
	saveSessionQuery,
} from "./session";

export class SwiperSuggestModal extends SuggestModal<number> {
	plugin: { settings: SwiperSearchSettings; saveSettings: () => Promise<void> };
	cm: EditorView;
	direction: SearchDirection;
	observer: MutationObserver | null = null;
	chosen: boolean = false;

	constructor(
		app: App,
		plugin: { settings: SwiperSearchSettings; saveSettings: () => Promise<void> },
		cm: EditorView,
		direction: SearchDirection
	) {
		super(app);
		this.plugin = plugin;
		this.cm = cm;
		this.direction = direction;
		this.setPlaceholder("Swiper search...");
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

		const lineSpan = el.createSpan({ cls: "swiper-line-number" });
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
				const hl = textSpan.createSpan({ cls: "swiper-match" });
				hl.textContent = line.text.substring(localCharStart, localCharEnd);
				last = localCharEnd;
			}
			textSpan.appendChild(document.createTextNode(line.text.substring(last)));
		} else {
			const localStart = m.from - line.from;
			const localEnd = m.to - line.from;

			if (localStart >= 0 && localEnd <= line.length) {
				textSpan.appendChild(document.createTextNode(line.text.substring(0, localStart)));
				const hl = textSpan.createSpan({ cls: "swiper-match" });
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
			cancelSession(this.cm, this.plugin);
		}
	}

	onChooseSuggestion(index: number, _evt: MouseEvent | KeyboardEvent) {
		this.chosen = true;
		const session = this.cm.state.field(searchSessionField, false);
		saveSessionQuery(session, this.plugin);
		setActiveIndex(this.cm, index);
		commitMatch(this.cm, this.plugin);
	}
}
