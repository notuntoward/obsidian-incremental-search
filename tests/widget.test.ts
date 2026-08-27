import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  updateWidgetCounter,
  removeWidget,
  removeAllWidgets,
  getActiveWidget,
  renderWidget,
  renderPdfWidget,
  setFocusGuard,
} from "../src/widget";
import { SearchSessionState } from "../src/types";

describe("widget: counter & lifecycle", () => {
  let sessionState: SearchSessionState | null = null;
  let mockView: any;
  let mockPlugin: any;

  beforeEach(() => {
    sessionState = {
      query: "word",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    mockView = {
      state: {
        field: () => sessionState,
        doc: {
          lines: 1,
          line: () => ({ text: "word ... word", from: 0, to: 13, length: 13 }),
        },
      },
      dispatch: (tr: any) => {
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff?.value !== undefined && (eff.value === null || eff.value.matches !== undefined)) {
              sessionState = eff.value;
            }
          }
        }
      },
      dom: {
        parentElement: document.createElement("div"),
      },
      focus: () => {},
    };

    mockPlugin = {
      settings: { spaceAsWildcard: true, lastQuery: "", usePopupModal: false, doubleTapWindowMs: 600, matchOnlyVisibleLinks: true },
      saveSettings: async () => {},
      app: {
        workspace: {
          getActiveFile: () => null,
        },
        metadataCache: {
          getFileCache: () => null,
        },
      }
    };
  });

  afterEach(() => {
    removeAllWidgets();
  });

  it("handles updateWidgetCounter when no widget is rendered", () => {
    expect(() => updateWidgetCounter(mockView)).not.toThrow();
  });

  it("updates counter and direction when widget is rendered", () => {
    sessionState = {
      query: "word",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }, { from: 20, to: 24 }],
      activeIndex: 1,
      originSelection: { anchor: 0, head: 0 },
    };

    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    expect(widget).not.toBeNull();

    const counter = widget?.querySelector(".incsearch-counter");
    const dir = widget?.querySelector(".incsearch-dir");

    expect(counter?.textContent).toBe("2/3");
    expect(dir?.textContent).toBe("▼");
  });

  it("shows table icon when match is in table and hides it when not in table", () => {
    sessionState = {
      query: "word",
      direction: "forward",
      matches: [
        { from: 0, to: 4, inTable: true },
        { from: 10, to: 14, inTable: false }
      ],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    expect(widget).not.toBeNull();

    const counter = widget?.querySelector(".incsearch-counter");
    const tableIcon = widget?.querySelector(".incsearch-table-icon") as HTMLElement;

    expect(counter?.textContent).toBe("1/2");
    expect(tableIcon?.style.display).toBe("inline-flex");

    // Move to match not in table
    sessionState.activeIndex = 1;
    updateWidgetCounter(mockView);
    expect(counter?.textContent).toBe("2/2");
    expect(tableIcon?.style.display).toBe("none");
  });

  it("updates counter to 0/0 when there are no matches", () => {
    sessionState = {
      query: "nomatch",
      direction: "backward",
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    renderWidget(mockView, mockPlugin, "nomatch", "backward");
    const widget = getActiveWidget();
    expect(widget).not.toBeNull();

    const counter = widget?.querySelector(".incsearch-counter");
    const dir = widget?.querySelector(".incsearch-dir");
    const tableIcon = widget?.querySelector(".incsearch-table-icon") as HTMLElement;

    expect(counter?.textContent).toBe("0/0");
    expect(dir?.textContent).toBe("▲");
    expect(tableIcon?.style.display).toBe("none");
  });

  it("handles input event by recomputing query and updating counter", () => {
    renderWidget(mockView, mockPlugin, "", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    input.value = "word";
    input.dispatchEvent(new Event("input"));

    expect(sessionState?.query).toBe("word");
  });

  it("handles Enter keydown by committing the match", () => {
    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(mockPlugin.settings.lastQuery).toBe("word");
    expect(getActiveWidget()).toBeNull();
  });

  it("handles Escape keydown by cancelling session", () => {
    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(getActiveWidget()).toBeNull();
  });

  it("removes active widget cleanly", () => {
    renderWidget(mockView, mockPlugin, "", "forward");
    expect(getActiveWidget()).not.toBeNull();

    removeWidget(mockView);
    expect(getActiveWidget()).toBeNull();
  });

  it("handles Ctrl+S and Ctrl+R in renderPdfWidget without blurring or closing", () => {
    let advancedDir: string | null = null;
    const mockController: any = {
      adapter: { containerEl: document.createElement("div") },
      state: { matches: [{ id: "m1" }, { id: "m2" }], activeIndex: 0, direction: "forward", isScanning: false, query: "test" },
      advance: (dir: string) => {
        advancedDir = dir;
      },
      search: async () => {},
    };

    let closed = false;
    renderPdfWidget(mockController, mockPlugin, "test", "forward", () => {
      closed = true;
    });

    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    // Press Ctrl+S -> should advance forward
    const ctrlSEvent = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(ctrlSEvent);
    expect(advancedDir).toBe("forward");
    expect(ctrlSEvent.defaultPrevented).toBe(true);
    expect(closed).toBe(false);

    // Press Ctrl+R -> should advance backward
    const ctrlREvent = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(ctrlREvent);
    expect(advancedDir).toBe("backward");
    expect(ctrlREvent.defaultPrevented).toBe(true);
    expect(closed).toBe(false);
  });

  it("handles Enter and Escape in Emacs mode (default) in editor widget", () => {
    mockPlugin.settings.searchExitBehavior = "emacs";
    sessionState = {
      query: "word",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    // Press Escape -> should cancel session and close widget
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escEvent);
    expect(getActiveWidget()).toBeNull();
  });

  it("handles Enter, Shift+Enter, and Escape in Obsidian mode in editor widget", () => {
    mockPlugin.settings.searchExitBehavior = "obsidian";
    sessionState = {
      query: "word",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    // Press Enter -> should advance forward to next match and stay open
    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enterEvent);
    expect(sessionState?.activeIndex).toBe(1);
    expect(getActiveWidget()).not.toBeNull();

    // Press Shift+Enter -> should advance backward (reverse direction) and stay open
    const shiftEnterEvent = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(shiftEnterEvent);
    expect(sessionState?.activeIndex).toBe(0);
    expect(getActiveWidget()).not.toBeNull();

    // Press Escape -> should accept current match and close widget
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escEvent);
    expect(mockPlugin.settings.lastQuery).toBe("word");
    expect(getActiveWidget()).toBeNull();
  });

  it("handles Enter and Escape in Obsidian mode in PDF widget", () => {
    mockPlugin.settings.searchExitBehavior = "obsidian";
    let advancedDir: string | null = null;
    let accepted = false;
    let cancelled = false;
    const mockController: any = {
      adapter: { containerEl: document.createElement("div") },
      state: { matches: [{ id: "m1" }, { id: "m2" }], activeIndex: 0, direction: "forward", isScanning: false, query: "test" },
      advance: (dir: string) => {
        advancedDir = dir;
      },
      search: async () => {},
      accept: () => {
        accepted = true;
      },
      cancel: () => {
        cancelled = true;
      },
    };

    let closed = false;
    renderPdfWidget(mockController, mockPlugin, "test", "forward", () => {
      closed = true;
    });

    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    // Press Enter -> should advance forward and remain open
    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enterEvent);
    expect(advancedDir).toBe("forward");
    expect(closed).toBe(false);

    // Press Escape -> should accept and close
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escEvent);
    expect(accepted).toBe(true);
    expect(cancelled).toBe(false);
    expect(closed).toBe(true);
  });

  it("handles Ctrl+Enter in editor widget to toggle demand highlights", () => {
    mockPlugin.settings.allMatchesDisplayMode = "on-demand";
    sessionState = {
      query: "word",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
      allMatchesDisplayMode: "on-demand",
      isDemandPeekActive: false,
    };

    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    // Press Ctrl+Enter -> toggles highlights on
    const ctrlEnterEvent = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(ctrlEnterEvent);
    expect(sessionState?.isDemandPeekActive).toBe(true);
    expect(getActiveWidget()).not.toBeNull();

    // Press Ctrl+Enter again -> toggles highlights off
    const ctrlEnterEvent2 = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(ctrlEnterEvent2);
    expect(sessionState?.isDemandPeekActive).toBe(false);
    expect(getActiveWidget()).not.toBeNull();
  });

  it("handles Ctrl+Enter in PDF widget to toggle demand highlights", () => {
    let toggled = false;
    const mockController: any = {
      adapter: { containerEl: document.createElement("div") },
      settings: { allMatchesDisplayMode: "on-demand" },
      state: { matches: [{ id: "m1" }], activeIndex: 0, direction: "forward", isScanning: false, query: "test", isDemandPeekActive: false },
      search: async () => {},
      toggleDemandHighlights: () => {
        toggled = true;
      },
    };

    renderPdfWidget(mockController, mockPlugin, "test", "forward", () => {});
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    const ctrlEnterEvent = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(ctrlEnterEvent);
    expect(toggled).toBe(true);
    expect(ctrlEnterEvent.defaultPrevented).toBe(true);
  });
});

