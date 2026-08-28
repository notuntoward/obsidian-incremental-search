import { describe, it, expect, beforeEach } from "vitest";
import { logDebug, describeElement, getRecentLogs, clearLogs } from "../src/utils/logger";

describe("utils: logger", () => {
	beforeEach(() => {
		clearLogs();
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
});
