import {
  Plugin,
  PluginSettingTab,
  App,
  Setting,
  MarkdownView,
  Editor,
  SuggestModal,
} from "obsidian";
import {
  EditorView,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
} from "@codemirror/view";
import {
  StateField,
  StateEffect,
  EditorState,
  EditorSelection,
} from "@codemirror/state";

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

interface SwiperSearchSettings {
  lastQuery: string;
  doubleTapWindowMs: number;
  fuzzyMode: boolean;
  usePopupModal: boolean;
}

const DEFAULT_SETTINGS: SwiperSearchSettings = {
  lastQuery: "",
  doubleTapWindowMs: 600,
  fuzzyMode: true,
  usePopupModal: false,
};

/* -------------------------------------------------------------------------
 * Session state
 * ---------------------------------------------------------------------- */

interface MatchRange {
  from: number;
  to: number;
  chars?: {from: number; to: number}[];
}

interface SearchSessionState {
  query: string;
  direction: "forward" | "backward";
  matches: MatchRange[];
  activeIndex: number;
  originSelection: { anchor: number; head: number };
}

const setSession = StateEffect.define<SearchSessionState | null>();

const searchSessionField = StateField.define<SearchSessionState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSession)) {
        return effect.value;
      }
    }
    return value;
  },
});

/* -------------------------------------------------------------------------
 * Matching engine
 * ---------------------------------------------------------------------- */

function isCaseSensitive(query: string): boolean {
  return /[A-Z]/.test(query);
}

function findFuzzyMatches(
  text: string,
  query: string,
  offset: number,
  caseSensitive: boolean
): MatchRange[] {
  if (query.length === 0) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  
  const tokens: string[] = [];
  const parts = query.split(/( +)/);
  let currentToken = "";
  for (const part of parts) {
    if (part.startsWith(' ')) {
      if (part.length === 1) {
        if (currentToken.length > 0) {
          tokens.push(caseSensitive ? currentToken : currentToken.toLowerCase());
          currentToken = "";
        }
      } else {
        currentToken += ' '.repeat(part.length - 1);
      }
    } else if (part.length > 0) {
      currentToken += part;
    }
  }
  if (currentToken.length > 0) {
    tokens.push(caseSensitive ? currentToken : currentToken.toLowerCase());
  }

  if (tokens.length === 0) return [];
  const results: MatchRange[] = [];

  let searchStart = 0;
  while (searchStart < haystack.length) {
    let currentStart = searchStart;
    const chars: {from: number, to: number}[] = [];
    let matchValid = true;
    let firstTokenIdx = -1;
    let lastTokenEnd = -1;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.length === 0) continue;
      
      const idx = haystack.indexOf(token, currentStart);
      if (idx === -1) {
        matchValid = false;
        break;
      }
      
      if (firstTokenIdx === -1) {
        firstTokenIdx = idx;
      }
      
      chars.push({ from: offset + idx, to: offset + idx + token.length });
      currentStart = idx + token.length;
      lastTokenEnd = currentStart;
    }

    if (matchValid && firstTokenIdx !== -1) {
      results.push({ 
        from: offset + firstTokenIdx, 
        to: offset + lastTokenEnd, 
        chars 
      });
      searchStart = firstTokenIdx + 1;
    } else {
      break;
    }
  }
  
  return results;
}

function findLiteralMatches(
  text: string,
  query: string,
  offset: number,
  caseSensitive: boolean
): MatchRange[] {
  const results: MatchRange[] = [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (needle.length === 0) return results;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    results.push({ from: offset + idx, to: offset + idx + needle.length });
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return results;
}

function computeMatches(
  state: EditorState,
  query: string,
  fuzzy: boolean
): MatchRange[] {
  if (!query) return [];
  const caseSensitive = isCaseSensitive(query);
  const results: MatchRange[] = [];
  
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (fuzzy) {
      results.push(...findFuzzyMatches(line.text, query, line.from, caseSensitive));
    } else {
      results.push(...findLiteralMatches(line.text, query, line.from, caseSensitive));
    }
  }
  return results;
}

/* -------------------------------------------------------------------------
 * Decoration ViewPlugin
 * ---------------------------------------------------------------------- */

const swiperHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      this.decorations = this.buildDecorations(update.view);
    }

    buildDecorations(view: EditorView): DecorationSet {
      const session = view.state.field(searchSessionField, false);
      if (!session || session.matches.length === 0) {
        return Decoration.none;
      }

      const marks: any[] = [];
      const positions: { from: number; to: number; mark: any }[] = [];

      for (const [i, m] of session.matches.entries()) {
        const inVisible = view.visibleRanges.some(
          (r) => m.from >= r.from && m.to <= r.to
        );
        if (!inVisible) continue;
        const cls =
          i === session.activeIndex ? "swiper-match-current" : "swiper-match";
        
        if (m.chars) {
          const spanCls = i === session.activeIndex ? "swiper-match-span-current" : "swiper-match-span";
          positions.push({
            from: m.from,
            to: m.to,
            mark: Decoration.mark({ class: spanCls }),
          });

          for (const c of m.chars) {
            positions.push({
              from: c.from,
              to: c.to,
              mark: Decoration.mark({ class: cls }),
            });
          }
        } else {
          positions.push({
            from: m.from,
            to: m.to,
            mark: Decoration.mark({ class: cls }),
          });
        }
      }

      positions.sort((a, b) => a.from - b.from);
      const builder = positions.map((p) => p.mark.range(p.from, p.to));
      return Decoration.set(builder, true);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/* -------------------------------------------------------------------------
 * Session control helpers
 * ---------------------------------------------------------------------- */

function advance(
  view: EditorView,
  dir: "forward" | "backward"
) {
  const session = view.state.field(searchSessionField, false);
  if (!session) return;

  const matches = session.matches;
  if (matches.length === 0) return;

  let nextIndex: number;
  if (dir === "forward") {
    nextIndex = session.activeIndex + 1;
    if (nextIndex >= matches.length) nextIndex = 0; // wrap-around
  } else {
    nextIndex = session.activeIndex - 1;
    if (nextIndex < 0) nextIndex = matches.length - 1; // wrap-around
  }

  view.dispatch({
    effects: setSession.of({
      ...session,
      direction: dir,
      activeIndex: nextIndex,
    }),
  });

  const m = matches[nextIndex];
  view.dispatch({
    effects: EditorView.scrollIntoView(EditorSelection.range(m.from, m.to), { y: "center", x: "nearest" }),
  });
}

function setActiveIndex(view: EditorView, index: number) {
  const session = view.state.field(searchSessionField, false);
  if (!session || index < 0 || index >= session.matches.length) return;
  view.dispatch({
    effects: setSession.of({
      ...session,
      activeIndex: index,
    }),
  });
  const m = session.matches[index];
  view.dispatch({
    effects: EditorView.scrollIntoView(EditorSelection.range(m.from, m.to), { y: "center", x: "nearest" }),
  });
}

function recomputeQuery(
  view: EditorView,
  query: string,
  direction: "forward" | "backward",
  fuzzy: boolean
) {
  const session = view.state.field(searchSessionField, false);
  if (!session) return;

  const allMatches = computeMatches(view.state, query, fuzzy);
  const cursorPos = session.originSelection.head;

  let activeIndex = 0;
  if (allMatches.length > 0) {
    if (direction === "forward") {
      const idx = allMatches.findIndex((m) => m.from >= cursorPos);
      activeIndex = idx === -1 ? 0 : idx;
    } else {
      let idx = -1;
      for (let i = allMatches.length - 1; i >= 0; i--) {
        if (allMatches[i].to <= cursorPos) {
          idx = i;
          break;
        }
      }
      activeIndex = idx === -1 ? allMatches.length - 1 : idx;
    }
  }

  view.dispatch({
    effects: setSession.of({
      ...session,
      query,
      matches: allMatches,
      activeIndex,
    }),
  });

  if (allMatches.length > 0) {
    const m = allMatches[activeIndex];
    view.dispatch({
      effects: EditorView.scrollIntoView(EditorSelection.range(m.from, m.to), {
        y: "center",
        x: "nearest"
      }),
    });
  }
}

function commitMatch(view: EditorView, plugin: SwiperSearchPlugin) {
  try {
    const session = view.state.field(searchSessionField, false);
    if (!session || session.matches.length === 0) {
      closeSession(view, plugin);
      view.focus();
      return;
    }
    const m = session.matches[session.activeIndex];
    if (session.query) {
      plugin.settings.lastQuery = session.query;
      plugin.saveSettings();
    }
    view.dispatch({
      selection: EditorSelection.cursor(m.to),
      effects: setSession.of(null),
    });
    removeWidget(view);
    view.focus();
  } catch (e) {
    console.error("Swiper Search: commitMatch error", e);
    removeWidget(view);
    view.focus();
  }
}

function cancelSession(view: EditorView, plugin: SwiperSearchPlugin) {
  try {
    const session = view.state.field(searchSessionField, false);
    if (session) {
      if (session.query) {
        plugin.settings.lastQuery = session.query;
        plugin.saveSettings();
      }
      view.dispatch({
        selection: EditorSelection.range(
          session.originSelection.anchor,
          session.originSelection.head
        ),
        effects: setSession.of(null),
      });
    }
    removeWidget(view);
    view.focus();
  } catch (e) {
    console.error("Swiper Search: cancelSession error", e);
    removeWidget(view);
    view.focus();
  }
}

function closeSession(view: EditorView, plugin: SwiperSearchPlugin) {
  const session = view.state.field(searchSessionField, false);
  if (session && session.query) {
    plugin.settings.lastQuery = session.query;
    plugin.saveSettings();
  }
  view.dispatch({ effects: setSession.of(null) });
  removeWidget(view);
  view.focus();
}

/* -------------------------------------------------------------------------
 * Widget UI (Optional)
 * ---------------------------------------------------------------------- */

let activeWidgetEl: HTMLDivElement | null = null;

export function updateWidgetCounter(view: EditorView) {
  if (!activeWidgetEl) return;
  const counter = activeWidgetEl.querySelector(".swiper-search-counter");
  const dirIndicator = activeWidgetEl.querySelector(".swiper-search-dir");
  const session = view.state.field(searchSessionField, false);
  if (!counter || !dirIndicator || !session) return;
  
  if (session.matches.length === 0) {
    counter.textContent = "0/0";
    dirIndicator.textContent = session.direction === "backward" ? "▲" : "▼";
    return;
  }
  counter.textContent = `${session.activeIndex + 1}/${session.matches.length}`;
  dirIndicator.textContent = session.direction === "backward" ? "▲" : "▼";
}

function removeWidget(view: EditorView) {
  if (activeWidgetEl) {
    activeWidgetEl.remove();
    activeWidgetEl = null;
  }
}

function renderWidget(
  view: EditorView,
  plugin: SwiperSearchPlugin,
  initialQuery: string,
  initialDirection: "forward" | "backward"
) {
  removeWidget(view);

  const container = view.dom.parentElement ?? view.dom;
  const el = document.createElement("div");
  el.className = "swiper-search-widget";
  el.style.cssText = `
    position: absolute; top: 8px; right: 8px; z-index: 50;
    background: var(--background-primary); border: 1px solid var(--background-modifier-border);
    border-radius: 6px; padding: 4px 8px; display: flex; gap: 8px; align-items: center;
    font-size: 13px; box-shadow: var(--shadow-s);
  `;

  const dirIndicator = document.createElement("span");
  dirIndicator.className = "swiper-search-dir";
  dirIndicator.textContent = initialDirection === "forward" ? "▼" : "▲";

  const input = document.createElement("input");
  input.className = "swiper-search-input";
  input.type = "text";
  input.value = initialQuery;
  input.style.cssText = "border: none; outline: none; background: transparent; width: 220px;";

  const counter = document.createElement("span");
  counter.className = "swiper-search-counter";
  counter.style.cssText = "color: var(--text-muted); min-width: 48px; text-align: right;";

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
      plugin.settings.fuzzyMode
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
    } else if (evt.ctrlKey && evt.key.toLowerCase() === "s") {
      evt.preventDefault();
      advance(view, "forward");
      updateCounter();
    } else if (evt.ctrlKey && evt.key.toLowerCase() === "r") {
      evt.preventDefault();
      advance(view, "backward");
      updateCounter();
    }
  });

  input.focus();
  input.select();
  updateCounter();
}

