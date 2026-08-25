export type SearchDirection = "forward" | "backward";

export interface MatchRange {
	from: number;
	to: number;
	chars?: { from: number; to: number }[];
	inTable?: boolean;
	tableMatchData?: {
		sectionStart: number;
		cellText: string;
		matchStartInCell: number;
		matchEndInCell: number;
		rowIndex?: number;
		colIndex?: number;
	};
}

export interface SearchSessionState {
	query: string;
	direction: SearchDirection;
	matches: MatchRange[];
	activeIndex: number;
	originSelection: { anchor: number; head: number };
	highlightAllMatches?: boolean;
}

export type SearchExitBehavior = "emacs" | "obsidian";

export interface IncrementalSearchSettings {
	lastQuery: string;
	doubleTapWindowMs: number;
	fuzzyMode: boolean;
	usePopupModal: boolean;
	matchOnlyVisibleLinks: boolean;
	highlightAllMatches: boolean;
	searchExitBehavior: SearchExitBehavior;
}

export const DEFAULT_SETTINGS: IncrementalSearchSettings = {
	lastQuery: "",
	doubleTapWindowMs: 600,
	fuzzyMode: true,
	usePopupModal: false,
	matchOnlyVisibleLinks: true,
	highlightAllMatches: true,
	searchExitBehavior: "emacs",
};
