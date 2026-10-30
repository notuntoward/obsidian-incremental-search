import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { renderSearchWidget, removeWidget } from "../../src/widget";
import type { IncrementalSearchSettings } from "../../src/types";

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
	alias: { obsidian: path.resolve("tests", "__mocks__", "obsidian.ts") },
	bundle: true,
	format: "iife",
	write: false,
}).outputFiles[0].text;

for (const width of [280, 760]) {
	for (const theme of ["light", "dark"]) {
		for (const content of ["markdown", "pdf"]) {
			test(`${content} bar fits ${width}px in ${theme} theme without covering the document`, async ({ page }) => {
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
				await page.addScriptTag({ content: bundle });
				await page.evaluate((contentType) => {
					const api = window.searchBarTest;
					const settings = { ...api.DEFAULT_SETTINGS, searchInterface: "obsidian" as const };
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
					}, settings, "a long query that must not widen the search bar", "forward");
				}, content);

				const input = page.getByRole("textbox", { name: "Incremental search", exact: true });
				await expect(input).toBeFocused();
				const bounds = await page.evaluate(() => {
					const bar = document.querySelector<HTMLElement>(".incsearch-widget-obsidian")!;
					const input = bar.querySelector("input")!;
					const content = document.querySelector(".markdown-source-view, .pdf-container")!;
					const rect = bar.getBoundingClientRect();
					const native = document.querySelector<HTMLElement>("#native-reference")!;
					const nativeInput = native.querySelector("input")!.getBoundingClientRect();
					const pluginInput = bar.querySelector(".document-search-input")?.getBoundingClientRect();
					return {
						barWidth: rect.width,
						nativeWidth: native.getBoundingClientRect().width,
						barHeight: rect.height,
						nativeHeight: native.getBoundingClientRect().height,
						inputFrameWidth: pluginInput?.width ?? 0,
						nativeInputWidth: nativeInput.width,
						inputHeight: input.getBoundingClientRect().height,
						inputCenter: nativeInput.top + nativeInput.height / 2 - native.getBoundingClientRect().top + rect.top,
						nativeInputHeight: nativeInput.height,
						inputStyle: ["borderRadius", "fontSize", "backgroundColor"].map(key =>
							getComputedStyle(input).getPropertyValue(key.replace(/[A-Z]/g, c => "-" + c.toLowerCase()))),
						nativeInputStyle: ["borderRadius", "fontSize", "backgroundColor"].map(key =>
							getComputedStyle(native.querySelector("input")!).getPropertyValue(key.replace(/[A-Z]/g, c => "-" + c.toLowerCase()))),
						buttonCenters: Array.from(bar.querySelectorAll("button"), button => {
							const r = button.getBoundingClientRect();
							return r.top + r.height / 2;
						}),
						documentTop: content.getBoundingClientRect().top,
						barBottom: rect.bottom,
						inputWidth: input.getBoundingClientRect().width,
						overflow: bar.scrollWidth - bar.clientWidth,
						hostBottom: bar.parentElement!.getBoundingClientRect().bottom,
						documentBottom: content.getBoundingClientRect().bottom,
					};
				});
				expect(bounds.barWidth).toBeCloseTo(bounds.nativeWidth, 0);
				expect(bounds.barHeight).toBeCloseTo(bounds.nativeHeight, 0);
				expect(bounds.inputFrameWidth).toBeCloseTo(bounds.nativeInputWidth, 0);
				expect(bounds.inputHeight).toBeCloseTo(bounds.nativeInputHeight, 0);
				expect(bounds.inputStyle).toEqual(bounds.nativeInputStyle);
				expect(Math.max(...bounds.buttonCenters) - Math.min(...bounds.buttonCenters)).toBeLessThan(1);
				expect(Math.abs(bounds.buttonCenters[0] - bounds.inputCenter)).toBeLessThan(1);
				expect(bounds.inputWidth).toBeGreaterThan(20);
				expect(bounds.overflow).toBeLessThanOrEqual(1);
				expect(bounds.documentTop).toBeGreaterThanOrEqual(bounds.barBottom);
				expect(bounds.documentBottom).toBeLessThanOrEqual(bounds.hostBottom);
				await expect(page.locator(".incsearch-method-indicator")).toHaveText("IS");
				await expect(page.locator(".incsearch-method-indicator")).toHaveAttribute("aria-label", "Incremental Search plugin");

				await page.getByRole("button", { name: "Incremental Search: Backward", exact: true }).click();
				await page.getByRole("button", { name: "Incremental Search: Forward", exact: true }).click();
				await expect(input).toBeFocused();
				const toggle = page.getByRole("button", { name: "Highlight all matches", exact: true });
				await toggle.click();
				await expect(toggle).toHaveAttribute("aria-pressed", "true");
				await toggle.click();
				await expect(toggle).toHaveAttribute("aria-pressed", "false");
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
