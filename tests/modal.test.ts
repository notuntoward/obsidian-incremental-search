import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { IncrementalSearchSuggestModal } from "../src/modal";
import { searchSessionField } from "../src/session";
import { SearchSessionState } from "../src/types";

describe("modal: IncrementalSearchSuggestModal", () => {
  let sessionState: SearchSessionState | null = null;
  let mockApp: any;
  let mockPlugin: any;
  let mockView: any;
  let dispatches: any[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    dispatches = [];
    sessionState = {
      query: "",
      direction: "forward",
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: 2, head: 2 },
    };

    mockApp = {};
    mockPlugin = {
      settings: { fuzzyMode: true, lastQuery: "", usePopupModal: true, doubleTapWindowMs: 600 },
      saveSettings: async () => {},
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
      focus: () => {},
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getSuggestions computes matches and returns indices", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockView, "forward");
    const suggestions = modal.getSuggestions("match");

    expect(suggestions).toEqual([0, 1]);
    expect(sessionState?.matches).toHaveLength(2);
  });

  it("getSuggestions returns empty array when query has no matches", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockView, "forward");
    const suggestions = modal.getSuggestions("xyznonexistent");

    expect(suggestions).toEqual([]);
  });

  it("renderSuggestion renders line number and highlights for fuzzy matches", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockView, "forward");
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
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockView, "forward");
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
  });

  it("onClose restores original cursor on ESC without moving", () => {
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockView, "forward");
    modal.getSuggestions("match");
    modal.chosen = false;

    modal.onClose();
    vi.runAllTimers();

    // Session is cancelled and cleared
    expect(sessionState).toBeNull();
    const lastDispatch = dispatches[dispatches.length - 1];
    expect(lastDispatch.selection.anchor).toBe(2);
    expect(lastDispatch.selection.head).toBe(2);
  });
});
