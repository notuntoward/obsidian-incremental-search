import { Platform } from "obsidian";
import type { KeyHint } from "commons/modal";
import type { IncrementalSearchSettings } from "./types";

export function searchKeyHints(settings: IncrementalSearchSettings, popup = false): KeyHint[] {
	const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
	const hints: KeyHint[] = settings.searchExitBehavior === "obsidian"
		? [
			{ key: "Enter", action: "Next" },
			{ key: "Shift+Enter", action: "Previous" },
			{ key: "Esc", action: "Accept" },
			{ key: `${mod}+G`, action: "Cancel & restore" },
		]
		: [
			{ key: popup ? "Up/Down" : "F3 / Shift+F3", action: popup ? "Select" : "Next / previous" },
			{ key: "Enter", action: "Accept" },
			{ key: "Esc", action: "Cancel" },
			{ key: `${mod}+G`, action: "Cancel & restore" },
		];
	if (settings.allMatchesDisplayMode === "on-demand") {
		hints.push({ key: `${mod}+Enter`, action: "Highlights" });
	}
	return hints;
}
