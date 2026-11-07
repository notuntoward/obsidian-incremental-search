import { describe, it, expect, beforeEach, afterEach } from "vitest";
import IncrementalSearchPlugin from "../src/main";
import { getActiveWidget, removeWidget, renderWidget } from "../src/widget";
import * as colors from "../src/utils/colors";
import { isPdfView, createPdfViewAdapter } from "../src/pdf/pdf-view-adapter";
import { onSearchNavigation } from "commons/search";

(global as any).Event = class {};

describe("IncrementalSearchPlugin Hotkey Routing & Lifecycle", () => {
  let plugin: any;
  let commands: Record<string, any>;
  let dispatches: any[];
  let currentSession: any;

  beforeEach(async () => {
    commands = {};
    dispatches = [];
    currentSession = null;
    removeWidget();

    // Mock the Obsidian Plugin app/manifest
    const app = {
      workspace: {
        on: () => {},
        onLayoutReady: (cb: any) => cb(),
        getActiveFile: () => null,
      },
      metadataCache: {
        getFileCache: () => null,
      },
    };
    plugin = new IncrementalSearchPlugin(app as any, {} as any);

    // Intercept addCommand to capture the callbacks
    plugin.addCommand = (cmd: any) => {
      commands[cmd.id] = cmd;
    };

    // Mock loadSettings
    plugin.loadData = async () => ({
      doubleTapWindowMs: 600,
      spaceAsWildcard: true,
      lastQuery: "",
    });
    plugin.saveData = async () => {};

    await plugin.onload();
  });

  // A mock editor whose CodeMirror DOM is attached, so the search bar can be rendered beside it.
  const makeEditor = (stateExtras: Record<string, any> = {}) => {
    const host = document.body.createDiv();
    const dom = host.createDiv();
    return {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          ...stateExtras,
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          const value = args.effects?.value;
          if (value === null) currentSession = null;
          else if (value?.query !== undefined) currentSession = value;
        },
        dom,
        focus: () => {},
      },
    };
  };
  const recallDoc = {
    doc: {
      lines: 1,
      line: (_i: number) => ({ text: "here is a previous search match", from: 0, to: 31, length: 31 }),
    },
  };

  it("registers forward and backward commands", () => {
    expect(commands["forward"]).toBeDefined();
    expect(commands["backward"]).toBeDefined();
    expect(commands["forward"].name).toBe("Forward Emacs");
    expect(commands["backward"].name).toBe("Reverse Emacs");
    expect(plugin.settings.searchExitBehavior).toBe("emacs");
  });

  it.each([false, true])("routes existing commands to a focused external search before editor fallback (popout=%s)", (popout) => {
    const doc = popout ? document.implementation.createHTMLDocument() : document;
    const input = doc.createElement("input");
    doc.body.appendChild(input);
    if (popout) Object.defineProperty(doc, "activeElement", { value: input, configurable: true });
    else input.focus();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "activeDocument")!;
    Object.defineProperty(globalThis, "activeDocument", { configurable: true, get: () => doc });
    const advance = vi.fn();
    const cleanup = onSearchNavigation(input, (direction, checking) => {
      if (!checking) advance(direction);
      return true;
    });
    const fallback = vi.spyOn(plugin, "getActiveTarget");
    try {
      expect(commands.forward.checkCallback(true)).toBe(true);
      expect(advance).not.toHaveBeenCalled();
      expect(commands.forward.checkCallback(false)).toBe(true);
      expect(advance).toHaveBeenCalledExactlyOnceWith("forward");
      expect(commands.backward.checkCallback(false)).toBe(true);
      expect(advance).toHaveBeenLastCalledWith("backward");
      expect(advance).toHaveBeenCalledTimes(2);
      expect(fallback).not.toHaveBeenCalled();
      expect(doc.activeElement).toBe(input);
    } finally {
      cleanup();
      Object.defineProperty(globalThis, "activeDocument", previous);
      input.remove();
    }
  });

  it.each(["compact", "obsidian"])("uses the registered command shortcuts once while %s input is focused", (searchInterface) => {
    plugin.settings.searchInterface = searchInterface;
    plugin.app.hotkeyManager = {
      printHotkeyForCommand: (id: string) => id.endsWith(":forward") ? "Alt + N" : "Alt + P",
    };
    currentSession = {
      query: "word", direction: "forward", activeIndex: 0,
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }, { from: 20, to: 24 }],
      originSelection: { anchor: 0, head: 0 },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = {
      cm: {
        state: { field: () => currentSession },
        dispatch: (args: any) => {
          if (args.effects?.value?.query !== undefined) currentSession = args.effects.value;
        },
        dom: container.createDiv(),
      },
    };
    vi.spyOn(plugin, "getActiveTarget").mockReturnValue({ type: "editor", editor });
    // Stand in for Obsidian's native capture dispatcher; the widget must not
    // register another copy of the command or maintain its own key mapping.
    let forwardKey = "n";
    const nativeDispatch = (evt: KeyboardEvent) => {
      const direction = evt.altKey && evt.key === forwardKey ? "forward"
        : evt.altKey && evt.key === "p" ? "backward" : null;
      if (direction && commands[direction].checkCallback(false)) {
        evt.preventDefault();
        evt.stopPropagation();
      }
    };
    document.addEventListener("keydown", nativeDispatch, true);
    try {
      renderWidget(editor.cm as any, plugin, "word", "forward");
      const input = getActiveWidget()!.querySelector("input")!;
      input.focus();
      const press = (key: string) => {
        const event = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event;
      };
      expect(press("n").defaultPrevented).toBe(true);
      expect(currentSession.activeIndex).toBe(1);
      expect(press("p").defaultPrevented).toBe(true);
      expect(currentSession.activeIndex).toBe(0);
      forwardKey = "j";
      expect(press("n").defaultPrevented).toBe(false);
      expect(currentSession.activeIndex).toBe(0);
      expect(press("j").defaultPrevented).toBe(true);
      expect(currentSession.activeIndex).toBe(1);
      expect(getActiveWidget()?.querySelector(".incsearch-counter")?.textContent).toBe("2/3");
      expect(document.activeElement).toBe(input);
      if (searchInterface === "obsidian") {
        expect(getActiveWidget()?.querySelector(".incsearch-key-hints")?.textContent).toContain("Alt + N");
        expect(getActiveWidget()?.querySelector(".incsearch-key-hints")?.textContent).not.toContain("F3");
      }
    } finally {
      document.removeEventListener("keydown", nativeDispatch, true);
      plugin.onunload();
      container.remove();
    }
  });

  it("starts a new session if none is active", () => {
    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          doc: {
            toString: () => "test text",
            lines: 1,
            line: (_i: number) => ({ text: "test text", from: 0, to: 9, length: 9 }),
          },
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects && args.effects.value && args.effects.value.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: document.createElement("div") },
      },
    };

    // Trigger forward search
    plugin.handleCommand(false, "forward", mockEditor as any);

    // It should have dispatched a setSession effect with a new session
    expect(dispatches.length).toBeGreaterThan(0);
    expect(currentSession).not.toBeNull();
    expect(currentSession.direction).toBe("forward");
  });

  it("pre-populates query and starts search from active selection when search is invoked", () => {
    currentSession = null;

    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 4, from: 0, to: 4, empty: false } },
          sliceDoc: (from: number, to: number) => "test text".slice(from, to),
          field: () => currentSession,
          doc: {
            toString: () => "test text and more test text",
            lines: 1,
            line: (_i: number) => ({ text: "test text and more test text", from: 0, to: 28, length: 28 }),
          },
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects && args.effects.value && args.effects.value.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: document.createElement("div") },
      },
    };

    plugin.handleCommand(false, "forward", mockEditor as any);

    expect(currentSession).not.toBeNull();
    expect(currentSession.query).toBe("test");
    expect(currentSession.originSelection).toEqual({ anchor: 0, head: 4 });
  });

  it("advances the session if one is already active with query", () => {
    const mockEditor = makeEditor();
    plugin.handleCommand(false, "forward", mockEditor as any);
    currentSession = {
      query: "test",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    // Trigger forward search again (like pressing search command hotkey a second time)
    plugin.handleCommand(false, "forward", mockEditor as any);

    // It should just advance, not reset the query
    expect(currentSession.query).toBe("test");
    expect(currentSession.activeIndex).toBe(1); // advanced to next match
  });

  it("recalls lastQuery when active session query is empty (double-tap recall)", () => {
    plugin.settings.lastQuery = "previous search";
    const mockEditor = makeEditor(recallDoc);

    // First press opens an empty bar; the repeat press recalls lastQuery.
    plugin.handleCommand(false, "forward", mockEditor as any);
    expect(getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input")?.value).toBe("");
    // Scrolling to the recalled match can move focus out of the bar; its blur handler
    // would then accept and close it, so the repeat press must refocus the input.
    (mockEditor.cm.dom as HTMLElement).tabIndex = 0;
    (mockEditor.cm.dom as HTMLElement).focus();
    plugin.handleCommand(false, "backward", mockEditor as any);

    expect(currentSession.query).toBe("previous search");
    expect(currentSession.direction).toBe("backward");
    const input = getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input");
    expect(input?.value).toBe("previous search");
    expect(document.activeElement).toBe(input);
  });

  it("starts empty instead of recalling lastQuery when a stale session has no visible bar", () => {
    plugin.settings.lastQuery = "previous search";
    const mockEditor = makeEditor(recallDoc);
    // The bar was closed elsewhere (pane click, leaf switch) without ending this note's session.
    currentSession = {
      query: "",
      direction: "forward",
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };
    expect(getActiveWidget()).toBeNull();

    plugin.handleCommand(false, "forward", mockEditor as any);

    expect(currentSession.query).toBe("");
    expect(getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input")?.value).toBe("");
  });

  it("starts empty when the open bar belongs to another note", () => {
    plugin.settings.lastQuery = "previous search";
    const otherNote = makeEditor(recallDoc);
    plugin.handleCommand(false, "forward", otherNote as any);
    const otherSession = currentSession;

    // A stale session in this note must not be treated as a repeat press of the other bar.
    const thisNote = makeEditor(recallDoc);
    currentSession = { ...otherSession, query: "" };
    plugin.handleCommand(false, "forward", thisNote as any);

    expect(currentSession.query).toBe("");
    const widget = getActiveWidget();
    expect(widget?.parentElement?.contains(thisNote.cm.dom)).toBe(true);
    expect(widget?.querySelector<HTMLInputElement>(".incsearch-input")?.value).toBe("");
  });

  it("advances backward if reverse command is invoked during active search", () => {
    const mockEditor = makeEditor();
    plugin.handleCommand(false, "forward", mockEditor as any);
    currentSession = {
      query: "test",
      direction: "forward", // initially forward
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    // Trigger backward search
    plugin.handleCommand(false, "backward", mockEditor as any);

    expect(currentSession.direction).toBe("backward"); // switches direction
    expect(currentSession.activeIndex).toBe(1); // wrapped around from 0 to 1
  });

  it("handles onunload lifecycle cleanly", () => {
    expect(() => plugin.onunload()).not.toThrow();
    expect(getActiveWidget()).toBeNull();
  });

  it.each(["compact", "obsidian"])("opens the %s inline interface", (searchInterface) => {
    plugin.settings.searchInterface = searchInterface;

    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          doc: {
            lines: 1,
            line: () => ({ text: "test text", from: 0, to: 9, length: 9 }),
          },
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects && args.effects.value && args.effects.value.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: document.createElement("div") },
      },
    };

    expect(() => {
      plugin.handleCommand(false, "forward", mockEditor as any);
    }).not.toThrow();
    const widget = getActiveWidget();
    expect(widget).not.toBeNull();
    expect(widget?.classList.contains("incsearch-widget-obsidian")).toBe(searchInterface === "obsidian");
    plugin.onunload();
  });

  it("provides declarative setting definitions via getSettingDefinitions()", async () => {
    let settingTabInstance: any = null;
    plugin.addSettingTab = (tab: any) => {
      settingTabInstance = tab;
    };
    await plugin.onload();

    expect(settingTabInstance).not.toBeNull();
    expect(typeof settingTabInstance.getSettingDefinitions).toBe("function");
    const definitions = settingTabInstance.getSettingDefinitions();
    expect(Array.isArray(definitions)).toBe(true);
    expect(definitions.length).toBeGreaterThan(0);
    // Every control-based row must carry a control with a settings key.
    for (const def of definitions) {
      if (def.control) {
        expect(typeof def.control.key).toBe("string");
        expect(typeof def.control.type).toBe("string");
      }
    }
  });

  it("handles PDF view commands via checkCallback", () => {
    const mockDoc = {
      numPages: 1,
      getPage: async () => ({
        pageNumber: 1,
        getTextContent: async () => ({ items: [{ str: "Sample text" }] }),
        getViewport: () => ({ width: 600, height: 800 }),
      }),
    };

    const containerEl = document.createElement("div");
    const mockPdfView = {
      getViewType: () => "pdf",
      contentEl: containerEl,
      viewer: {
        child: {
          pdfViewer: {
            pdfViewer: {
              pdfDocument: mockDoc,
              pagesCount: 1,
            },
          },
        },
      },
    };

    plugin.app.workspace.getActiveViewOfType = () => mockPdfView;

    // Check checking = true
    const canSearch = commands["forward"].checkCallback(true);
    expect(canSearch).toBe(true);

    // Execute command checking = false
    commands["forward"].checkCallback(false);
    expect(plugin.pdfController).not.toBeNull();
    expect(getActiveWidget()).not.toBeNull();
  });

  describe("initial PDF query", () => {
    const openPdfWithSelection = (selectInsidePdf: boolean) => {
      plugin.settings.searchInterface = "obsidian";
      const viewContent = document.createElement("div");
      viewContent.className = "view-content";
      const pdfText = viewContent.createSpan({ text: "effects into context,\nthey were compared" });
      const otherNote = document.createElement("div");
      const otherText = otherNote.createSpan({ text: "text from another note" });
      document.body.append(viewContent, otherNote);
      const range = document.createRange();
      range.selectNodeContents(selectInsidePdf ? pdfText : otherText);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      plugin.app.workspace.getActiveViewOfType = () => ({
        getViewType: () => "pdf",
        contentEl: viewContent,
        viewer: {
          child: { pdfViewer: { pdfViewer: { pdfDocument: { numPages: 1 }, pagesCount: 1 } } },
        },
      });
      commands["forward"].checkCallback(false);
      const input = getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input");
      selection.removeAllRanges();
      viewContent.remove();
      otherNote.remove();
      return input;
    };

    it("starts empty when the selected text is outside the PDF", () => {
      const input = openPdfWithSelection(false);
      expect(input?.value).toBe("");
      expect(plugin.pdfController?.state.query).toBe("");
    });

    it("seeds from a selection inside the PDF, joining line breaks", () => {
      const input = openPdfWithSelection(true);
      expect(input?.value).toBe("effects into context, they were compared");
    });

    it("keeps the bar focused when a repeat press recalls lastQuery", () => {
      plugin.settings.searchInterface = "obsidian";
      plugin.settings.lastQuery = "bob";
      const viewContent = document.createElement("div");
      viewContent.className = "view-content";
      const viewer = viewContent.createDiv({ attr: { tabindex: "0" } });
      document.body.append(viewContent);
      const pdfView = {
        getViewType: () => "pdf",
        contentEl: viewContent,
        viewer: {
          child: { pdfViewer: { pdfViewer: { pdfDocument: { numPages: 1 }, pagesCount: 1 } } },
        },
      };
      plugin.app.workspace.getActiveViewOfType = () => pdfView;
      try {
        commands["forward"].checkCallback(false);
        const input = getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input");
        expect(input?.value).toBe("");
        const search = vi.spyOn(plugin.pdfController!, "search").mockResolvedValue(undefined);
        // Scrolling to the recalled match moves focus into the PDF viewer.
        viewer.focus();

        commands["forward"].checkCallback(false);

        expect(search).toHaveBeenCalledWith("bob", "forward");
        expect(input?.value).toBe("bob");
        expect(document.activeElement).toBe(input);
      } finally {
        viewContent.remove();
      }
    });

    it("hands the accepted match position to the next search in the same PDF only", () => {
      plugin.settings.searchInterface = "obsidian";
      plugin.settings.searchExitBehavior = "emacs";
      const viewContent = document.createElement("div");
      viewContent.className = "view-content";
      document.body.append(viewContent);
      const makePdfView = (path: string) => ({
        getViewType: () => "pdf",
        file: { path },
        contentEl: viewContent,
        viewer: {
          child: { pdfViewer: { pdfViewer: { pdfDocument: { numPages: 1 }, pagesCount: 1 } } },
        },
      });
      const paperA = makePdfView("a.pdf");
      const paperB = makePdfView("b.pdf");
      const accepted = { pageNumber: 3, x: 0.25, y: 0.5 };
      try {
        plugin.app.workspace.getActiveViewOfType = () => paperA;
        commands["forward"].checkCallback(false);
        expect(plugin.pdfController?.startAfter).toBeNull();
        const controller = plugin.pdfController!;
        vi.spyOn(controller, "accept").mockImplementation(() => {
          controller.acceptedPosition = accepted;
        });
        getActiveWidget()!.querySelector<HTMLInputElement>(".incsearch-input")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        expect(getActiveWidget()).toBeNull();

        commands["forward"].checkCallback(false);
        expect(plugin.pdfController?.startAfter).toEqual(accepted);
        // Cancelling keeps the previously accepted position, like Markdown's cursor.
        getActiveWidget()!.querySelector<HTMLInputElement>(".incsearch-input")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

        plugin.app.workspace.getActiveViewOfType = () => paperB;
        commands["forward"].checkCallback(false);
        expect(plugin.pdfController?.startAfter).toBeNull();
        removeWidget();

        plugin.app.workspace.getActiveViewOfType = () => paperA;
        commands["forward"].checkCallback(false);
        expect(plugin.pdfController?.startAfter).toEqual(accepted);
      } finally {
        viewContent.remove();
      }
    });

    it("starts empty instead of recalling lastQuery after the PDF bar was closed elsewhere", () => {
      plugin.settings.lastQuery = "previous search";
      openPdfWithSelection(false);
      const staleController = plugin.pdfController;
      const pdfView = plugin.activePdfView;
      removeWidget(); // e.g. a click in another pane removes the bar but keeps the controller

      plugin.invokePdf(pdfView, "forward");

      expect(plugin.pdfController).not.toBe(staleController);
      expect(plugin.pdfController?.state.query).toBe("");
      expect(getActiveWidget()?.querySelector<HTMLInputElement>(".incsearch-input")?.value).toBe("");
    });
  });

  it("routes search correctly when PDF and Markdown note are open side-by-side", () => {
    const mockPdfView = {
      getViewType: () => "pdf",
      contentEl: document.createElement("div"),
      viewer: {
        child: {
          pdfViewer: {
            pdfViewer: {
              pdfDocument: { numPages: 1 },
              pagesCount: 1,
            },
          },
        },
      },
    };

    const mockMarkdownEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          doc: {
            lines: 1,
            line: () => ({ text: "markdown text", from: 0, to: 13, length: 13 }),
          },
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects?.value?.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: document.createElement("div") },
      },
    };

    const mockMarkdownView = {
      getViewType: () => "markdown",
      editor: mockMarkdownEditor,
    };

    // When the active leaf is the Markdown note side
    plugin.app.workspace.activeLeaf = { view: mockMarkdownView };
    plugin.app.workspace.activeEditor = { editor: mockMarkdownEditor };

    commands["forward"].checkCallback(false);

    // It should invoke markdown search session, NOT pdfController
    expect(plugin.pdfController).toBeNull();
    expect(currentSession).not.toBeNull();
    expect(currentSession.direction).toBe("forward");
  });

  it("switches immediately from markdown search to PDF search on first trigger when PDF leaf is active", () => {
    // 1. First open markdown search
    const mockMarkdownEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          doc: {
            lines: 1,
            line: () => ({ text: "markdown text", from: 0, to: 13, length: 13 }),
          },
        },
        dispatch: (args: any) => {
          if (args.effects?.value?.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: document.createElement("div") },
      },
    };
    const markdownLeaf = {
      view: { getViewType: () => "markdown", editor: mockMarkdownEditor },
      containerEl: document.createElement("div"),
    };
    plugin.app.workspace.activeLeaf = markdownLeaf;
    commands["forward"].checkCallback(false);
    expect(currentSession).not.toBeNull();

    // 2. Now user clicks/activates PDF leaf
    const mockPdfView = {
      getViewType: () => "pdf",
      contentEl: document.createElement("div"),
      viewer: {
        child: {
          pdfViewer: {
            pdfViewer: {
              pdfDocument: {
                numPages: 1,
                getPage: async () => ({
                  pageNumber: 1,
                  getTextContent: async () => ({ items: [] }),
                  getViewport: () => ({ width: 600, height: 800 }),
                }),
              },
              pagesCount: 1,
            },
          },
        },
      },
    };
    const pdfLeaf = {
      view: mockPdfView,
      containerEl: document.createElement("div"),
    };
    pdfLeaf.containerEl.classList.add("mod-active");
    plugin.app.workspace.activeLeaf = pdfLeaf;

    // Trigger forward search
    commands["forward"].checkCallback(false);

    // Should immediately initialize PDF controller and dismiss markdown search
    expect(plugin.pdfController).not.toBeNull();
    expect(plugin.activePdfView).toBe(mockPdfView);
  });

  it("migrates legacy boolean highlightAllMatches: true to allMatchesDisplayMode: 'always'", async () => {
    plugin.loadData = async () => ({
      highlightAllMatches: true,
    });
    await plugin.loadSettings();
    expect(plugin.settings.allMatchesDisplayMode).toBe("always");
    expect(plugin.settings.highlightAllMatches).toBeUndefined();
  });

  it("migrates legacy boolean highlightAllMatches: false to allMatchesDisplayMode: 'off'", async () => {
    plugin.loadData = async () => ({
      highlightAllMatches: false,
    });
    await plugin.loadSettings();
    expect(plugin.settings.allMatchesDisplayMode).toBe("off");
    expect(plugin.settings.highlightAllMatches).toBeUndefined();
  });

  it("defaults allMatchesDisplayMode to 'on-demand' when not specified", async () => {
    plugin.loadData = async () => ({});
    await plugin.loadSettings();
    expect(plugin.settings.allMatchesDisplayMode).toBe("on-demand");
    expect(plugin.settings.secondaryHighlightStyle).toBe("adaptive");
    expect(plugin.settings.secondaryProminence).toBe(0.75);
    expect(plugin.settings.secondaryEnforceLegibility).toBe(true);
  });

  it.each([
    [{}, "compact"],
    [{ usePopupModal: false }, "compact"],
    [{ usePopupModal: true }, "compact"],
    [{ searchInterface: "popup" }, "compact"],
    [{ searchInterface: "compact" }, "compact"],
    [{ searchInterface: "obsidian" }, "obsidian"],
    [{ usePopupModal: true, searchInterface: "obsidian" }, "obsidian"],
  ])("migrates interface preferences from %j to %s", async (stored, expected) => {
    plugin.loadData = async () => stored;
    await plugin.loadSettings();
    expect(plugin.settings.searchInterface).toBe(expected);
    expect(plugin.settings.usePopupModal).toBeUndefined();
  });

  it("persists popup migration without resetting other search preferences", async () => {
    const save = vi.fn();
    plugin.saveData = save;
    plugin.loadData = async () => ({
      searchInterface: "popup",
      usePopupModal: true,
      searchExitBehavior: "obsidian",
      allMatchesDisplayMode: "off",
      lastQuery: "remember me",
    });
    await plugin.loadSettings();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      searchInterface: "compact",
      searchExitBehavior: "obsidian",
      allMatchesDisplayMode: "off",
      lastQuery: "remember me",
    }));
    expect(save.mock.calls[0][0]).not.toHaveProperty("usePopupModal");
  });

  it("normalizes persisted Off to On demand only for the Obsidian-style bar", async () => {
    plugin.loadData = async () => ({ searchInterface: "obsidian", allMatchesDisplayMode: "off" });
    await plugin.loadSettings();
    expect(plugin.settings.allMatchesDisplayMode).toBe("on-demand");
    plugin.loadData = async () => ({ searchInterface: "compact", allMatchesDisplayMode: "off" });
    await plugin.loadSettings();
    expect(plugin.settings.allMatchesDisplayMode).toBe("off");
  });

  it("groups settings and updates conditional controls without losing their values", async () => {
    let tab: any;
    plugin.addSettingTab = (value: any) => { tab = value; };
    await plugin.onload();
    expect(tab.getSettingDefinitions().every((group: any) => group.cls === "incsearch-settings-group")).toBe(true);
    expect(tab.getSettingDefinitions().map((group: any) => [group.type, group.heading])).toEqual([
      ["group", "Interface"],
      ["group", "Matching"],
      ["group", "Navigation & exit"],
      ["group", "Match highlighting"],
      ["group", "Troubleshooting"],
    ]);
    const rows = () => tab.getSettingDefinitions().flatMap((group: any) => group.items);
    const byName = (name: string) => rows().find((row: any) => row.name === name);
    expect(byName("Search keyboard behavior").control.options).toEqual({
      emacs: "Emacs-style", obsidian: "Obsidian-style",
    });
    expect(byName("Secondary match highlight style").control.options.adaptive).toBe("Adaptive");
    plugin.settings.allMatchesDisplayMode = "off";
    plugin.settings.secondaryCustomLightColor = "#abcdef";
    await tab.setControlValue("searchInterface", "obsidian");
    expect(plugin.settings.allMatchesDisplayMode).toBe("on-demand");
    expect(byName("Highlight all matches").control.options.off).toBeUndefined();
    expect(byName("Search interface").control.options).toEqual({
      compact: "Compact", obsidian: "Obsidian-style bar",
    });
    await tab.setControlValue("searchInterface", "compact");
    expect(byName("Highlight all matches").control.options.off).toBe("Off");
    await tab.setControlValue("allMatchesDisplayMode", "off");
    for (const name of ["Secondary match highlight style", "Secondary match prominence", "Enforce text legibility (WCAG)", "Custom color (Light theme)", "Custom color (Dark theme)", "Highlighting live preview"]) {
      expect(byName(name).visible(), name).toBe(false);
    }
    await tab.setControlValue("allMatchesDisplayMode", "on-demand");
    await tab.setControlValue("secondaryHighlightStyle", "underline");
    expect(byName("Enforce text legibility (WCAG)").visible()).toBe(false);
    await tab.setControlValue("secondaryHighlightStyle", "theme");
    expect(byName("Enforce text legibility (WCAG)").visible()).toBe(false);
    await tab.setControlValue("secondaryHighlightStyle", "custom");
    expect(byName("Enforce text legibility (WCAG)").visible()).toBe(true);
    expect(byName("Custom color (Light theme)").visible()).toBe(true);
    expect(plugin.settings.secondaryCustomLightColor).toBe("#abcdef");
  });

  it("migrates legacy boolean fuzzyMode to spaceAsWildcard", async () => {
    plugin.loadData = async () => ({
      fuzzyMode: false,
    });
    await plugin.loadSettings();
    expect(plugin.settings.spaceAsWildcard).toBe(false);
    expect((plugin.settings as any).fuzzyMode).toBeUndefined();
  });

  it("exposes secondary highlight controls as declarative definitions", async () => {
    let tab: any = null;
    plugin.addSettingTab = (t: any) => {
      tab = t;
    };
    await plugin.onload();
    expect(tab).not.toBeNull();

    const definitions = tab.getSettingDefinitions().flatMap((group: any) => group.items);
    const byName = (name: string) => definitions.find((d: any) => d.name === name);
    const styleDef = byName("Secondary match highlight style");
    const prominenceDef = byName("Secondary match prominence");
    const lightDef = byName("Custom color (Light theme)");
    const darkDef = byName("Custom color (Dark theme)");

    expect(styleDef?.control.type).toBe("dropdown");
    expect(prominenceDef?.control).toMatchObject({ type: "slider", min: 20, max: 100, step: 5 });
    expect(lightDef?.control.type).toBe("text");
    expect(darkDef?.control.type).toBe("text");

    // The custom-color rows are visibility-gated on the "custom" style.
    plugin.settings.secondaryHighlightStyle = "adaptive";
    expect(lightDef.visible()).toBe(false);
    expect(darkDef.visible()).toBe(false);
    plugin.settings.secondaryHighlightStyle = "custom";
    expect(lightDef.visible()).toBe(true);
    expect(darkDef.visible()).toBe(true);

    // Prominence is persisted as a 0..1 fraction but surfaced as a percentage.
    plugin.settings.secondaryProminence = 0.75;
    expect(tab.getControlValue(prominenceDef.control.key)).toBe(75);
    await tab.setControlValue(prominenceDef.control.key, 40);
    expect(plugin.settings.secondaryProminence).toBeCloseTo(0.4);
  });

  it("refreshes PDF colors on all open PDF leaves when settings change", () => {
    const applySpy = vi.spyOn(colors, "applyPdfColors").mockImplementation(() => {});
    const containerEl = document.createElement("div");
    const mockPdfView = {
      getViewType: () => "pdf",
      contentEl: containerEl,
      viewer: {
        child: {
          pdfViewer: {
            pdfViewer: {
              pdfDocument: { numPages: 1 },
              pagesCount: 1,
            },
          },
        },
      },
    };
    const pdfLeaf = {
      view: mockPdfView,
      containerEl,
    };
    const markdownLeaf = {
      view: { getViewType: () => "markdown" },
      containerEl: document.createElement("div"),
    };

    plugin.app.workspace.iterateAllLeaves = (cb: any) => {
      cb(pdfLeaf);
      cb(markdownLeaf);
    };

    plugin.refreshAllPdfColors();

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(containerEl, plugin.settings);
    applySpy.mockRestore();
  });

  it("skips PDF color refresh when iterateAllLeaves is unavailable", () => {
    const applySpy = vi.spyOn(colors, "applyPdfColors").mockImplementation(() => {});
    plugin.app.workspace.iterateAllLeaves = undefined;

    expect(() => plugin.refreshAllPdfColors()).not.toThrow();
    expect(applySpy).not.toHaveBeenCalled();
    applySpy.mockRestore();
  });
});

