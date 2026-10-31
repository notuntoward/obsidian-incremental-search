import { describe, expect, it } from "vitest";
import { Platform } from "obsidian";
import { searchKeyHints } from "../src/search-controls";
import { DEFAULT_SETTINGS } from "../src/types";

describe("search shortcut hints", () => {
	it.each([false, true])("uses platform-specific modifiers (mac=%s)", (isMacOS) => {
		const original = Platform.isMacOS;
		Object.defineProperty(Platform, "isMacOS", { value: isMacOS, configurable: true });
		try {
			for (const popup of [false, true]) {
				for (const searchExitBehavior of ["emacs", "obsidian"] as const) {
					for (const allMatchesDisplayMode of ["off", "always", "on-demand"] as const) {
						const hints = searchKeyHints({ ...DEFAULT_SETTINGS, searchExitBehavior, allMatchesDisplayMode }, popup);
						expect(hints).toContainEqual({ key: `${isMacOS ? "Cmd" : "Ctrl"}+G`, action: "Cancel & restore" });
						expect(hints.some(({ action }) => action === "Highlights")).toBe(allMatchesDisplayMode === "on-demand");
						expect(hints).toContainEqual({ key: "Esc", action: searchExitBehavior === "emacs" ? "Cancel" : "Accept" });
					}
				}
			}
		} finally {
			Object.defineProperty(Platform, "isMacOS", { value: original, configurable: true });
		}
	});
});
