export type SearchDirection = "forward" | "backward";

export interface MatchRange {
	from: number;
	to: number;
	chars?: { from: number; to: number }[];
}

export interface SearchSessionState {
	query: string;
	direction: SearchDirection;
	matches: MatchRange[];
	activeIndex: number;
	originSelection: { anchor: number; head: number };
}

export interface SwiperSearchSettings {
	lastQuery: string;
	doubleTapWindowMs: number;
	fuzzyMode: boolean;
	usePopupModal: boolean;
}

export const DEFAULT_SETTINGS: SwiperSearchSettings = {
	lastQuery: "",
	doubleTapWindowMs: 600,
	fuzzyMode: true,
	usePopupModal: false,
};
