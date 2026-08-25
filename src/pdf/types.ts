import { SearchDirection, MatchRange } from "../types";

export interface PdfTextItem {
	str: string;
	dir?: string;
	width?: number;
	height?: number;
	transform?: number[];
	fontName?: string;
	hasEOL?: boolean;
	domIndex?: number;
}

export interface CharSourceMapping {
	itemIndex: number;
	charOffset: number;
	origLength?: number;
}

export interface PageTextModel {
	pageNumber: number;
	normalizedText: string;
	charMapping: (CharSourceMapping | null)[];
	items: PdfTextItem[];
}

export interface ItemMatchSpan {
	itemIndex: number;
	startOffset: number;
	endOffset: number;
}

export interface MatchRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface NormalizedMatch {
	pageNumber: number;
	start: number;
	end: number;
	chars?: { from: number; to: number }[];
}

export interface PdfMatch {
	id: string;
	pageNumber: number;
	from: number;
	to: number;
	chars?: { from: number; to: number }[];
	itemSpans: ItemMatchSpan[];
	rects?: MatchRect[];
}

export interface PdfSearchOptions {
	fuzzy: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	maxGapChars?: number;
	regexMode?: boolean;
}

export interface PdfSessionState {
	query: string;
	direction: SearchDirection;
	matches: PdfMatch[];
	activeIndex: number;
	highlightAllMatches: boolean;
	isScanning: boolean;
	totalPages: number;
	scannedPages: number;
}
