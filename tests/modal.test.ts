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
            setEphemeralState: () => { },
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
      saveSettings: async () => { },
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

  it.each(["emacs", "obsidian"])("Popup honors Enter, Shift+Enter and Escape and hints for %s", (searchExitBehavior) => {
    mockPlugin.settings.searchExitBehavior = searchExitBehavior;
    mockPlugin.settings.allMatchesDisplayMode = "on-demand";
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "backward");
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.appendChild(input);
    document.body.appendChild(container);
    Object.defineProperty(modal, "containerEl", { value: container });
    const instructions = vi.spyOn(modal, "setInstructions");
    const close = vi.spyOn(modal, "close").mockImplementation(() => modal.onClose());
    const choose = vi.spyOn(modal, "onChooseSuggestion");
    const select = vi.fn();
    Object.defineProperty(modal, "chooser", { value: { values: [0, 1], setSelectedItem: select } });
    try {
      modal.getSuggestions("match");
      modal.onOpen();
      expect(instructions).toHaveBeenCalledWith(expect.arrayContaining([
        { command: "Enter", purpose: searchExitBehavior === "emacs" ? "Accept" : "Next" },
        { command: "Esc", purpose: searchExitBehavior === "emacs" ? "Cancel" : "Accept" },
        { command: "Ctrl+Enter", purpose: "Highlights" },
      ]));
      const press = (key: string, shiftKey = false, ctrlKey = false) =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, ctrlKey, bubbles: true, cancelable: true }));
      press("r", false, true);
      expect(modal.direction).toBe("backward");
      expect(select).toHaveBeenLastCalledWith(sessionState!.activeIndex);
      press("s", false, true);
      expect(modal.direction).toBe("forward");
      const index = sessionState!.activeIndex;
      press("Enter", true);
      if (searchExitBehavior === "obsidian") {
        expect(close).not.toHaveBeenCalled();
        expect(sessionState?.activeIndex).toBe((index + 1) % 2);
        expect(modal.direction).toBe("backward");
        press("Enter");
        expect(modal.direction).toBe("forward");
        press("Escape");
      }
      expect(choose).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      vi.runAllTimers();
      expect(sessionState).toBeNull();
      if (searchExitBehavior === "emacs") {
        // A fresh search still cancels rather than accepts on Escape.
        sessionState = { query: "", direction: "forward", matches: [], activeIndex: 0, originSelection: { anchor: 2, head: 2 } };
        modal.chosen = false;
        modal.getSuggestions("match");
        modal.onOpen();
        press("Escape");
        vi.runAllTimers();
        expect(choose).toHaveBeenCalledTimes(1);
        expect(editorCursor).toEqual({ line: 0, ch: 2 });
      }
    } finally {
      modal.modalKeyCleanup?.();
      modal.observer?.disconnect();
      container.remove();
    }
  });

  it.each(["emacs", "obsidian"])("Popup preserves navigation aliases, composition and highlight toggling in %s", (searchExitBehavior) => {
    mockPlugin.settings.searchExitBehavior = searchExitBehavior;
    mockPlugin.settings.allMatchesDisplayMode = "on-demand";
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "backward");
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.appendChild(input);
    document.body.appendChild(container);
    Object.defineProperty(modal, "containerEl", { value: container });
    const select = vi.fn();
    Object.defineProperty(modal, "chooser", { value: { setSelectedItem: select } });
    const close = vi.spyOn(modal, "close").mockImplementation(() => {});
    try {
      modal.getSuggestions("i");
      modal.onOpen();
      expect(sessionState!.matches.length).toBeGreaterThan(2);
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
        for (const [key, shiftKey, direction] of [
          ["r", false, "backward"], ["s", false, "forward"],
          ["F3", true, "backward"], ["F3", false, "forward"],
        ] as const) {
          const current = sessionState!.activeIndex;
          const expected = (current + (direction === "forward" ? 1 : -1) + sessionState!.matches.length) % sessionState!.matches.length;
          const event = new KeyboardEvent("keydown", { key, shiftKey, ...modifiers, bubbles: true, cancelable: true });
          input.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
          expect(sessionState!.activeIndex).toBe(expected);
          expect(sessionState!.direction).toBe(direction);
          expect(select).toHaveBeenLastCalledWith(expected);
        }
      }
      const before = sessionState;
      const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
      input.dispatchEvent(composing);
      expect(composing.defaultPrevented).toBe(false);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "F3", bubbles: true }));
      expect(sessionState).toBe(before);
      expect(close).not.toHaveBeenCalled();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      expect(sessionState!.isDemandPeekActive).toBe(true);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
      expect(sessionState!.isDemandPeekActive).toBe(false);
      modal.getSuggestions("xyznonexistent");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(close).toHaveBeenCalledTimes(searchExitBehavior === "emacs" ? 1 : 0);
      if (searchExitBehavior === "obsidian") {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(close).toHaveBeenCalledTimes(1);
      }
    } finally {
      modal.onClose();
      vi.runAllTimers();
      container.remove();
    }
  });

  it.each(["ctrlKey", "metaKey"])("captures %s+G before host shortcuts and cancels Popup regardless of exit mode", (modifier) => {
    for (const searchExitBehavior of ["emacs", "obsidian"]) {
      sessionState = {
        query: "", direction: "forward", matches: [], activeIndex: 0,
        originSelection: { anchor: 2, head: 2 },
      };
      mockPlugin.settings.searchExitBehavior = searchExitBehavior;
      const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
      const container = document.createElement("div");
      const input = document.createElement("input");
      container.appendChild(input);
      document.body.appendChild(container);
      Object.defineProperty(modal, "containerEl", { value: container });
      const close = vi.spyOn(modal, "close").mockImplementation(() => modal.onClose());
      const hostShortcut = vi.fn((evt: Event) => evt.stopImmediatePropagation());
      document.addEventListener("keydown", hostShortcut, true);
      try {
        modal.getSuggestions("match");
        modal.onOpen();
        const event = new KeyboardEvent("keydown", {
          key: "g", [modifier]: true, bubbles: true, cancelable: true,
        });
        input.dispatchEvent(event);
        expect(close).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        expect(hostShortcut).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(sessionState).toBeNull();
        expect(editorCursor).toEqual({ line: 0, ch: 2 });
        expect(mockPlugin.settings.lastQuery).toBe("match");
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "g", [modifier]: true, bubbles: true, cancelable: true,
        }));
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        modal.modalKeyCleanup?.();
        modal.observer?.disconnect();
        document.removeEventListener("keydown", hostShortcut, true);
        container.remove();
      }
    }
  });

  it("scopes Popup Ctrl+G to its owning pop-out and leaves plain G and other documents alone", () => {
    const popout = document.implementation.createHTMLDocument("popout");
    const container = popout.createElement("div");
    const input = popout.createElement("input");
    container.appendChild(input);
    popout.body.appendChild(container);
    const modal = new IncrementalSearchSuggestModal(mockApp, mockPlugin, mockEditor, mockView, "forward");
    Object.defineProperty(modal, "containerEl", { value: container });
    const close = vi.spyOn(modal, "close").mockImplementation(() => modal.onClose());
    Object.defineProperty(popout, "activeElement", { get: () => input, configurable: true });
    vi.stubGlobal("activeDocument", popout);
    vi.stubGlobal("activeWindow", window);
    try {
      modal.getSuggestions("match");
      modal.onOpen();
      for (const [target, ctrlKey] of [[input, false], [popout.body, true], [document.body, true]] as const) {
        const event = new KeyboardEvent("keydown", { key: "g", ctrlKey, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(close).not.toHaveBeenCalled();
      }
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true }));
      expect(close).toHaveBeenCalledTimes(1);
      vi.runAllTimers();
      expect(sessionState).toBeNull();
      expect(editorCursor).toEqual({ line: 0, ch: 2 });
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true }));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      modal.modalKeyCleanup?.();
      modal.observer?.disconnect();
      vi.unstubAllGlobals();
    }
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
