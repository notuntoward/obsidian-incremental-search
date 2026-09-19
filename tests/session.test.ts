import { describe, it, expect, beforeEach, vi } from "vitest";
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
import { SearchSessionState, MatchRange } from "../src/types";

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

  it("excludes the active selection in forward search and jumps to next match", () => {
    const text = "cat ...   cat ...   cat";
    // Active selection on first "cat" from 0 to 3
    const view = createEditorView(text, 0, "forward");
    if (sessionState) {
      sessionState.originSelection = { anchor: 0, head: 3 };
    }
    recomputeQuery(view, "cat", "forward", true, true);

    expect(sessionState?.matches).toHaveLength(3);
    expect(sessionState?.activeIndex).toBe(1); // jumps to second "cat" at index 10
  });

  it("excludes reverse active selection in forward search and jumps to next match", () => {
    const text = "cat ...   cat ...   cat";
    // Reverse selection on first "cat" from anchor 3 to head 0
    const view = createEditorView(text, 0, "forward");
    if (sessionState) {
      sessionState.originSelection = { anchor: 3, head: 0 };
    }
    recomputeQuery(view, "cat", "forward", true, true);

    expect(sessionState?.matches).toHaveLength(3);
    expect(sessionState?.activeIndex).toBe(1); // jumps to second "cat" at index 10
  });

  it("excludes the active selection in backward search and jumps to previous match", () => {
    const text = "cat ...   cat ...   cat";
    // Active selection on third "cat" from 20 to 23
    const view = createEditorView(text, 23, "backward");
    if (sessionState) {
      sessionState.originSelection = { anchor: 20, head: 23 };
    }
    recomputeQuery(view, "cat", "backward", true, true);

    expect(sessionState?.matches).toHaveLength(3);
    expect(sessionState?.activeIndex).toBe(1); // jumps to second "cat" at index 10
  });

  it("excludes reverse active selection in backward search and jumps to previous match", () => {
    const text = "cat ...   cat ...   cat";
    // Reverse selection on third "cat" from anchor 23 to head 20
    const view = createEditorView(text, 20, "backward");
    if (sessionState) {
      sessionState.originSelection = { anchor: 23, head: 20 };
    }
    recomputeQuery(view, "cat", "backward", true, true);

    expect(sessionState?.matches).toHaveLength(3);
    expect(sessionState?.activeIndex).toBe(1); // jumps to second "cat" at index 10
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
    // Origin is not restored
    expect(lastDispatch.selection.anchor).toBe(15);
  });

  it("commitMatch with no matches closes session without throwing or restoring origin", () => {
    const view = createView({
      query: "nomatch",
      direction: "forward",
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: 2, head: 5 },
    });

    expect(() => commitMatch(view, mockPlugin)).not.toThrow();
    expect(currentSession).toBeNull();
    // Dispatch has no selection alteration
    expect(dispatches[0].selection).toBeUndefined();
  });

  it("cancelSession restores original selection range, saves query, and clears session", () => {
    const view = createView({
      query: "abandoned",
      direction: "forward",
      matches: [{ from: 10, to: 15 }],
      activeIndex: 0,
      originSelection: { anchor: 2, head: 8 },
    });

    cancelSession(view, mockPlugin);

    expect(mockPlugin.settings.lastQuery).toBe("abandoned");
    const lastDispatch = dispatches[0];
    expect(lastDispatch.selection.anchor).toBe(2);
    expect(lastDispatch.selection.head).toBe(8);
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
  it("builds decorations for wildcard matches with chars and full span when active, and only word marks when secondary", () => {
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
      ],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
      allMatchesDisplayMode: "always",
    };

    // When active, includes full span, words, and gap (4 decorations)
    const activeDecorations = buildHighlightDecorations(session, [{ from: 0, to: 100 }]);
    expect(activeDecorations.size).toBe(4);

    // When secondary (activeIndex is different), only includes the 2 word marks
    const secondarySession: SearchSessionState = {
      ...session,
      activeIndex: 1, // different match is active
    };
    const secondaryDecorations = buildHighlightDecorations(secondarySession, [{ from: 0, to: 100 }]);
    expect(secondaryDecorations.size).toBe(2);
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

  it("decorates all matches when allMatchesDisplayMode is 'always', only active when 'off' or 'on-demand' (without peek), and all matches when 'on-demand' with peek active", () => {
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
      allMatchesDisplayMode: "always",
    };

    // Mode "always" -> all 3 matches decorated
    const decoAlways = buildHighlightDecorations(session, [{ from: 0, to: 100 }]);
    expect(decoAlways.size).toBe(3);

    // Mode "off" -> only 1 active match decorated
    const decoOff = buildHighlightDecorations(
      { ...session, allMatchesDisplayMode: "off" },
      [{ from: 0, to: 100 }]
    );
    expect(decoOff.size).toBe(1);

    // Mode "on-demand" without peek -> only 1 active match decorated
    const decoOnDemandNormal = buildHighlightDecorations(
      { ...session, allMatchesDisplayMode: "on-demand", isDemandPeekActive: false },
      [{ from: 0, to: 100 }]
    );
    expect(decoOnDemandNormal.size).toBe(1);

    // Mode "on-demand" with peek active -> all 3 matches decorated
    const decoOnDemandPeeking = buildHighlightDecorations(
      { ...session, allMatchesDisplayMode: "on-demand", isDemandPeekActive: true },
      [{ from: 0, to: 100 }]
    );
    expect(decoOnDemandPeeking.size).toBe(3);
  });
});

