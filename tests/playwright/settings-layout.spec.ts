import { expect, test } from "@playwright/test";
import path from "node:path";
import { readFileSync } from "node:fs";

for (const width of [320, 500, 680]) {
	test(`settings descriptions use full width without overflow at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width: width + 40, height: 800 });
		await page.setContent(`
			<style>
				* { box-sizing: border-box; }
				body { margin: 20px; font: 14px/1.5 sans-serif; }
				.setting-item { display: flex; align-items: center; padding: 24px 0; gap: 16px; }
				.setting-item-info { flex: 1; }
				.setting-item-control { display: flex; flex-shrink: 0; }
				.setting-item-description { color: #888; }
			</style>
			<div class="incsearch-settings-group setting-group">
				<div class="setting-item">
					<div class="setting-item-info">
						<div class="setting-item-name">Search keyboard behavior</div>
						<div class="setting-item-description">Emacs: Enter accepts; Escape cancels. Obsidian: Enter next; Shift+Enter previous; Escape accepts. Ctrl/Cmd+G cancels in every interface.</div>
					</div>
					<div class="setting-item-control"><select><option>Obsidian-style</option><option>Emacs-style</option></select></div>
				</div>
				<div class="setting-item">
					<div class="setting-item-info">
						<div class="setting-item-name">Secondary match highlight style</div>
						<div class="setting-item-description">Appearance of other matches. Adaptive uses theme-matched fill and borders.</div>
					</div>
					<div class="setting-item-control"><select><option>Adaptive</option><option>Dotted underline</option></select></div>
				</div>
				<div class="setting-item">
					<div class="setting-item-info">
						<div class="setting-item-name">Custom color (Light theme)</div>
						<div class="setting-item-description">Custom CSS color (hex, rgb, or rgba) for secondary highlights in light mode.</div>
					</div>
					<div class="setting-item-control"><input type="text" placeholder="#ffe066 or rgba(255, 224, 102, 0.5)"></div>
				</div>
			</div>
		`);
		if (process.env.OBSIDIAN_APP_CSS) {
			await page.addStyleTag({ content: readFileSync(process.env.OBSIDIAN_APP_CSS, "utf8") });
		}
		await page.addStyleTag({ path: path.resolve("styles.css") });
		for (const row of await page.locator(".setting-item").all()) {
			const layout = await row.evaluate(el => {
				const rect = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				const desc = el.querySelector(".setting-item-description")!.getBoundingClientRect();
				const control = el.querySelector(".setting-item-control")!.getBoundingClientRect();
				const name = el.querySelector(".setting-item-name")!.getBoundingClientRect();
				return { width: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), height: rect.height, descWidth: desc.width, descTop: desc.top, controlTop: control.top, controlBottom: control.bottom, nameBottom: name.bottom, overflow: el.scrollWidth - el.clientWidth };
			});
			expect(layout.descWidth).toBeGreaterThanOrEqual(layout.width - 2);
			expect(layout.descTop).toBeGreaterThanOrEqual(layout.controlBottom);
			expect(layout.height).toBeLessThanOrEqual(width === 320 ? 210 : 160);
			expect(layout.overflow).toBeLessThanOrEqual(1);
			if (width === 320) expect(layout.controlTop).toBeGreaterThanOrEqual(layout.nameBottom);
		}
	});
}
