// Emulate Obsidian's global activeDocument/activeWindow (the window currently focused).
Object.defineProperty(globalThis, 'activeDocument', { get: () => document, configurable: true });
Object.defineProperty(globalThis, 'activeWindow', { get: () => window, configurable: true });
