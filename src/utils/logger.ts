/**
 * Diagnostic logger for Obsidian Incremental Search.
 * Records timestamped trace events in console and in an in-memory circular buffer
 * accessible via `window.IncSearchLog` / `window.getIncSearchLogs()`.
 */

export interface LogEntry {
	timestamp: string;
	timeMs: number;
	category: string;
	message: string;
	details?: any;
}

const MAX_LOG_ENTRIES = 200;
const logBuffer: LogEntry[] = [];

function formatTime(d = new Date()): string {
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Safely describes a DOM element for logging purposes (e.g. `input.incsearch-input#id`).
 */
export function describeElement(el: Element | null | undefined): string {
	if (!el) return "<null>";
	const tag = el.tagName.toLowerCase();
	const id = el.id ? `#${el.id}` : "";
	const cls = el.className && typeof el.className === "string"
		? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
		: "";
	return `<${tag}${id}${cls}>`;
}

/**
 * Records a diagnostic log event.
 */
export function logDebug(category: string, message: string, details?: any) {
	const now = new Date();
	const entry: LogEntry = {
		timestamp: formatTime(now),
		timeMs: now.getTime(),
		category,
		message,
		details,
	};

	logBuffer.push(entry);
	if (logBuffer.length > MAX_LOG_ENTRIES) {
		logBuffer.shift();
	}

	if (details !== undefined) {
		console.log(`[IncSearch:${category}] ${entry.timestamp} ${message}`, details);
	} else {
		console.log(`[IncSearch:${category}] ${entry.timestamp} ${message}`);
	}
}

/**
 * Formats recent logs as a readable multiline text block.
 */
export function getRecentLogs(): string[] {
	return logBuffer.map((e) => {
		const detailStr = e.details !== undefined ? ` | ${JSON.stringify(e.details)}` : "";
		return `[${e.timestamp}] [${e.category}] ${e.message}${detailStr}`;
	});
}

/**
 * Clears the in-memory log buffer.
 */
export function clearLogs(): void {
	logBuffer.length = 0;
}

// Expose on global window object for easy inspection in Developer Console
if (typeof window !== "undefined") {
	(window as any).IncSearchLog = logBuffer;
	(window as any).getIncSearchLogs = () => getRecentLogs().join("\n");
	(window as any).clearIncSearchLogs = clearLogs;
}
