export type SearchDirection = "forward" | "backward";
export type AllMatchesDisplayMode = "always" | "on-demand" | "off";

export function shouldShowAllMatches(
	mode: AllMatchesDisplayMode = "on-demand",
	isDemandPeekActive = false
): boolean {
	switch (mode) {
		case "always":
			return true;
		case "on-demand":
			return isDemandPeekActive;
		case "off":
			return false;
	}
}

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

export interface SearchQueryOptions {
	spaceAsWildcard?: boolean;
	wildcard?: boolean;
	fuzzy?: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	maxGapChars?: number;
	regexMode?: boolean;
}

export interface CompiledQuery {
	rawQuery: string;
	type: "regex" | "wildcard" | "literal";
	caseSensitive: boolean;
	wholeWord: boolean;
	maxGapChars?: number;
	regex?: RegExp;
	tokens?: string[];
	needle?: string;
}

export interface SearchSessionState {
	query: string;
	direction: SearchDirection;
	matches: MatchRange[];
	activeIndex: number;
	originSelection: { anchor: number; head: number };
	allMatchesDisplayMode?: AllMatchesDisplayMode;
	isDemandPeekActive?: boolean;
}

export type SearchExitBehavior = "emacs" | "obsidian";
export type SecondaryHighlightStyle = "adaptive" | "underline" | "tint" | "theme" | "custom";

export interface IncrementalSearchSettings {
	lastQuery: string;
	doubleTapWindowMs: number;
	spaceAsWildcard: boolean;
	usePopupModal: boolean;
	matchOnlyVisibleLinks: boolean;
	allMatchesDisplayMode: AllMatchesDisplayMode;
	searchExitBehavior: SearchExitBehavior;
	secondaryHighlightStyle: SecondaryHighlightStyle;
	secondaryProminence: number;
	secondaryEnforceLegibility: boolean;
	secondaryCustomLightColor: string;
	secondaryCustomDarkColor: string;
}

export const DEFAULT_SETTINGS: IncrementalSearchSettings = {
	lastQuery: "",
	doubleTapWindowMs: 600,
	spaceAsWildcard: true,
	usePopupModal: false,
	matchOnlyVisibleLinks: true,
	allMatchesDisplayMode: "on-demand",
	searchExitBehavior: "emacs",
	secondaryHighlightStyle: "adaptive",
	secondaryProminence: 0.75,
	secondaryEnforceLegibility: true,
	secondaryCustomLightColor: "",
	secondaryCustomDarkColor: "",
};
