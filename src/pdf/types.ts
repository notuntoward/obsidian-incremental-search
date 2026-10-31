import { SearchDirection, AllMatchesDisplayMode } from "../types";

export interface PdfSessionState {
	query: string;
	direction: SearchDirection;
	activeIndex: number;
	allMatchesDisplayMode: AllMatchesDisplayMode;
	isDemandPeekActive: boolean;
	isScanning: boolean;
	totalMatchesCount?: number;
}

export interface PdfViewportAnchor {
	topPageNumber: number;
	topPageY: number;
	topPageX: number;
	bottomPageNumber: number;
	bottomPageY: number;
	bottomPageX: number;
}

/**
 * Where the last accepted match sits, as fractions of its page's width and height
 * so the position survives zoom changes. The next search in the same PDF starts
 * after it (like the Markdown cursor) while it is still in view.
 */
export interface PdfMatchPosition {
	pageNumber: number;
	x: number;
	y: number;
	/** The query and 0-based match number (as in the counter) of the accepted match. */
	query?: string;
	activeIndex?: number;
}

export interface PdfScrollPosition {
	scrollTop: number;
	scrollLeft: number;
	pageNumber?: number;
}
