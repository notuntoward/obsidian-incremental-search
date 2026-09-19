import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	logDebug,
	describeElement,
	getRecentLogs,
	clearLogs,
	setDebugLogging,
	isDebugLoggingEnabled,
} from "../src/utils/logger";

describe("utils: logger", () => {
	beforeEach(() => {
		clearLogs();
	});

	afterEach(() => {
		setDebugLogging(false);
		vi.restoreAllMocks();
	});

	it("describes DOM elements safely", () => {
		expect(describeElement(null)).toBe("<null>");
		expect(describeElement(undefined)).toBe("<null>");

		const div = document.createElement("div");
		expect(describeElement(div)).toBe("<div>");

		const input = document.createElement("input");
		input.className = "incsearch-input active";
		input.id = "search-box";
		expect(describeElement(input)).toBe("<input#search-box.incsearch-input.active>");
	});

	it("records log entries and formats recent logs", () => {
		logDebug("test", "first message");
		logDebug("test", "second message", { foo: "bar" });

		const logs = getRecentLogs();
		expect(logs).toHaveLength(2);
		expect(logs[0]).toContain("[test] first message");
		expect(logs[1]).toContain("[test] second message | {\"foo\":\"bar\"}");
	});

	it("clears logs correctly", () => {
		logDebug("test", "message");
		expect(getRecentLogs()).toHaveLength(1);
		clearLogs();
		expect(getRecentLogs()).toHaveLength(0);
	});

	it("does not write to the console by default but still buffers entries", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(isDebugLoggingEnabled()).toBe(false);
		logDebug("test", "silent message");
		logDebug("test", "silent message with details", { foo: "bar" });

		expect(spy).not.toHaveBeenCalled();
		expect(getRecentLogs()).toHaveLength(2);
	});

	it("writes to the console once debug logging is enabled", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});

		setDebugLogging(true);
		expect(isDebugLoggingEnabled()).toBe(true);
		logDebug("test", "loud message");
		logDebug("test", "loud message with details", { foo: "bar" });

		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[0][0]).toContain("[IncSearch:test]");
		expect(spy.mock.calls[0][0]).toContain("loud message");
		expect(spy.mock.calls[1][1]).toEqual({ foo: "bar" });

		setDebugLogging(false);
		logDebug("test", "silent again");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
