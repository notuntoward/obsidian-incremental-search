import { describe, expect, it } from "vitest";
import { Platform } from "obsidian";
import type { App } from "obsidian";
import { searchKeyHints } from "../src/search-controls";
import { DEFAULT_SETTINGS } from "../src/types";

describe("search shortcut hints", () => {
	it("shows current command bindings in Emacs mode, never the F3 aliases", () => {
		const app = {
			hotkeyManager: {
				printHotkeyForCommand: (id: string) => id.endsWith(":forward") ? "Alt + S" : "Alt + R",
			},
		} as unknown as App;
		const hints = searchKeyHints(DEFAULT_SETTINGS, app);
		expect(hints).toContainEqual({ key: "Alt + S", action: "Next" });
		expect(hints).toContainEqual({ key: "Alt + R", action: "Previous" });
		expect(hints.some(({ key }) => key.includes("F3"))).toBe(false);
		const obsidian = searchKeyHints({ ...DEFAULT_SETTINGS, searchExitBehavior: "obsidian" }, app);
		expect(obsidian).toContainEqual({ key: "Enter", action: "Next" });
		expect(obsidian).toContainEqual({ key: "Shift+Enter", action: "Previous" });
		expect(obsidian.some(({ key }) => key.includes("Alt") || key.includes("F3"))).toBe(false);
	});

	it("marks unassigned command shortcuts rather than inventing bindings", () => {
		expect(searchKeyHints(DEFAULT_SETTINGS)).toContainEqual({
			key: "Unassigned", action: "Next", disabled: true,
		});
	});
	it.each([false, true])("uses platform-specific modifiers (mac=%s)", (isMacOS) => {
		const original = Platform.isMacOS;
		Object.defineProperty(Platform, "isMacOS", { value: isMacOS, configurable: true });
		try {
			for (const searchExitBehavior of ["emacs", "obsidian"] as const) {
				for (const allMatchesDisplayMode of ["off", "always", "on-demand"] as const) {
					const hints = searchKeyHints({ ...DEFAULT_SETTINGS, searchExitBehavior, allMatchesDisplayMode });
					expect(hints).toContainEqual({ key: `${isMacOS ? "Cmd" : "Ctrl"}+G`, action: "Cancel & restore" });
					expect(hints.some(({ action }) => action === "Highlights")).toBe(allMatchesDisplayMode === "on-demand");
					expect(hints).toContainEqual({ key: "Esc", action: searchExitBehavior === "emacs" ? "Cancel" : "Accept" });
				}
			}
		} finally {
			Object.defineProperty(Platform, "isMacOS", { value: original, configurable: true });
		}
	});
});