describe("IncrementalSearchPlugin multi-window (pop-out) handling", () => {
  let handlers: Record<string, (...args: any[]) => void>;
  let leaves: any[];
  let plugin: any;
  let registered: Array<{ el: any; type: string }>;

  const realActiveDocument = Object.getOwnPropertyDescriptor(globalThis, "activeDocument");

  beforeEach(async () => {
    handlers = {};
    leaves = [];
    registered = [];
    const app = {
      workspace: {
        on: (name: string, cb: any) => {
          handlers[name] = cb;
        },
        onLayoutReady: (cb: any) => cb(),
        iterateAllLeaves: (cb: any) => leaves.forEach(cb),
        getActiveFile: () => null,
      },
      metadataCache: { getFileCache: () => null },
    };
    plugin = new IncrementalSearchPlugin(app as any, {} as any);
    plugin.addCommand = () => {};
    plugin.registerDomEvent = (el: any, type: string) => registered.push({ el, type });
    plugin.loadData = async () => ({});
    plugin.saveData = async () => {};
    await plugin.onload();
  });

  afterEach(() => {
    if (realActiveDocument) Object.defineProperty(globalThis, "activeDocument", realActiveDocument);
  });

  it("hooks pointerdown/mousedown on the main document and on each newly opened pop-out document once", () => {
    expect(registered.filter((r) => r.el === document).map((r) => r.type).sort()).toEqual([
      "mousedown",
      "pointerdown",
    ]);

    const popout = document.implementation.createHTMLDocument("popout");
    handlers["window-open"]({}, { document: popout });
    handlers["window-open"]({}, { document: popout }); // duplicate event must not double-register

    expect(registered.filter((r) => r.el === popout).map((r) => r.type).sort()).toEqual([
      "mousedown",
      "pointerdown",
    ]);
  });

  it("hooks pop-out documents that already exist at layout-ready time", async () => {
    const popout = document.implementation.createHTMLDocument("popout");
    const leafEl = popout.createElement("div");
    leaves.push({ containerEl: leafEl, view: {} });
    registered.length = 0;
    handlers = {};
    plugin.app.workspace.onLayoutReady = (cb: any) => cb();
    // Re-run onload so layout-ready sees the existing pop-out leaf.
    await plugin.onload();
    expect(registered.some((r) => r.el === popout && r.type === "pointerdown")).toBe(true);
  });

  it("resolves the search target from the active (pop-out) document, not the main one", () => {
    const popout = document.implementation.createHTMLDocument("popout");
    const popoutLeafEl = popout.createElement("div");
    const popoutInput = popout.createElement("div");
    popoutLeafEl.appendChild(popoutInput);
    popout.body.appendChild(popoutLeafEl);

    const mainEditor = { cm: {}, id: "main" };
    const popoutEditor = { cm: {}, id: "popout" };
    const mainLeaf = { containerEl: document.createElement("div"), view: { editor: mainEditor } };
    const popoutLeaf = { containerEl: popoutLeafEl, view: { editor: popoutEditor } };
    leaves.push(mainLeaf, popoutLeaf);

    // The user last clicked the main-window leaf, but focus is now inside the pop-out.
    plugin.lastInteractedLeaf = mainLeaf;
    Object.defineProperty(popout, "activeElement", { get: () => popoutInput, configurable: true });
    Object.defineProperty(globalThis, "activeDocument", { get: () => popout, configurable: true });

    const target = plugin.getActiveTarget();
    expect(target).toEqual({ type: "editor", editor: popoutEditor });
  });
});