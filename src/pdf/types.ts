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

export interface PdfScrollPosition {
	scrollTop: number;
	scrollLeft: number;
	pageNumber?: number;
}
