import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { unfoldEffect, foldEffect } from "@codemirror/language";
import {
  advance,
  setActiveIndex,
  recomputeQuery,
  commitMatch,
  cancelSession,
  closeSession,
  saveSessionQuery,
  searchSessionField,
  setSession,
  searchHighlightPlugin,
  buildHighlightDecorations,
  scrollToMatch,
} from "../src/session";
import { SearchSessionState } from "../src/types";

describe("session: advance & setActiveIndex", () => {
  let sessionState: SearchSessionState | null = null;

  const createMockView = (session: SearchSessionState | null) => {
    sessionState = session;
    return {
      state: {
        field: () => sessionState,
      },
      dispatch: (tr: any) => {
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff?.is?.(setSession)) {
              sessionState = eff.value;
            }
          }
        }
      },
    } as any;
  };

  it("advances forward and wraps around", () => {
    const view = createMockView({
      query: "test",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }, { from: 20, to: 24 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    });

    advance(view, "forward");
    expect(sessionState?.activeIndex).toBe(1);

    advance(view, "forward");
    expect(sessionState?.activeIndex).toBe(2);

    advance(view, "forward");
    expect(sessionState?.activeIndex).toBe(0); // wrapped around
  });

  it("advances backward and wraps around", () => {
    const view = createMockView({
      query: "test",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }, { from: 20, to: 24 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    });

    advance(view, "backward");
    expect(sessionState?.activeIndex).toBe(2); // wrapped to last
    expect(sessionState?.direction).toBe("backward");

    advance(view, "backward");
    expect(sessionState?.activeIndex).toBe(1);
  });

  it("sets active index when in valid range", () => {
    const view = createMockView({
      query: "test",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    });

    setActiveIndex(view, 1);
    expect(sessionState?.activeIndex).toBe(1);

    // Out of range should be ignored
    setActiveIndex(view, 5);
    expect(sessionState?.activeIndex).toBe(1);
    setActiveIndex(view, -1);
    expect(sessionState?.activeIndex).toBe(1);
  });
});

describe("session: recomputeQuery directional cursor placement", () => {
  let sessionState: SearchSessionState | null = null;

  const createEditorView = (docText: string, cursorPos: number, initialDir: "forward" | "backward") => {
    sessionState = {
      query: "",
      direction: initialDir,
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: cursorPos, head: cursorPos },
    };

    const state = EditorState.create({
      doc: docText,
      extensions: [
        searchSessionField.init(() => sessionState),
      ],
    });

    return {
      state: {
        ...state,
        field: () => sessionState,
      },
      dispatch: (tr: any) => {
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff?.is?.(setSession)) {
              sessionState = eff.value;
            }
          }
        }
      },
    } as any;
  };

  it("picks the first match at or after cursor for forward direction", () => {
    // text has matches at 0..3 ("cat"), 10..13 ("cat"), 20..23 ("cat")
    const text = "cat ...   cat ...   cat";
    // Cursor at index 6 -> next match is at index 10 (index 1)
    const view = createEditorView(text, 6, "forward");
    recomputeQuery(view, "cat", "forward", true, true);

    expect(sessionState?.matches).toHaveLength(3);
    expect(sessionState?.activeIndex).toBe(1);
  });

  it("wraps forward to index 0 if cursor is past all matches", () => {
    const text = "cat ...   cat";
    const view = createEditorView(text, 50, "forward");
    recomputeQuery(view, "cat", "forward", true, true);

    expect(sessionState?.activeIndex).toBe(0);
  });

  it("picks the last match at or before cursor for backward direction", () => {
    const text = "cat ...   cat ...   cat";
    // Cursor at index 15 -> previous match is at index 10 (index 1)
    const view = createEditorView(text, 15, "backward");
    recomputeQuery(view, "cat", "backward", true, true);

    expect(sessionState?.matches).toHaveLength(3);
    expect(sessionState?.activeIndex).toBe(1);
  });

  it("wraps backward to the last match if cursor is before all matches", () => {
    const text = "   cat ...   cat";
    const view = createEditorView(text, 0, "backward");
    recomputeQuery(view, "cat", "backward", true, true);

    expect(sessionState?.matches).toHaveLength(2);
    expect(sessionState?.activeIndex).toBe(1);
  });
});

