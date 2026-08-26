import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { IncrementalSearchSuggestModal } from "../src/modal";
import { searchSessionField, setActiveIndex } from "../src/session";
import { SearchSessionState } from "../src/types";

describe("modal: IncrementalSearchSuggestModal", () => {
  let sessionState: SearchSessionState | null = null;
  let mockApp: any;
  let mockPlugin: any;
  let mockEditor: any;
  let mockView: any;
  let dispatches: any[] = [];
  let editorCursor: any = null;
  let scrollCalls: any[] = [];
  let focusCalls: number = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatches = [];
    scrollCalls = [];
    focusCalls = 0;
    editorCursor = null;
    sessionState = {
      query: "",
      direction: "forward",
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: 2, head: 2 },
    };

    mockApp = {
      workspace: {
        activeLeaf: {
          view: {
            setEphemeralState: () => {},
          },
        },
        getActiveFile: () => null,
      },
      metadataCache: {
        getFileCache: () => null,
      },
    };
    mockPlugin = {
      settings: { spaceAsWildcard: true, lastQuery: "", usePopupModal: true, doubleTapWindowMs: 600 },
      saveSettings: async () => {},
    };

    mockEditor = {
      offsetToPos: (offset: number) => ({ line: offset > 21 ? 1 : 0, ch: offset > 21 ? offset - 22 : offset }),
      setCursor: (pos: any) => {
        editorCursor = pos;
      },
      getCursor: () => editorCursor || { line: 0, ch: 2 },
      setSelection: (_anchor: any, head: any) => {
        editorCursor = head;
      },
      scrollIntoView: (range: any, center?: boolean) => {
        scrollCalls.push({ range, center });
      },
      focus: () => {
        focusCalls++;
      },
    };

    const state = EditorState.create({
      doc: "first line with match\nsecond line with match",
      extensions: [
        searchSessionField.init(() => sessionState),
      ],
    });

    mockView = {
      state: {
        ...state,
        field: () => sessionState,
      },
      dispatch: (tr: any) => {
        dispatches.push(tr);
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff?.value !== undefined && (eff.value === null || eff.value.matches !== undefined)) {
              sessionState = eff.value;
            }
          }
        }
      },
      focus: () => {
        focusCalls++;
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getSuggestions computes matches and returns indices", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    const suggestions = modal.getSuggestions("match");

    expect(suggestions).toEqual([0, 1]);
    expect(sessionState?.matches).toHaveLength(2);
  });

  it("getSuggestions returns empty array when query has no matches", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    const suggestions = modal.getSuggestions("xyznonexistent");

    expect(suggestions).toEqual([]);
  });

  it("renderSuggestion renders line number and highlights for wildcard matches", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    modal.getSuggestions("first match");

    const el = document.createElement("div");
    modal.renderSuggestion(0, el);

    expect(el.getAttribute("data-index")).toBe("0");
    const lineSpan = el.querySelector(".incsearch-line-number");
    expect(lineSpan?.textContent).toBe("1: ");

    const matchSpans = el.querySelectorAll(".incsearch-match");
    expect(matchSpans.length).toBeGreaterThan(0);
  });

  it("onChooseSuggestion and onClose move cursor to match end on ENTER", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    modal.getSuggestions("match");

    modal.onChooseSuggestion(1, new MouseEvent("click"));
    expect(modal.chosen).toBe(true);
    expect(mockPlugin.settings.lastQuery).toBe("match");

    modal.onClose();
    vi.runAllTimers();

    expect(sessionState).toBeNull();
    const lastDispatch = dispatches[dispatches.length - 1];
    expect(lastDispatch.selection).toBeDefined();
    // Match index 1 in "first line with match\nsecond line with match" ends at index 44
    expect(lastDispatch.selection.head).toBe(44);
    // Editor cursor was updated to line 1, ch 22
    expect(editorCursor).toEqual({ line: 1, ch: 22 });
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls[scrollCalls.length - 1].center).toBe(true);
  });

  it("onClose restores original cursor on ESC without moving", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    modal.getSuggestions("match");
    modal.chosen = false;

    modal.onClose();
    vi.runAllTimers();

    // Session is cancelled and cleared
    expect(sessionState).toBeNull();
    const lastDispatch = dispatches[dispatches.length - 1];
    expect(lastDispatch.selection.anchor).toBe(2);
    expect(lastDispatch.selection.head).toBe(2);
    expect(editorCursor).toEqual({ line: 0, ch: 2 });
  });

  it("regression: previewing match with navigation but exiting with ESC reverts to exact origin", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    modal.getSuggestions("match");

    // Simulate previewing match 1 in document
    setActiveIndex(mockView, 1);
    expect(sessionState?.activeIndex).toBe(1);

    // User hits ESC without choosing
    modal.chosen = false;
    modal.onClose();
    vi.runAllTimers();

    // Cursor must NOT stay on match 1, but must be restored to original cursor (2)
    expect(editorCursor).toEqual({ line: 0, ch: 2 });
    const lastDispatch = dispatches[dispatches.length - 1];
    expect(lastDispatch.selection.head).toBe(2);
  });

  it("regression: deferred timer callbacks ensure final focus and cursor placement after modal close", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    modal.getSuggestions("match");

    modal.onChooseSuggestion(0, new MouseEvent("click"));
    modal.onClose();

    // Immediate state
    expect(editorCursor).toEqual({ line: 0, ch: 21 });

    // Run timers for 0ms and 50ms deferred cycles
    vi.advanceTimersByTime(100);

    expect(editorCursor).toEqual({ line: 0, ch: 21 });
    expect(focusCalls).toBeGreaterThanOrEqual(1);
  });
});
