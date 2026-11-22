export interface PdfTextItem {
	str: string;
	transform: number[];
	width: number;
	height: number;
}

interface PositionedItem {
	offset: number;
	x: number;
	y: number;
	height: number;
	dx: number;
	dy: number;
}

function isPositionedItem(item: PdfTextItem): boolean {
	return item.transform.length >= 6 &&
		item.transform.every(Number.isFinite) &&
		Math.hypot(item.transform[0], item.transform[1]) > 0 &&
		Number.isFinite(item.height) && item.height > 0;
}

function isColumnTransition(previous: PositionedItem, next: PositionedItem, items: PositionedItem[]): boolean {
	const height = Math.max(previous.height, next.height);
	if (Math.abs(previous.dy) > 0.15 || Math.abs(next.dy) > 0.15) return false;
	if (next.x - previous.x < height * 8 || next.y <= previous.y) return false;

	const columnLines = (item: PositionedItem) => {
		const lines: number[] = [];
		for (const candidate of items) {
			if (Math.abs(candidate.x - item.x) > height * 2 ||
				Math.abs(candidate.dy) > 0.15 ||
				Math.abs(candidate.height - item.height) > height * 0.25) continue;
			if (!lines.some((y) => Math.abs(y - candidate.y) < height * 0.5)) {
				lines.push(candidate.y);
			}
		}
		return lines;
	};
	const left = columnLines(previous);
	const right = columnLines(next);
	return left.length >= 3 && right.length >= 3 &&
		previous.y <= Math.min(...left) + height * 3 &&
		next.y >= Math.max(...right) - height * 3;
}

/**
 * Offsets are in PDF.js's original text-layer character space, excluding EOL
 * markers. A missing position breaks the comparison rather than guessing.
 */
export function findDisjointTextOffsets(items: PdfTextItem[]): number[] {
	let offset = 0;
	const positioned: PositionedItem[] = [];
	const ordered: Array<PositionedItem | null> = [];
	for (const item of items) {
		if (!item.str) continue;
		if (isPositionedItem(item)) {
			const baselineLength = Math.hypot(item.transform[0], item.transform[1]);
			const entry = {
				offset,
				x: item.transform[4],
				y: item.transform[5],
				height: item.height,
				dx: item.transform[0] / baselineLength,
				dy: item.transform[1] / baselineLength,
			};
			positioned.push(entry);
			ordered.push(entry);
		} else {
			ordered.push(null);
		}
		offset += item.str.length;
	}

	const boundaries: number[] = [];
	for (let i = 1; i < ordered.length; i++) {
		const previous = ordered[i - 1];
		const next = ordered[i];
		if (!previous || !next) continue;
		const height = Math.max(previous.height, next.height);
		const dot = previous.dx * next.dx + previous.dy * next.dy;
		if (dot < 0.98) continue;
		const lineDistance = Math.abs(
			(next.x - previous.x) * -previous.dy + (next.y - previous.y) * previous.dx
		);
		if (lineDistance > 20 * height &&
			!isColumnTransition(previous, next, positioned)) {
			boundaries.push(next.offset);
		}
	}
	return boundaries;
}

function isNumericArray(value: unknown): value is ArrayLike<number> {
	return ArrayBuffer.isView(value) && "length" in value && typeof value.length === "number";
}

/** Map text-layer offsets back into the normalized text supplied to match(). */
export function normalizedDisjointOffsets(
	text: string,
	offsets: number[],
	diffs: unknown
): number[] | null {
	if (offsets.length === 0) return [];
	if (!Array.isArray(diffs) || diffs.length === 0) return null;

	let starts: ArrayLike<number>;
	let shifts: ArrayLike<number>;
	if (diffs.length === 2 && isNumericArray(diffs[0]) && isNumericArray(diffs[1])) {
		starts = diffs[0];
		shifts = diffs[1];
	} else if (diffs.every((entry: unknown) =>
		Array.isArray(entry) && entry.length === 2 && entry.every(Number.isFinite))) {
		const pairs = diffs as Array<[number, number]>;
		starts = pairs.map((pair) => pair[0]);
		shifts = pairs.map((pair) => pair[1]);
	} else {
		return null;
	}
	if (starts.length === 0 || starts.length !== shifts.length || starts[0] !== 0) return null;
	for (let i = 0; i < starts.length; i++) {
		if (!Number.isFinite(starts[i]) || !Number.isFinite(shifts[i]) ||
			(i > 0 && starts[i] < starts[i - 1])) return null;
	}

	const originalIndex = (index: number) => {
		let low = 0;
		let high = starts.length;
		while (low + 1 < high) {
			const mid = Math.floor((low + high) / 2);
			if (starts[mid] <= index) low = mid;
			else high = mid;
		}
		return index + shifts[low];
	};
	return offsets.map((offset) => {
		let low = 0;
		let high = text.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (originalIndex(mid) < offset) low = mid + 1;
			else high = mid;
		}
		return low;
	});
}
