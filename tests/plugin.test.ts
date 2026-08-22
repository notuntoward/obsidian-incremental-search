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
      fuzzyMode: true,
      usePopupModal: false,
      lastQuery: "",
    });
    plugin.saveData = async () => {};

    await plugin.onload();
  });

  it("registers forward and backward commands", () => {
    expect(commands["forward"]).toBeDefined();
    expect(commands["backward"]).toBeDefined();
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
    commands["forward"].editorCallback(mockEditor);

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
    commands["forward"].editorCallback(mockEditor);

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
    commands["backward"].editorCallback(mockEditor);

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
    commands["backward"].editorCallback(mockEditor);

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
      commands["forward"].editorCallback(mockEditor);
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
});
