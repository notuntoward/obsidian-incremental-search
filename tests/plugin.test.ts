import { describe, it, expect, beforeEach } from "vitest";
import IncrementalSearchPlugin from "../src/main";
import { getActiveWidget } from "../src/widget";

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
      usePopupModal: false,
      lastQuery: "",
    });
    plugin.saveData = async () => {};

    await plugin.onload();
  });

  it("registers forward, backward, and accept-match commands", () => {
    expect(commands["forward"]).toBeDefined();
    expect(commands["backward"]).toBeDefined();
    expect(commands["accept-match"]).toBeDefined();
    expect(plugin.settings.searchExitBehavior).toBe("emacs");
  });

  it("checks that accept-match is unavailable when no search is active", () => {
    currentSession = null;
    const canAccept = commands["accept-match"].checkCallback(true);
    expect(canAccept).toBe(false);
  });

  it("handles accept-match command when editor search is active", () => {
    currentSession = {
      query: "test",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          doc: {
            lineAt: () => ({ number: 1, text: "test", from: 0, to: 4 }),
          },
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects) {
            const effects = Array.isArray(args.effects) ? args.effects : [args.effects];
            for (const eff of effects) {
              if (eff?.value === null) {
                currentSession = null;
              }
            }
          }
        },
        dom: { parentElement: document.createElement("div") },
        focus: () => {},
      },
    };

    plugin.app.workspace.activeLeaf = { view: { getViewType: () => "markdown", editor: mockEditor } };

    const canAccept = commands["accept-match"].checkCallback(true);
    expect(canAccept).toBe(true);

    commands["accept-match"].checkCallback(false);
    expect(currentSession).toBeNull();
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

  it("advances the session if one is already active with query", () => {
    currentSession = {
      query: "test",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects && args.effects.value !== undefined && args.effects.value.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: document.createElement("div") },
      },
    };

    // Trigger forward search again (like pressing search command hotkey a second time)
    plugin.handleCommand(false, "forward", mockEditor as any);

    // It should just advance, not reset the query
    expect(currentSession.query).toBe("test");
    expect(currentSession.activeIndex).toBe(1); // advanced to next match
  });

  it("recalls lastQuery when active session query is empty (double-tap recall)", () => {
    plugin.settings.lastQuery = "previous search";

    currentSession = {
      query: "",
      direction: "forward",
      matches: [],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          doc: {
            lines: 1,
            line: (_i: number) => ({ text: "here is a previous search match", from: 0, to: 31, length: 31 }),
          },
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects && args.effects.value !== undefined && args.effects.value.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: document.createElement("div") },
      },
    };

    // Trigger backward search on empty active session -> recalls lastQuery in backward direction
    plugin.handleCommand(false, "backward", mockEditor as any);

    expect(currentSession.query).toBe("previous search");
    expect(currentSession.direction).toBe("backward");
  });

  it("advances backward if reverse command is invoked during active search", () => {
    currentSession = {
      query: "test",
      direction: "forward", // initially forward
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 },
    };

    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
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

    // Trigger backward search
    plugin.handleCommand(false, "backward", mockEditor as any);

    expect(currentSession.direction).toBe("backward"); // switches direction
    expect(currentSession.activeIndex).toBe(1); // wrapped around from 0 to 1
  });

  it("handles onunload lifecycle cleanly", () => {
    expect(() => plugin.onunload()).not.toThrow();
    expect(getActiveWidget()).toBeNull();
  });

  it("opens IncrementalSearchSuggestModal when usePopupModal is enabled", () => {
    plugin.settings.usePopupModal = true;

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
  });

  it("renders and updates settings tab correctly", async () => {
    let settingTabInstance: any = null;
    plugin.addSettingTab = (tab: any) => {
      settingTabInstance = tab;
    };
    await plugin.onload();

    expect(settingTabInstance).not.toBeNull();
    settingTabInstance.containerEl = document.createElement("div");
    expect(() => settingTabInstance.display()).not.toThrow();
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
  });

  it("migrates legacy boolean fuzzyMode to spaceAsWildcard", async () => {
    plugin.loadData = async () => ({
      fuzzyMode: false,
    });
    await plugin.loadSettings();
    expect(plugin.settings.spaceAsWildcard).toBe(false);
    expect((plugin.settings as any).fuzzyMode).toBeUndefined();
  });
});