describe("session: demand toggle highlights", () => {
  it("toggles isDemandPeekActive when in on-demand mode", async () => {
    const { toggleDemandHighlights, searchSessionField, setSession } = await import("../src/session");

    let currentSession: SearchSessionState | null = {
      query: "cat",
      direction: "forward",
      matches: [{ from: 0, to: 3 }, { from: 10, to: 13 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
      allMatchesDisplayMode: "on-demand",
      isDemandPeekActive: false,
    };

    const mockView = {
      dom: document.createElement("div"),
      state: {
        field: (f: any) => (f === searchSessionField ? currentSession : null),
        sliceDoc: () => "cat",
      },
      dispatch: (tr: any) => {
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff.is(setSession)) {
              currentSession = eff.value;
            }
          }
        }
      },
    } as any;

    expect(currentSession?.isDemandPeekActive).toBe(false);

    // Toggle on
    toggleDemandHighlights(mockView);
    expect(currentSession?.isDemandPeekActive).toBe(true);

    // Toggle off
    toggleDemandHighlights(mockView);
    expect(currentSession?.isDemandPeekActive).toBe(false);
  });

  it("does not toggle isDemandPeekActive when not in on-demand mode", async () => {
    const { toggleDemandHighlights, searchSessionField, setSession } = await import("../src/session");

    let currentSession: SearchSessionState | null = {
      query: "cat",
      direction: "forward",
      matches: [{ from: 0, to: 3 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
      allMatchesDisplayMode: "off",
      isDemandPeekActive: false,
    };

    const mockView = {
      dom: document.createElement("div"),
      state: {
        field: (f: any) => (f === searchSessionField ? currentSession : null),
      },
      dispatch: (tr: any) => {
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff.is(setSession)) {
              currentSession = eff.value;
            }
          }
        }
      },
    } as any;

    toggleDemandHighlights(mockView);
    expect(currentSession?.isDemandPeekActive).toBe(false);
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

  it("does not call view.focus() when closeSession is called with shouldFocus = false (e.g. on blur)", () => {
    let focused = false;
    const mockPlugin = {
      settings: { lastQuery: "" },
      saveSettings: async () => {},
    };

    const mockView = {
      dom: document.createElement("div"),
      state: {
        field: () => ({ query: "test", matches: [], activeIndex: 0, originSelection: { anchor: 0, head: 0 } }),
      },
      dispatch: () => {},
      focus: () => {
        focused = true;
      },
    } as any;

    closeSession(mockView, mockPlugin, false);
    expect(focused).toBe(false);

    closeSession(mockView, mockPlugin, true);
    expect(focused).toBe(true);
  });

  it("highlights all matches in tables, marking current with is-current and non-current without it", () => {
    const tableEl = document.createElement("table");
    const row = tableEl.insertRow();
    const cell1 = row.insertCell();
    cell1.textContent = "apple pie";
    const cell2 = row.insertCell();
    cell2.textContent = "apple juice";
    document.body.appendChild(tableEl);

    const matches: MatchRange[] = [
      {
        from: 10,
        to: 15,
        inTable: true,
        tableMatchData: {
          sectionStart: 0,
          cellText: "apple pie",
          matchStartInCell: 0,
          matchEndInCell: 5,
          rowIndex: 0,
          colIndex: 0,
        },
      },
      {
        from: 25,
        to: 30,
        inTable: true,
        tableMatchData: {
          sectionStart: 0,
          cellText: "apple juice",
          matchStartInCell: 0,
          matchEndInCell: 5,
          rowIndex: 0,
          colIndex: 1,
        },
      },
    ];

    const sessionState = {
      query: "apple",
      direction: "forward",
      matches,
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
      allMatchesDisplayMode: "always",
    };

    const mockView = {
      dom: document.body,
      state: {
        field: () => sessionState,
      },
      domAtPos: () => ({ node: tableEl, offset: 0 }),
      dispatch: () => {},
      focus: () => {},
    } as any;

    scrollToMatch(mockView, matches[0]);

    const spans = tableEl.querySelectorAll(".incsearch-table-cell-match");
    expect(spans.length).toBe(2);
    // Active match (index 0) has is-current
    expect(spans[0].classList.contains("is-current")).toBe(true);
    // Non-active match (index 1) does NOT have is-current
    expect(spans[1].classList.contains("is-current")).toBe(false);

    // Switch active match to index 1
    sessionState.activeIndex = 1;
    scrollToMatch(mockView, matches[1]);

    const updatedSpans = tableEl.querySelectorAll(".incsearch-table-cell-match");
    expect(updatedSpans.length).toBe(2);
    expect(updatedSpans[0].classList.contains("is-current")).toBe(false);
    expect(updatedSpans[1].classList.contains("is-current")).toBe(true);

    document.body.removeChild(tableEl);
  });

  it("buildHighlightDecorations deduplicates identical decoration ranges", () => {
    const session: SearchSessionState = {
      query: "i would",
      direction: "forward",
      matches: [
        {
          from: 0,
          to: 20,
          chars: [
            { from: 0, to: 1 },
            { from: 15, to: 20 },
          ],
        },
        {
          from: 5,
          to: 20,
          chars: [
            { from: 5, to: 6 },
            { from: 15, to: 20 },
          ],
        },
      ],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
      allMatchesDisplayMode: "always",
    };

    const deco = buildHighlightDecorations(session, [{ from: 0, to: 100 }]);
    expect(deco).toBeDefined();

    // Verify through iterator that { from: 15, to: 20 } mark only appears once, not duplicated
    let count15to20 = 0;
    const iter = deco.iter();
    while (iter.value !== null) {
      if (iter.from === 15 && iter.to === 20) {
        count15to20++;
      }
      iter.next();
    }
    expect(count15to20).toBe(1);
  });
});

