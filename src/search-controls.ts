import { Platform, type App } from "obsidian";
import { getCommandHotkeyLabel, type KeyHint } from "commons/modal";
import type { IncrementalSearchSettings } from "./types";

export function searchKeyHints(settings: IncrementalSearchSettings, app?: App): KeyHint[] {
	const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
	const commandHint = (direction: "forward" | "backward", action: string): KeyHint => {
		const key = app ? getCommandHotkeyLabel(app, `incremental-search:${direction}`) : "";
		return key ? { key, action } : { key: "Unassigned", action, disabled: true };
	};
	const hints: KeyHint[] = settings.searchExitBehavior === "obsidian"
		? [
			{ key: "Enter", action: "Next" },
			{ key: "Shift+Enter", action: "Previous" },
			{ key: "Esc", action: "Accept" },
			{ key: `${mod}+G`, action: "Cancel & restore" },
		]
		: [
			commandHint("forward", "Next"),
			commandHint("backward", "Previous"),
			{ key: "Enter", action: "Accept" },
			{ key: "Esc", action: "Cancel" },
			{ key: `${mod}+G`, action: "Cancel & restore" },
		];
	if (settings.allMatchesDisplayMode === "on-demand") {
		hints.push({ key: `${mod}+Enter`, action: "Highlights" });
	}
	return hints;
}
