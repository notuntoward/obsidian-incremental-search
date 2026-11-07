import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { renderSearchWidget, removeWidget } from "../../src/widget";
import type { IncrementalSearchSettings } from "../../src/types";
import type { App } from "obsidian";

declare global {
	interface Window {
		searchBarTest: {
			renderSearchWidget: typeof renderSearchWidget;
			removeWidget: typeof removeWidget;
			DEFAULT_SETTINGS: IncrementalSearchSettings;
			advances: string[];
			modeChanges: string[];
			accepted: boolean[];
		};
	}
}

const bundle = buildSync({
	stdin: {
		contents: `
			import { renderSearchWidget, removeWidget } from "./src/widget";
			import { DEFAULT_SETTINGS } from "./src/types";
			globalThis.searchBarTest = { renderSearchWidget, removeWidget, DEFAULT_SETTINGS,
				advances: [], modeChanges: [], accepted: [] };
		`,
		resolveDir: process.cwd(),
	},
	alias: {
		obsidian: path.resolve("tests", "__mocks__", "obsidian.ts"),
		// Bundle the real hint renderer without unrelated modal APIs needing a full Obsidian mock.
		"commons/modal": path.resolve("..", "obsidian-commons", "src", "modal", "key-hints.ts"),
		"commons/search": path.resolve("..", "obsidian-commons", "src", "search", "behavior.ts"),
	},
	bundle: true,
	format: "iife",
	write: false,
}).outputFiles[0].text;

