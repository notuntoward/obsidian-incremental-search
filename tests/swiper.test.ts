import { describe, it, expect, beforeEach } from 'vitest';
import SwiperSearchPlugin from '../src/main';

// Basic DOM mocks for Node environment
const mockElement = () => ({
  style: {},
  appendChild: () => {},
  addEventListener: () => {},
  focus: () => {},
  select: () => {},
  remove: () => {},
  querySelector: () => null,
  className: "",
  textContent: "",
});

(global as any).document = {
  createElement: mockElement,
  head: { appendChild: () => {} },
  getElementById: () => null
};
(global as any).Event = class {};

describe('SwiperSearchPlugin Hotkey Routing', () => {
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
      }
    };
    plugin = new SwiperSearchPlugin(app as any, {} as any);
    
    // Intercept addCommand to capture the callbacks
    plugin.addCommand = (cmd: any) => {
      commands[cmd.id] = cmd;
    };
    
    // Mock loadSettings
    plugin.loadData = async () => ({ doubleTapWindowMs: 600, fuzzyMode: true, usePopupModal: false });
    plugin.saveData = async () => {};
    
    await plugin.onload();
  });

  it('registers forward and backward commands', () => {
    expect(commands['swiper-search-forward']).toBeDefined();
    expect(commands['swiper-search-backward']).toBeDefined();
  });

  it('starts a new session if none is active', () => {
    const mockEditor = {
      cm: {
        state: {
          selection: { main: { anchor: 0, head: 0 } },
          field: () => currentSession,
          doc: {
            toString: () => "test text",
            lines: 1,
            line: (i: number) => ({ text: "test text", from: 0, to: 9, length: 9 }),
          }
        },
        dispatch: (args: any) => {
          dispatches.push(args);
          if (args.effects && args.effects.value && args.effects.value.query !== undefined) {
            currentSession = args.effects.value;
          }
        },
        dom: { parentElement: mockElement() }
      }
    };

    // Trigger forward search
    commands['swiper-search-forward'].editorCallback(mockEditor);
    
    // It should have dispatched a setSession effect with a new session
    expect(dispatches.length).toBeGreaterThan(0);
    expect(currentSession).not.toBeNull();
    expect(currentSession.direction).toBe('forward');
  });

  it('advances the session if one is already active', () => {
    currentSession = {
      query: "test",
      direction: "forward",
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 }
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
        dom: { parentElement: mockElement() }
      }
    };

    // Trigger forward search again (like pressing Ctrl+S a second time)
    commands['swiper-search-forward'].editorCallback(mockEditor);
    
    // It should just advance, not reset the query
    expect(currentSession.query).toBe("test");
    expect(currentSession.activeIndex).toBe(1); // advanced to next match
  });

  it('advances backward if reverse command is invoked', () => {
    currentSession = {
      query: "test",
      direction: "forward", // initially forward
      matches: [{ from: 0, to: 4 }, { from: 10, to: 14 }],
      activeIndex: 0,
      originSelection: { anchor: 0, head: 0 }
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
        dom: { parentElement: mockElement() }
      }
    };

    // Trigger backward search (like pressing Ctrl+R)
    commands['swiper-search-backward'].editorCallback(mockEditor);
    
    expect(currentSession.direction).toBe("backward"); // switches direction
    expect(currentSession.activeIndex).toBe(1); // wrapped around from 0 to 1
  });
});
