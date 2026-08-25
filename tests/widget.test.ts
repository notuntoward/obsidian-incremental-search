import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  updateWidgetCounter,
  removeWidget,
  removeAllWidgets,
  getActiveWidget,
  renderWidget,
  renderPdfWidget,
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
      settings: { fuzzyMode: true, lastQuery: "", usePopupModal: false, doubleTapWindowMs: 600, matchOnlyVisibleLinks: true },
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
});
