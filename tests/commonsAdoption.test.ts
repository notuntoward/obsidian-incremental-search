import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import IncrementalSearchPlugin from "../src/main";
import { IncrementalSearchSuggestModal } from "../src/modal";
import { renderSearchWidget, removeWidget, removeAllWidgets } from "../src/widget";
import { applySecondaryStyle } from "../src/utils/adaptive-highlight";
import { applyPdfColors, clearPdfColors } from "../src/utils/colors";
import { PdfMatchController } from "../src/pdf/pdf-match-controller";
import * as workspaceCommons from "commons/workspace";
import * as windowsCommons from "commons/windows";

describe("commons adoption in obsidian-incremental-search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    removeAllWidgets();
  });

  afterEach(() => {
    removeAllWidgets();
  });

  describe("detached leaf safety and focus delegation in main", () => {
    it("ignores and cleans up lastInteractedLeaf when marked detached", async () => {
      const detachedLeaf: any = {
        detached: true,
        containerEl: document.createElement("div"),
        view: { editor: { cm: null } },
      };

      const app: any = {
        workspace: {
          on: vi.fn(),
          onLayoutReady: (cb: any) => cb(),
          iterateAllLeaves: (cb: any) => {
            cb(detachedLeaf);
          },
          getMostRecentLeaf: () => null,
          getActiveViewOfType: () => null,
        },
        metadataCache: { getFileCache: () => null },
      };

      const plugin = new IncrementalSearchPlugin(app, {} as any);
      plugin.loadData = async () => ({});
      plugin.saveData = async () => {};
      plugin.lastInteractedLeaf = detachedLeaf;

      // Access private getActiveTarget through plugin
      const target = (plugin as any).getActiveTarget();
      expect(target).toBeNull();
      expect(plugin.lastInteractedLeaf).toBeNull();
    });

    it("delegates leaf focus to focusLeafAndWindow when handling command with valid leaf", async () => {
      const focusSpy = vi.spyOn(workspaceCommons, "focusLeafAndWindow");

      const leafEl = document.createElement("div");
      leafEl.className = "workspace-leaf mod-active";
      document.body.appendChild(leafEl);

      const mockEditor: any = { cm: null };
      const validLeaf: any = {
        detached: false,
        containerEl: leafEl,
        view: { editor: mockEditor },
      };

      const app: any = {
        workspace: {
          on: vi.fn(),
          onLayoutReady: (cb: any) => cb(),
          iterateAllLeaves: (cb: any) => {
            cb(validLeaf);
          },
          getMostRecentLeaf: () => validLeaf,
          getActiveViewOfType: () => validLeaf.view,
          setActiveLeaf: vi.fn(),
        },
        metadataCache: { getFileCache: () => null },
      };

      const plugin = new IncrementalSearchPlugin(app, {} as any);
      plugin.loadData = async () => ({});
      plugin.saveData = async () => {};
      plugin.lastInteractedLeaf = validLeaf;

      const invokeSpy = vi.spyOn(plugin, "invoke").mockImplementation(() => {});

      const handled = plugin.handleCommand(false, "forward");
      expect(handled).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith(mockEditor, "forward");
      expect(focusSpy).toHaveBeenCalledWith(app, validLeaf);

      leafEl.remove();
    });
  });

  describe("modal scoping to owner window and owner document", () => {
    it("registers and cleans up keyboard listeners on ownerWindow rather than global window", () => {
      const mockOwnerWindow: any = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout: vi.fn((fn: () => void) => { fn(); return 123; }),
        clearTimeout: vi.fn(),
      };

      const container = document.createElement("div");
      // Define defaultView on container ownerDocument
      Object.defineProperty(container.ownerDocument, "defaultView", {
        value: mockOwnerWindow,
        configurable: true,
      });

      const mockApp: any = {
        workspace: { getActiveFile: () => null },
        metadataCache: { getFileCache: () => null },
      };
      const mockPlugin: any = {
        settings: { spaceAsWildcard: true, allMatchesDisplayMode: "off" },
        saveSettings: async () => {},
      };

      const modal = new IncrementalSearchSuggestModal(
        mockApp,
        mockPlugin,
        null,
        { state: { field: () => null }, dispatch: vi.fn() } as any,
        "forward"
      );
      (modal as any).containerEl = container;

      modal.onOpen();
      expect(mockOwnerWindow.addEventListener).toHaveBeenCalledWith(
        "keydown",
        expect.any(Function),
        { capture: true }
      );

      modal.onClose();
      expect(mockOwnerWindow.removeEventListener).toHaveBeenCalledWith(
        "keydown",
        expect.any(Function),
        expect.anything()
      );
    });

    it("creates suggestion text nodes on el.ownerDocument", () => {
      const customDoc = document.implementation.createHTMLDocument("popout");
      const el = customDoc.createElement("div");
      const createTextNodeSpy = vi.spyOn(customDoc, "createTextNode");

      const mockApp: any = {
        workspace: { getActiveFile: () => null },
        metadataCache: { getFileCache: () => null },
      };
      const mockPlugin: any = {
        settings: { spaceAsWildcard: true, allMatchesDisplayMode: "off" },
        saveSettings: async () => {},
      };

      const modal = new IncrementalSearchSuggestModal(
        mockApp,
        mockPlugin,
        null,
        {
          state: {
            field: () => ({
              matches: [{ from: 0, to: 4, chars: [] }],
            }),
            doc: {
              lineAt: () => ({ number: 1, from: 0, text: "test line", length: 9 }),
            },
          },
        } as any,
        "forward"
      );

      modal.renderSuggestion(0, el);
      expect(createTextNodeSpy).toHaveBeenCalled();
    });
  });

  describe("widget blur across windows", () => {
    it("does not refocus editor when focus moves to another window on blur", () => {
      vi.useFakeTimers();

      const customDoc = document.implementation.createHTMLDocument("popout");
      const containerEl = customDoc.createElement("div");
      customDoc.body.appendChild(containerEl);

      // Stub activeDocument to point to the main document (another window)
      const origActiveDoc = Object.getOwnPropertyDescriptor(globalThis, "activeDocument");
      Object.defineProperty(globalThis, "activeDocument", {
        value: document,
        configurable: true,
        writable: true,
      });

      const acceptSpy = vi.fn();
      const mockController: any = {
        containerEl,
        accept: acceptSpy,
        advance: vi.fn(),
        adapter: { containerEl },
        getCounterState: () => ({ current: 1, total: 1, direction: "forward", inTable: false }),
        state: { query: "abc", direction: "forward", activeIndex: 0, totalMatchesCount: 1 },
      };

      renderSearchWidget(
        mockController,
        { spaceAsWildcard: true } as any,
        "abc",
        "forward"
      );

      const input = containerEl.querySelector("input") as HTMLInputElement;
      expect(input).toBeDefined();
      vi.advanceTimersByTime(250); // expire focus guard (200ms)

      input.blur();
      input.dispatchEvent(new FocusEvent("blur"));
      vi.advanceTimersByTime(150);

      // When focus moved to another window, accept(false) should be called without refocus
      expect(acceptSpy).toHaveBeenCalledWith(false);

      if (origActiveDoc) {
        Object.defineProperty(globalThis, "activeDocument", origActiveDoc);
      } else {
        delete (globalThis as any).activeDocument;
      }
      vi.useRealTimers();
    });
  });

  describe("secondary styling and color custom properties scoped to target document", () => {
    it("applySecondaryStyle sets CSS variables on the provided document", () => {
      const customDoc = document.implementation.createHTMLDocument("popout");
      const style = {
        fillCss: "rgba(100, 150, 200, 0.3)",
        edgeCss: "rgba(100, 150, 200, 0.8)",
        appearance: { fill: "rgba(100, 150, 200, 0.3)", edge: "rgba(100, 150, 200, 0.8)" } as any,
      };

      applySecondaryStyle(style as any, customDoc);

      expect(customDoc.documentElement.style.getPropertyValue("--incsearch-secondary-fill")).toBe("rgba(100, 150, 200, 0.3)");
      expect(customDoc.documentElement.style.getPropertyValue("--incsearch-secondary-edge")).toBe("rgba(100, 150, 200, 0.8)");
      expect(customDoc.body.style.getPropertyValue("--incsearch-secondary-fill")).toBe("rgba(100, 150, 200, 0.3)");
    });

    it("applyPdfColors sets --incsearch-pdf-secondary-fill on containerEl.ownerDocument", () => {
      const customDoc = document.implementation.createHTMLDocument("popout");
      Object.defineProperty(customDoc, "defaultView", { value: window, configurable: true });
      const container = customDoc.createElement("div");
      customDoc.body.appendChild(container);

      applyPdfColors(container);

      expect(customDoc.documentElement.style.getPropertyValue("--incsearch-pdf-secondary-fill")).toBeTruthy();

      clearPdfColors(container);
      expect(customDoc.documentElement.style.getPropertyValue("--incsearch-pdf-secondary-fill")).toBe("");
    });
  });

  describe("pdf controller scoped to ownerWindow", () => {
    it("attaches listeners to ownerWindow of containerEl", () => {
      const mockWin: any = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout: vi.fn((fn: () => void) => { return 1; }),
        clearTimeout: vi.fn(),
        requestAnimationFrame: vi.fn((fn: () => void) => 1),
      };

      const customDoc = document.implementation.createHTMLDocument("pdf-window");
      Object.defineProperty(customDoc, "defaultView", { value: mockWin, configurable: true });

      const container = customDoc.createElement("div");
      customDoc.body.appendChild(container);

      const mockAdapter: any = {
        numPages: 5,
        containerEl: container,
        getPageElement: () => null,
        getVisiblePageNumbers: () => [1],
        on: vi.fn(() => () => {}),
        scrollPageIntoView: vi.fn(),
      };

      const controller = new PdfMatchController(
        mockAdapter,
        { spaceAsWildcard: true } as any,
        "forward",
        vi.fn()
      );

      expect(mockWin.addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), expect.anything());
      expect(mockWin.addEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), expect.anything());
      expect(mockWin.addEventListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), expect.anything());

      controller.destroy();
      expect(mockWin.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), expect.anything());
      expect(mockWin.removeEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), expect.anything());
    });
  });
});