describe("session: markdown smart search scrolling", () => {
  it("does not scroll when the next match is already fully in view", () => {
    const scrollBySpy = vi.fn();
    const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
    const scrollDOM = {
      getBoundingClientRect: () => containerRect,
      scrollBy: scrollBySpy,
      scrollLeft: 0,
      scrollTop: 0,
    };

    const state = EditorState.create({ doc: "first match text and second match text" });
    const view: any = {
      state,
      scrollDOM,
      dom: {
        querySelector: () => null,
      },
      coordsAtPos: () => ({
        top: 250,
        bottom: 270,
        left: 50,
        right: 150,
      }),
      dispatch: vi.fn(),
    };

    scrollToMatch(view, { from: 5, to: 15 });
    expect(scrollBySpy).not.toHaveBeenCalled();
  });

  it("scrolls and centers vertically when next match is off-screen vertically", () => {
    const scrollBySpy = vi.fn();
    const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
    const scrollDOM = {
      getBoundingClientRect: () => containerRect,
      scrollBy: scrollBySpy,
      scrollLeft: 0,
      scrollTop: 0,
    };

    const state = EditorState.create({ doc: "first line\nsecond line" });
    const view: any = {
      state,
      scrollDOM,
      dom: {
        querySelector: () => null,
      },
      // Target [590, 610], center 600. Container [100, 600], center 350. deltaY = 250
      coordsAtPos: () => ({
        top: 590,
        bottom: 610,
        left: 50,
        right: 150,
      }),
      dispatch: vi.fn(),
    };

    scrollToMatch(view, { from: 20, to: 30 });
    expect(scrollBySpy).toHaveBeenCalledWith({
      left: 0,
      top: 250,
      behavior: "smooth",
    });
  });

  it("scrolls and centers horizontally when note is zoomed and next match is off-screen horizontally", () => {
    const scrollBySpy = vi.fn();
    const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
    const scrollDOM = {
      getBoundingClientRect: () => containerRect,
      scrollBy: scrollBySpy,
      scrollLeft: 0,
      scrollTop: 0,
    };

    const state = EditorState.create({ doc: "very long line with zoomed text" });
    const view: any = {
      state,
      scrollDOM,
      dom: {
        querySelector: () => null,
      },
      // Target [780, 850], center 815. Container [0, 800], center 400. deltaX = 415. Vertical is on-screen (top 200, bottom 220).
      coordsAtPos: () => ({
        top: 200,
        bottom: 220,
        left: 780,
        right: 850,
      }),
      dispatch: vi.fn(),
    };

    scrollToMatch(view, { from: 50, to: 60 });
    expect(scrollBySpy).toHaveBeenCalledWith({
      left: 415,
      top: -140,
      behavior: "smooth",
    });
  });

  it("does not scroll when advancing to ANY match on different lines in markdown that is already on-screen", () => {
    const scrollBySpy = vi.fn();
    const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
    const scrollDOM = {
      getBoundingClientRect: () => containerRect,
      scrollBy: scrollBySpy,
      scrollLeft: 150,
      scrollTop: 100,
    };

    const state = EditorState.create({ doc: "line 1\nline 2\nline 3\nline 4\nline 5" });

    // Target match is on line 4, top: 380, bottom: 400 (fully within viewport [100, 600] and [0, 800])
    const view: any = {
      state,
      scrollDOM,
      dom: {
        querySelector: () => null,
      },
      coordsAtPos: () => ({
        top: 380,
        bottom: 400,
        left: 200,
        right: 280,
      }),
      dispatch: vi.fn(),
    };

    scrollToMatch(view, { from: 25, to: 30 });

    // Must not call scrollBy or change scroll positions
    expect(scrollBySpy).not.toHaveBeenCalled();
    expect(scrollDOM.scrollLeft).toBe(150);
    expect(scrollDOM.scrollTop).toBe(100);
  });

  it("does not mistake previous active match element in DOM for current match when advancing to off-screen match", () => {
    const scrollBySpy = vi.fn();
    const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
    const scrollDOM = {
      getBoundingClientRect: () => containerRect,
      scrollBy: scrollBySpy,
      scrollLeft: 0,
      scrollTop: 0,
    };

    const state = EditorState.create({ doc: "first match line\n" + "long text\n".repeat(50) + "offscreen match line" });

    // Simulated stale element in DOM from previous match (at top: 200, inside viewport)
    const staleEl = {
      getBoundingClientRect: () => ({ top: 200, bottom: 220, left: 50, right: 150, width: 100, height: 20 } as DOMRect),
    };

    // Target match is off-screen at top: 750, bottom: 770 (below viewport [100, 600])
    // Container center: 100 + 250 = 350. Target center: 750 + 10 = 760. DeltaY: 760 - 350 = 410.
    const view: any = {
      state,
      scrollDOM,
      dom: {
        querySelector: (selector: string) => (selector.includes("is-current") ? staleEl : null),
      },
      coordsAtPos: () => ({
        top: 750,
        bottom: 770,
        left: 200,
        right: 280,
      }),
      dispatch: vi.fn(),
    };

    scrollToMatch(view, { from: 400, to: 415 });

    // Must scroll to center the new match, NOT skip because of the stale on-screen element!
    expect(scrollBySpy).toHaveBeenCalledWith({
      left: 0,
      top: 410,
      behavior: "smooth",
    });
  });

  it("scrolls and centers when next match is in distant unrendered line via EditorView.scrollIntoView dispatch", () => {
    const dispatchSpy = vi.fn();
    const containerRect = { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500 };
    const scrollDOM = {
      getBoundingClientRect: () => containerRect,
      scrollBy: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
    };

    const state = EditorState.create({ doc: "short doc" });

    // Target match is unrendered (coordsAtPos returns null)
    const view: any = {
      state,
      scrollDOM,
      dom: {
        querySelector: () => null,
      },
      coordsAtPos: () => null,
      dispatch: dispatchSpy,
    };

    scrollToMatch(view, { from: 500, to: 510 });

    expect(dispatchSpy).toHaveBeenCalled();
  });
});