describe("session: termination & query persistence", () => {
  let dispatches: any[] = [];
  let currentSession: SearchSessionState | null = null;

  const mockPlugin = {
    settings: { lastQuery: "" },
    saveSettings: async () => {},
  };

  const createView = (session: SearchSessionState | null) => {
    currentSession = session;
    dispatches = [];
    return {
      state: {
        field: () => currentSession,
      },
      dispatch: (tr: any) => {
        dispatches.push(tr);
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff?.is?.(setSession)) {
              currentSession = eff.value;
            }
          }
        }
      },
      focus: () => {},
    } as any;
  };

  beforeEach(() => {
    mockPlugin.settings.lastQuery = "";
  });

  it("saveSessionQuery saves query when non-empty", () => {
    saveSessionQuery({ query: "find me" } as any, mockPlugin);
    expect(mockPlugin.settings.lastQuery).toBe("find me");

    saveSessionQuery({ query: "" } as any, mockPlugin);
    expect(mockPlugin.settings.lastQuery).toBe("find me"); // unchanged
  });

  it("commitMatch moves cursor to match end, saves query, and clears session", () => {
    const view = createView({
      query: "found",
      direction: "forward",
      matches: [{ from: 10, to: 15 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    });

    commitMatch(view, mockPlugin);

    expect(mockPlugin.settings.lastQuery).toBe("found");
    expect(dispatches.length).toBeGreaterThan(0);
    const lastDispatch = dispatches[0];
    expect(lastDispatch.selection.head).toBe(15);
  });

  it("cancelSession restores original cursor, saves query, and clears session", () => {
    const view = createView({
      query: "abandoned",
      direction: "forward",
      matches: [{ from: 10, to: 15 }],
      activeIndex: 0,
      originSelection: { anchor: 2, head: 5 },
    });

    cancelSession(view, mockPlugin);

    expect(mockPlugin.settings.lastQuery).toBe("abandoned");
    const lastDispatch = dispatches[0];
    expect(lastDispatch.selection.anchor).toBe(2);
    expect(lastDispatch.selection.head).toBe(5);
  });

  it("closeSession clears session without modifying selection", () => {
    const view = createView({
      query: "blur query",
      direction: "forward",
      matches: [{ from: 10, to: 15 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    });

    closeSession(view, mockPlugin);

    expect(mockPlugin.settings.lastQuery).toBe("blur query");
    const lastDispatch = dispatches[0];
    expect(lastDispatch.selection).toBeUndefined();
  });
});

describe("session: searchHighlightPlugin decorations", () => {
  it("builds decorations for fuzzy matches with chars and full span", () => {
    const session: SearchSessionState = {
      query: "the KAN",
      direction: "forward",
      matches: [
        {
          from: 10,
          to: 25,
          chars: [
            { from: 10, to: 13 },
            { from: 22, to: 25 },
          ],
        },
        {
          from: 30,
          to: 37,
        },
      ],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    const decorations = buildHighlightDecorations(session, [{ from: 0, to: 100 }]);
    expect(decorations.size).toBeGreaterThan(0);
  });

  it("returns Decoration.none when session is null or has no matches", () => {
    const decorationsNull = buildHighlightDecorations(null, [{ from: 0, to: 100 }]);
    expect(decorationsNull.size).toBe(0);

    const decorationsEmpty = buildHighlightDecorations({
      query: "",
      direction: "forward",
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    }, [{ from: 0, to: 100 }]);
    expect(decorationsEmpty.size).toBe(0);
  });

  it("decorates all matches when highlightAllMatches is true, and only active match when false", () => {
    const session: SearchSessionState = {
      query: "cat",
      direction: "forward",
      matches: [
        { from: 10, to: 13 },
        { from: 30, to: 33 },
        { from: 50, to: 53 },
      ],
      activeIndex: 1,
      originSelection: { anchor: 0, head: 0 },
      highlightAllMatches: true,
    };

    const decoAll = buildHighlightDecorations(session, [{ from: 0, to: 100 }]);
    expect(decoAll.size).toBe(3);

    const decoActiveOnly = buildHighlightDecorations(
      { ...session, highlightAllMatches: false },
      [{ from: 0, to: 100 }]
    );
    expect(decoActiveOnly.size).toBe(1);
  });
});

describe("session: callout and fold auto-expansion and restoration", () => {
  it("expands a collapsed callout when a match is inside, highlights the match, and re-collapses when match moves outside", () => {
    const docText = "> [!note]- Title\n> Inner callout text\nNormal text line outside callout";
    const state = EditorState.create({ doc: docText });
    const calloutEl = document.createElement("div");
    calloutEl.className = "callout is-collapsed";
    const content = document.createElement("div");
    content.className = "callout-content";
    content.textContent = "Inner callout text";
    calloutEl.appendChild(content);
    document.body.appendChild(calloutEl);

    const mockView = {
      dom: document.body,
      state: state,
      domAtPos: (pos: number) => {
        if (pos <= 36) {
          return { node: content, offset: 0 };
        }
        return { node: document.body, offset: 0 };
      },
      dispatch: () => {},
    } as any;

    // Match 1 inside callout: "Inner" (offset 19..24)
    const match1From = docText.indexOf("Inner");
    const match1To = match1From + "Inner".length;
    scrollToMatch(mockView, { from: match1From, to: match1To });
    expect(calloutEl.classList.contains("is-collapsed")).toBe(false);
    expect(calloutEl.querySelector(".incsearch-callout-match")).not.toBeNull();
    expect(calloutEl.querySelector(".incsearch-callout-match")?.textContent).toBe("Inner");

    // Match 2 outside callout: "Normal"
    const match2From = docText.indexOf("Normal");
    const match2To = match2From + "Normal".length;
    scrollToMatch(mockView, { from: match2From, to: match2To });
    expect(calloutEl.classList.contains("is-collapsed")).toBe(true);
    expect(calloutEl.querySelector(".incsearch-callout-match")).toBeNull();

    document.body.removeChild(calloutEl);
  });

  it("restores collapsed callout when session is cancelled", () => {
    const docText = "> [!note]- Title\n> Inner text\nOutside line";
    const state = EditorState.create({ doc: docText });
    const calloutEl = document.createElement("div");
    calloutEl.className = "callout is-collapsed";
    const content = document.createElement("div");
    content.className = "callout-content";
    content.textContent = "Inner text";
    calloutEl.appendChild(content);
    document.body.appendChild(calloutEl);

    const matchFrom = docText.indexOf("Inner");
    const matchTo = matchFrom + "Inner".length;

    let sessionState: SearchSessionState | null = {
      query: "Inner",
      direction: "forward",
      matches: [{ from: matchFrom, to: matchTo }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    const mockPlugin = {
      settings: { lastQuery: "" },
      saveSettings: async () => {},
    };

    const mockView = {
      dom: document.body,
      state: {
        ...state,
        field: () => sessionState,
      },
      domAtPos: () => ({ node: content, offset: 0 }),
      dispatch: (tr: any) => {
        if (tr.effects) {
          sessionState = null;
        }
      },
      focus: () => {},
    } as any;

    // Navigate to match in callout -> expands and highlights
    scrollToMatch(mockView, { from: matchFrom, to: matchTo });
    expect(calloutEl.classList.contains("is-collapsed")).toBe(false);
    expect(calloutEl.querySelector(".incsearch-callout-match")?.textContent).toBe("Inner");

    // Cancel session -> re-collapses and clears highlights
    cancelSession(mockView, mockPlugin);
    expect(calloutEl.classList.contains("is-collapsed")).toBe(true);
    expect(calloutEl.querySelector(".incsearch-callout-match")).toBeNull();

    document.body.removeChild(calloutEl);
  });

  it("keeps callout expanded when match is committed with Enter", () => {
    const docText = "> [!note]- Title\n> Inner text\nOutside line";
    const state = EditorState.create({ doc: docText });
    const calloutEl = document.createElement("div");
    calloutEl.className = "callout is-collapsed";
    const content = document.createElement("div");
    content.className = "callout-content";
    content.textContent = "Inner text";
    calloutEl.appendChild(content);
    document.body.appendChild(calloutEl);

    const matchFrom = docText.indexOf("Inner");
    const matchTo = matchFrom + "Inner".length;

    let sessionState: SearchSessionState | null = {
      query: "Inner",
      direction: "forward",
      matches: [{ from: matchFrom, to: matchTo }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    const mockPlugin = {
      settings: { lastQuery: "" },
      saveSettings: async () => {},
    };

    const mockView = {
      dom: document.body,
      state: {
        ...state,
        field: () => sessionState,
      },
      domAtPos: () => ({ node: content, offset: 0 }),
      dispatch: () => {},
      focus: () => {},
    } as any;

    // Navigate to match -> expands
    scrollToMatch(mockView, { from: matchFrom, to: matchTo });
    expect(calloutEl.classList.contains("is-collapsed")).toBe(false);

    // Commit match -> remains expanded so user can read/edit it
    commitMatch(mockView, mockPlugin);
    expect(calloutEl.classList.contains("is-collapsed")).toBe(false);

    document.body.removeChild(calloutEl);
  });

  it("auto-unfolds CM6 folded ranges on match and re-folds when match leaves", () => {
    let unfolded = false;
    let refolded = false;

    const foldDeco = {
      between: (from: number, to: number, f: (from: number, to: number) => void) => {
        if (from <= 40 && to >= 10) {
          f(10, 40);
        }
      },
    };

    const mockView = {
      dom: document.createElement("div"),
      state: {
        field: () => foldDeco,
      },
      domAtPos: () => ({ node: document.createElement("div"), offset: 0 }),
      dispatch: (tr: any) => {
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff.is(unfoldEffect) && eff.value.from === 10 && eff.value.to === 40) {
              unfolded = true;
            }
            if (eff.is(foldEffect) && eff.value.from === 10 && eff.value.to === 40) {
              refolded = true;
            }
          }
        }
      },
    } as any;

    // First match inside fold range [10, 40]
    scrollToMatch(mockView, { from: 20, to: 25 });
    expect(unfolded).toBe(true);

    // Navigate away outside fold range
    scrollToMatch(mockView, { from: 80, to: 85 });
    expect(refolded).toBe(true);
  });
});