/* -------------------------------------------------------------------------
 * Popup Modal UI (Optional)
 * ---------------------------------------------------------------------- */

class SwiperSuggestModal extends SuggestModal<number> {
  plugin: SwiperSearchPlugin;
  cm: EditorView;
  direction: "forward" | "backward";
  observer: MutationObserver | null = null;
  chosen: boolean = false;

  constructor(app: App, plugin: SwiperSearchPlugin, cm: EditorView, direction: "forward" | "backward") {
    super(app);
    this.plugin = plugin;
    this.cm = cm;
    this.direction = direction;
    this.setPlaceholder("Swiper search...");
  }

  getSuggestions(query: string): number[] {
    recomputeQuery(this.cm, query, this.direction, this.plugin.settings.fuzzyMode);
    const session = this.cm.state.field(searchSessionField, false);
    if (!session || session.matches.length === 0) return [];
    
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
    lineSpan.style.color = "var(--text-muted)";
    lineSpan.style.marginRight = "8px";

    const textSpan = el.createSpan();
    
    if (m.chars) {
      let last = 0;
      for (const c of m.chars) {
        const localCharStart = c.from - line.from;
        const localCharEnd = c.to - line.from;
        textSpan.appendChild(document.createTextNode(line.text.substring(last, localCharStart)));
        const hl = textSpan.createSpan();
        hl.textContent = line.text.substring(localCharStart, localCharEnd);
        hl.style.backgroundColor = "var(--text-highlight-bg, rgba(255,255,0,0.35))";
        hl.style.color = "var(--text-normal)";
        last = localCharEnd;
      }
      textSpan.appendChild(document.createTextNode(line.text.substring(last)));
    } else {
      const localStart = m.from - line.from;
      const localEnd = m.to - line.from;
      
      if (localStart >= 0 && localEnd <= line.length) {
          textSpan.appendChild(document.createTextNode(line.text.substring(0, localStart)));
          const hl = textSpan.createSpan();
          hl.textContent = line.text.substring(localStart, localEnd);
          hl.style.backgroundColor = "var(--text-highlight-bg, rgba(255,255,0,0.35))";
          hl.style.color = "var(--text-normal)";
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

  onChooseSuggestion(index: number, evt: MouseEvent | KeyboardEvent) {
    this.chosen = true;
    const session = this.cm.state.field(searchSessionField, false);
    if (session) {
        this.plugin.settings.lastQuery = session.query;
        this.plugin.saveSettings();
    }
    setActiveIndex(this.cm, index);
    commitMatch(this.cm, this.plugin);
  }
}

/* -------------------------------------------------------------------------
 * Plugin entry point
 * ---------------------------------------------------------------------- */

const HIGHLIGHT_CSS = `
.swiper-match { background-color: var(--text-highlight-bg, rgba(255,255,0,0.35)); border-radius: 2px; }
.swiper-match-current { background-color: var(--text-selection, rgba(255,140,0,0.6)); outline: 1px solid orange; border-radius: 2px; }
.swiper-match-span { background-color: var(--background-modifier-hover, rgba(128,128,128,0.15)); border-radius: 2px; }
.swiper-match-span-current { background-color: rgba(255,140,0,0.15); border-radius: 2px; }
`;

export default class SwiperSearchPlugin extends Plugin {
  settings: SwiperSearchSettings;
  private lastInvokeTs = 0;

  async onload() {
    await this.loadSettings();
    this.injectStyles();

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
    document.getElementById("swiper-search-style")?.remove();
    // Remove any stranded widgets from the DOM if the plugin unloads (e.g. hot reload)
    document.querySelectorAll(".swiper-search-widget").forEach(w => w.remove());
    if (activeWidgetEl) {
      activeWidgetEl = null;
    }
  }

  private invoke(editor: Editor, direction: "forward" | "backward") {
    // @ts-expect-error
    const view: EditorView | undefined = editor.cm;
    if (!view) return;

    const session = view.state.field(searchSessionField, false);
    if (session) {
      if (session.query === "" && this.settings.lastQuery) {
        recomputeQuery(
          view,
          this.settings.lastQuery,
          direction,
          this.settings.fuzzyMode
        );
        if (activeWidgetEl) {
          const input = activeWidgetEl.querySelector(".swiper-search-input") as HTMLInputElement;
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
          modal.inputEl.dispatchEvent(new Event('input'));
      }
    } else {
      if (startingQuery) {
        recomputeQuery(view, startingQuery, direction, this.settings.fuzzyMode);
      }
      renderWidget(view, this, startingQuery, direction);
    }
  }

  private injectStyles() {
    if (document.getElementById("swiper-search-style")) return;
    const styleEl = document.createElement("style");
    styleEl.id = "swiper-search-style";
    styleEl.textContent = HIGHLIGHT_CSS;
    document.head.appendChild(styleEl);
  }


  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/* -------------------------------------------------------------------------
 * Settings tab
 * ---------------------------------------------------------------------- */

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
      .setDesc("Match characters out of order (like Ivy/swiper), instead of literal substring matches.")
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