describe("widget: focus-guard regression", () => {
  let sessionState: SearchSessionState | null = null;
  let mockView: any;
  let mockPlugin: any;

  beforeEach(() => {
    vi.useFakeTimers();

    sessionState = {
      query: "word",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    mockView = {
      state: {
        field: () => sessionState,
        doc: {
          lines: 1,
          line: () => ({ text: "word ... word", from: 0, to: 13, length: 13 }),
        },
      },
      dispatch: (tr: any) => {
        if (tr.effects) {
          const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
          for (const eff of effects) {
            if (eff?.value !== undefined && (eff.value === null || eff.value.matches !== undefined)) {
              sessionState = eff.value;
            }
          }
        }
      },
      dom: { parentElement: document.createElement("div") },
      focus: () => {},
    };

    mockPlugin = {
      settings: {
        spaceAsWildcard: false,
        lastQuery: "",
        usePopupModal: false,
        matchOnlyVisibleLinks: false,
        allMatchesDisplayMode: "off",
        searchExitBehavior: "emacs",
      },
      saveSettings: async () => {},
      app: {
        workspace: { getActiveFile: () => null },
        metadataCache: { getFileCache: () => null },
      },
    };
  });

  afterEach(() => {
    removeAllWidgets();
    vi.useRealTimers();
  });

  it("setFocusGuard is exported and callable", () => {
    // Should not throw; arms the guard for 200 ms (default)
    expect(() => setFocusGuard()).not.toThrow();
    // Custom duration should also work
    expect(() => setFocusGuard(500)).not.toThrow();
  });

  it("blur during focus-guard window re-focuses input instead of closing session", () => {
    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;
    expect(widget).not.toBeNull();

    // Arm the guard so the widget believes it was just focused programmatically
    setFocusGuard(200);

    // Mock input.focus so we can observe re-focus calls
    let focusCallCount = 0;
    const origFocus = input.focus.bind(input);
    input.focus = () => { focusCallCount++; origFocus(); };

    // Dispatch a blur event while the guard is still live (< 200 ms elapsed)
    input.dispatchEvent(new FocusEvent("blur"));

    // Advance time past the blur handler's 100 ms debounce, but still within the 200 ms guard
    vi.advanceTimersByTime(100);

    // Guard should have re-focused the input rather than closing the session
    expect(focusCallCount).toBeGreaterThan(0);
    expect(getActiveWidget()).not.toBeNull();
    expect(sessionState).not.toBeNull();
  });

  it("blur after focus-guard expires closes the session normally", () => {
    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;
    expect(widget).not.toBeNull();

    // Arm a very short guard (1 ms) that will have expired by the time the blur handler fires
    setFocusGuard(1);

    // Advance time past the guard duration so it has expired
    vi.advanceTimersByTime(5);

    // Dispatch blur and advance past the 100 ms debounce
    input.dispatchEvent(new FocusEvent("blur"));
    vi.advanceTimersByTime(110);

    // Guard has expired → session should be closed
    expect(getActiveWidget()).toBeNull();
    expect(sessionState).toBeNull();
  });

  it("renderWidget arms the focus-guard on initial render", () => {
    // Patch Date.now so we can observe that the guard is set to a future time
    const before = Date.now();
    renderWidget(mockView, mockPlugin, "", "forward");

    // Simulate an immediate blur (e.g. from a CM dispatch stealing focus)
    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    let refocused = false;
    const origFocus = input.focus.bind(input);
    input.focus = () => { refocused = true; origFocus(); };

    input.dispatchEvent(new FocusEvent("blur"));
    // Advance time inside the blur debounce but before guard expires
    vi.advanceTimersByTime(100);

    // The guard should have been active and re-focused the input
    expect(refocused).toBe(true);
    expect(getActiveWidget()).not.toBeNull();
    void before; // suppress unused warning
  });

  it("PDF widget: blur during focus-guard window re-focuses instead of calling onClose", () => {
    const mockController: any = {
      adapter: { containerEl: document.createElement("div") },
      state: {
        matches: [{ id: "m1" }],
        activeIndex: 0,
        direction: "forward",
        isScanning: false,
        query: "test",
      },
      search: async () => {},
      onStateChange: null,
    };

    let closed = false;
    renderPdfWidget(mockController, mockPlugin, "test", "forward", () => {
      closed = true;
    });

    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;
    expect(widget).not.toBeNull();

    // Guard was armed by renderPdfWidget; immediately dispatch blur
    let refocused = false;
    const origFocus = input.focus.bind(input);
    input.focus = () => { refocused = true; origFocus(); };

    input.dispatchEvent(new FocusEvent("blur"));
    // Advance to just inside the blur debounce window (100 ms), within the 200 ms guard
    vi.advanceTimersByTime(100);

    expect(refocused).toBe(true);
    expect(closed).toBe(false);
    expect(getActiveWidget()).not.toBeNull();
  });

  it("PDF widget: blur after focus-guard expires calls onClose", () => {
    const mockController: any = {
      adapter: { containerEl: document.createElement("div") },
      state: {
        matches: [],
        activeIndex: 0,
        direction: "forward",
        isScanning: false,
        query: "",
      },
      search: async () => {},
      onStateChange: null,
    };

    let closed = false;
    renderPdfWidget(mockController, mockPlugin, "", "forward", () => {
      closed = true;
    });

    const widget = getActiveWidget();
    const input = widget?.querySelector(".incsearch-input") as HTMLInputElement;

    // Manually expire the guard
    setFocusGuard(1);
    vi.advanceTimersByTime(5); // guard is now expired

    input.dispatchEvent(new FocusEvent("blur"));
    vi.advanceTimersByTime(110); // past the 100 ms debounce

    expect(closed).toBe(true);
  });
});