for (const width of [280, 760]) {
	for (const theme of ["light", "dark"]) {
		for (const [content, exitMode] of [
			["markdown", "emacs"], ["markdown", "obsidian"],
			["pdf", "emacs"], ["pdf", "obsidian"],
		] as const) {
			test(`${content} ${exitMode} bar fits ${width}px in ${theme} theme without covering the document`, async ({ page }) => {
				await page.setViewportSize({ width, height: 640 });
				await page.setContent(`
					<style>
						* { box-sizing: border-box; }
						body { margin: 0; font: 14px sans-serif; }
						:root {
							--background-primary: ${theme === "dark" ? "#222" : "#fff"};
							--background-modifier-form-field: ${theme === "dark" ? "#333" : "#fff"};
							--background-modifier-border: #888;
							--background-modifier-border-focus: #705dcf;
							--text-normal: ${theme === "dark" ? "#eee" : "#222"};
							--text-muted: #888;
							--interactive-accent: #705dcf;
							--font-ui-smaller: 12px;
							--font-medium: 500;
						}
						.view-content { position: relative; height: 400px; }
						.markdown-source-view, .pdf-container { height: 100%; overflow: auto; }
						.cm-editor { height: 100%; }
						.svg-icon { display: inline-block; width: 18px; height: 18px; }
						button { border: 0; color: var(--text-muted); }
						:root { --size-4-1: 4px; --size-4-2: 8px; --size-4-4: 16px; --input-height: 30px; --file-line-width: 700px; }
						.document-search-container { display: flex; flex-direction: column; padding: 8px 0; margin: 0 16px; gap: 8px; }
						.document-search { display: flex; width: 100%; max-width: 700px; margin: 0 auto; padding: 0 8px; gap: 8px; }
						.document-search-input { flex-grow: 1; position: relative; }
						.search-input-container::before { content: ""; display: block; position: absolute; width: 18px; height: 18px; }
						.search-input-container input { display: block; width: 100%; height: 30px; }
						.document-search-buttons { display: flex; gap: 4px; align-items: center; }
						.document-search-button { padding: 4px; }
						.document-search-count { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); }
						textarea[aria-label="Other pane"] { position: fixed; bottom: 8px; left: 8px; width: 160px; height: 32px; min-height: 0; }
					</style>
					<div id="native-reference" class="document-search-container">
						<div class="document-search">
							<div class="document-search-input search-input-container"><input type="text" placeholder="Find..."></div>
							<div class="document-search-buttons">
								<button class="clickable-icon document-search-button"><span class="svg-icon"></span></button>
								<button class="clickable-icon document-search-button"><span class="svg-icon"></span></button>
								<button class="clickable-icon document-search-button"><span class="svg-icon"></span></button>
								<button class="clickable-icon document-search-button"><span class="svg-icon"></span></button>
							</div>
						</div>
					</div>
					<div class="view-content"><div class="${content === "markdown" ? "markdown-source-view" : "pdf-container"}">
						<div class="cm-editor">Document content</div>
					</div></div>
					<textarea aria-label="Other pane"></textarea>
				`);
				await page.evaluate((mode) => { document.body.className = `theme-${mode}`; }, theme);
				if (process.env.OBSIDIAN_APP_CSS) {
					await page.addStyleTag({ content: readFileSync(process.env.OBSIDIAN_APP_CSS, "utf8") });
				}
				await page.addStyleTag({ path: path.resolve("styles.css") });
				// File Palette footer typography; keep this fixture independent of another consumer checkout.
				await page.addStyleTag({ content: `
					.fp-footer { font-size: var(--font-ui-smaller); color: var(--text-muted); }
					.fp-hint-key { color: var(--text-normal); font-weight: var(--font-medium); }
				` });
				await page.evaluate(() => {
					const reference = document.createElement("div");
					reference.className = "fp-footer";
					const key = document.createElement("span");
					key.className = "fp-hint-key";
					key.textContent = "Enter";
					reference.appendChild(key);
					document.body.appendChild(reference);
				});
				await page.addScriptTag({ content: bundle });
				await page.evaluate(({ contentType, exitMode }) => {
					const api = window.searchBarTest;
					const settings = { ...api.DEFAULT_SETTINGS, searchInterface: "obsidian" as const, searchExitBehavior: exitMode };
					const container = document.querySelector<HTMLElement>(
						contentType === "markdown" ? ".markdown-source-view" : ".view-content"
					)!;
					api.renderSearchWidget({
						containerEl: container,
						getCounterState: () => ({ current: 1, total: 123, direction: "forward", inTable: contentType === "markdown" }),
						onInput: () => {},
						advance: (direction) => { api.advances.push(direction); },
						toggleDemandHighlights: () => {},
						setAllMatchesDisplayMode: async (mode) => {
							settings.allMatchesDisplayMode = mode;
							api.modeChanges.push(mode);
						},
						accept: (refocus = true) => { api.accepted.push(refocus); api.removeWidget(); },
						cancel: () => api.removeWidget(),
					}, settings, "a long query that must not widen the search bar", "forward", {
						hotkeyManager: {
							printHotkeyForCommand: (id: string) => id.endsWith(":forward") ? "Alt + S" : "Alt + R",
						},
					} as unknown as App);
				}, { contentType: content, exitMode });

				const input = page.getByRole("textbox", { name: "Incremental search", exact: true });
				const hints = page.locator(".incsearch-key-hints");
				await expect(hints).not.toContainText("F3");
				if (exitMode === "emacs") {
					await expect(hints).toContainText("Alt + S");
					await expect(hints).toContainText("Alt + R");
				} else {
					await expect(hints).toContainText("Shift+Enter");
					await expect(hints).not.toContainText("Alt + S");
				}
				await expect(input).toBeFocused();
				const iconTextGap = () => input.evaluate(el => {
					const icon = el.closest(".document-search")!.querySelector(".incsearch-method-indicator .svg-icon")!;
					const style = getComputedStyle(el);
					return el.getBoundingClientRect().left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
						- icon.getBoundingClientRect().right;
				});
				expect(await iconTextGap()).toBeGreaterThanOrEqual(8);
				const hintTypography = await page.evaluate(() => {
					const hint = getComputedStyle(document.querySelector(".incsearch-key-hints")!);
					const key = getComputedStyle(document.querySelector(".incsearch-hint-key")!);
					const reference = getComputedStyle(document.querySelector(".fp-footer")!);
					const referenceKey = getComputedStyle(document.querySelector(".fp-hint-key")!);
					return {
						actual: [hint.fontSize, hint.color, key.fontWeight, key.color],
						reference: [reference.fontSize, reference.color, referenceKey.fontWeight, referenceKey.color],
					};
				});
				expect(hintTypography.actual).toEqual(hintTypography.reference);
				const iconContent = () => page.locator(".incsearch-widget-obsidian .search-input-container").evaluate(
					el => getComputedStyle(el, "::before").content
				);
				expect(await iconContent()).toBe("none");
				expect(await page.locator("#native-reference .search-input-container").evaluate(
					el => getComputedStyle(el, "::before").content
				)).toBe('""');
				await input.fill("");
				await expect(input).toHaveAttribute("placeholder", "Find...");
				expect(await iconTextGap()).toBeGreaterThanOrEqual(8);
				expect(await iconContent()).toBe("none");
				await input.fill("a long query that must not widen the search bar");
				const bounds = await page.evaluate(() => {
					const bar = document.querySelector<HTMLElement>(".incsearch-widget-obsidian")!;
					const input = bar.querySelector("input")!;
					const content = document.querySelector(".markdown-source-view, .pdf-container")!;
					const rect = bar.getBoundingClientRect();
					const native = document.querySelector<HTMLElement>("#native-reference")!;
					const nativeInput = native.querySelector("input")!.getBoundingClientRect();
					return {
						barWidth: rect.width,
						nativeWidth: native.getBoundingClientRect().width,
						rowHeight: bar.querySelector(".document-search")!.getBoundingClientRect().height,
						hintsTop: bar.querySelector(".incsearch-key-hints")!.getBoundingClientRect().top,
						rowBottom: bar.querySelector(".document-search")!.getBoundingClientRect().bottom,
						inputHeight: input.getBoundingClientRect().height,
						inputCenter: input.getBoundingClientRect().top + input.getBoundingClientRect().height / 2,
						nativeInputHeight: nativeInput.height,
						inputBackground: getComputedStyle(input).backgroundColor,
						rowBorder: getComputedStyle(bar.querySelector(".document-search")!).borderTopWidth,
						buttonCenters: Array.from(bar.querySelectorAll("button"), button => {
							const r = button.getBoundingClientRect();
							return r.top + r.height / 2;
						}),
						documentTop: content.getBoundingClientRect().top,
						barBottom: rect.bottom,
						inputWidth: input.getBoundingClientRect().width,
						inputRight: input.getBoundingClientRect().right,
						counterLeft: bar.querySelector(".incsearch-count-container")!.getBoundingClientRect().left,
						overflow: bar.scrollWidth - bar.clientWidth,
						hostBottom: bar.parentElement!.getBoundingClientRect().bottom,
						documentBottom: content.getBoundingClientRect().bottom,
					};
				});
				expect(bounds.barWidth).toBeCloseTo(bounds.nativeWidth, 0);
				expect(bounds.rowHeight).toBeGreaterThanOrEqual(bounds.nativeInputHeight + 16);
				expect(bounds.hintsTop).toBeGreaterThanOrEqual(bounds.rowBottom);
				expect(bounds.inputHeight).toBeCloseTo(bounds.nativeInputHeight, 0);
				expect(bounds.inputBackground).toBe("rgba(0, 0, 0, 0)");
				expect(bounds.rowBorder).toBe("1px");
				expect(Math.max(...bounds.buttonCenters) - Math.min(...bounds.buttonCenters)).toBeLessThan(1);
				expect(Math.abs(bounds.buttonCenters[0] - bounds.inputCenter)).toBeLessThan(1);
				expect(bounds.inputWidth).toBeGreaterThan(20);
				expect(bounds.inputRight).toBeLessThanOrEqual(bounds.counterLeft);
				expect(bounds.overflow).toBeLessThanOrEqual(1);
				expect(bounds.documentTop).toBeGreaterThanOrEqual(bounds.barBottom);
				expect(bounds.documentBottom).toBeLessThanOrEqual(bounds.hostBottom);
				await expect(page.locator(".incsearch-method-indicator .svg-icon")).toHaveCount(1);
				await expect(page.locator(".incsearch-method-indicator")).toHaveAttribute("aria-label", "Incremental Search plugin");
				await expect(page.locator(".incsearch-key-hints")).toContainText(exitMode === "emacs" ? "Enter Accept" : "Enter Next");
				await expect(page.locator(".incsearch-key-hints")).toContainText(exitMode === "emacs" ? "Esc Cancel" : "Esc Accept");
				await expect(page.locator(".incsearch-key-hints")).toContainText("Ctrl+Enter Highlights");

				await page.getByRole("button", { name: "Incremental Search: Backward", exact: true }).click();
				await page.getByRole("button", { name: "Incremental Search: Forward", exact: true }).click();
				await expect(input).toBeFocused();
				const toggle = page.getByRole("button", { name: "Highlight all matches", exact: true });
				await toggle.click();
				await expect(toggle).toHaveAttribute("aria-pressed", "true");
				await expect(page.locator(".incsearch-key-hints")).not.toContainText("Ctrl+Enter Highlights");
				await toggle.click();
				await expect(toggle).toHaveAttribute("aria-pressed", "false");
				await expect(page.locator(".incsearch-key-hints")).toContainText("Ctrl+Enter Highlights");
				expect(await page.evaluate(() => window.searchBarTest.advances)).toEqual(["backward", "forward"]);
				expect(await page.evaluate(() => window.searchBarTest.modeChanges)).toEqual(["always", "on-demand"]);

				if (width === 760 && theme === "light" && content === "markdown") {
					await input.press("Tab");
					const backward = page.getByRole("button", { name: "Incremental Search: Backward", exact: true });
					await expect(backward).toBeFocused();
					await backward.press("Enter");
					expect(await page.evaluate(() => window.searchBarTest.advances)).toEqual(["backward", "forward", "backward"]);
					await page.getByRole("textbox", { name: "Other pane" }).click();
					await expect(page.getByRole("search")).toHaveCount(0);
					expect(await page.evaluate(() => window.searchBarTest.accepted)).toEqual([false]);
					await expect(page.getByRole("textbox", { name: "Other pane" })).toBeFocused();
					return;
				}

				await page.getByRole("button", { name: "Cancel search", exact: true }).click();
				await expect(page.getByRole("search")).toHaveCount(0);
				await expect(page.locator(".view-content")).not.toHaveClass(/incsearch-bar-host/);
			});
		}
	}
}
