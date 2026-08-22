import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  updateWidgetCounter,
  removeWidget,
  removeAllWidgets,
  getActiveWidget,
  renderWidget,
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
      settings: { fuzzyMode: true, lastQuery: "", usePopupModal: false, doubleTapWindowMs: 600 },
      saveSettings: async () => {},
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

    const counter = widget?.querySelector(".swiper-search-counter");
    const dir = widget?.querySelector(".swiper-search-dir");

    expect(counter?.textContent).toBe("2/3");
    expect(dir?.textContent).toBe("▼");
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

    const counter = widget?.querySelector(".swiper-search-counter");
    const dir = widget?.querySelector(".swiper-search-dir");

    expect(counter?.textContent).toBe("0/0");
    expect(dir?.textContent).toBe("▲");
  });

  it("handles input event by recomputing query and updating counter", () => {
    renderWidget(mockView, mockPlugin, "", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".swiper-search-input") as HTMLInputElement;

    input.value = "word";
    input.dispatchEvent(new Event("input"));

    expect(sessionState?.query).toBe("word");
  });

  it("handles Enter keydown by committing the match", () => {
    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".swiper-search-input") as HTMLInputElement;

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(mockPlugin.settings.lastQuery).toBe("word");
    expect(getActiveWidget()).toBeNull();
  });

  it("handles Escape keydown by cancelling session", () => {
    renderWidget(mockView, mockPlugin, "word", "forward");
    const widget = getActiveWidget();
    const input = widget?.querySelector(".swiper-search-input") as HTMLInputElement;

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
});
