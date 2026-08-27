import { expect, test } from "@playwright/test";
import path from "node:path";

test("native PDF highlights match markdown current and secondary styling", async ({ page }) => {
	await page.setContent(`
		<style>
			:root {
				--interactive-accent: #705dcf;
				--incsearch-current-outline-resolved: #705dcf;
			}
			.textLayer .highlight {
				--highlight-bg-color: rgb(230 180 0);
				--highlight-selected-bg-color: rgb(61 43 151);
				background-color: var(--highlight-bg-color);
				border-radius: 4px;
			}
			.textLayer .highlight.selected {
				background-color: var(--highlight-selected-bg-color);
			}
		</style>
		<div class="incsearch-active-pdf">
			<div class="textLayer">
				<span id="pdf-secondary" class="highlight appended">secondary</span>
				<span id="pdf-current" class="highlight selected appended">current</span>
			</div>
		</div>
		<span id="markdown-secondary" class="incsearch-match-exact">secondary</span>
		<span id="markdown-current" class="incsearch-match-exact is-current">current</span>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });

	const styles = await page.evaluate(() => {
		const read = (id: string) => {
			const style = getComputedStyle(document.getElementById(id)!);
			return {
				backgroundColor: style.backgroundColor,
				boxShadow: style.boxShadow,
				outlineColor: style.outlineColor,
				outlineStyle: style.outlineStyle,
				outlineWidth: style.outlineWidth,
			};
		};
		return {
			pdfSecondary: read("pdf-secondary"),
			pdfCurrent: read("pdf-current"),
			markdownSecondary: read("markdown-secondary"),
			markdownCurrent: read("markdown-current"),
		};
	});

	expect(styles.pdfSecondary.backgroundColor).toBe(styles.markdownSecondary.backgroundColor);
	expect(styles.pdfSecondary.boxShadow).toBe(styles.markdownSecondary.boxShadow);
	expect(styles.pdfCurrent.backgroundColor).toBe(styles.markdownCurrent.backgroundColor);
	expect(styles.pdfCurrent.outlineColor).toBe(styles.markdownCurrent.outlineColor);
	expect(styles.pdfCurrent.outlineStyle).toBe(styles.markdownCurrent.outlineStyle);
	expect(styles.pdfCurrent.outlineWidth).toBe(styles.markdownCurrent.outlineWidth);
	expect(styles.pdfCurrent.boxShadow).toBe("none");
});

test("PDF matches keep white-page contrast in dark theme", async ({ page }) => {
	await page.setContent(`
		<style>
			:root {
				--interactive-accent: #b9a5ff;
				--incsearch-current-outline-resolved: #b9a5ff;
			}
		</style>
		<body class="theme-dark">
			<span id="markdown-secondary" class="incsearch-match-exact">markdown secondary</span>
			<span id="markdown-current" class="incsearch-match-exact is-current">markdown current</span>
			<div id="pdf" class="incsearch-active-pdf">
				<mark id="pdf-secondary" class="incsearch-pdf-secondary">pdf secondary</mark>
				<div class="textLayer">
					<span id="pdf-current" class="highlight selected">pdf current</span>
				</div>
			</div>
		</body>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.evaluate(() => {
		const pdf = document.getElementById("pdf")!;
		pdf.style.setProperty("--incsearch-secondary-fill", "rgba(112, 93, 207, 0.22)");
		pdf.style.setProperty("--incsearch-secondary-edge", "rgba(112, 93, 207, 0.50)");
		pdf.style.setProperty("--incsearch-current-outline-resolved", "#2e3338");
	});

	const styles = await page.evaluate(() => {
		const read = (id: string) => {
			const style = getComputedStyle(document.getElementById(id)!);
			return { backgroundColor: style.backgroundColor, outlineColor: style.outlineColor };
		};
		return {
			markdownSecondary: read("markdown-secondary"),
			markdownCurrent: read("markdown-current"),
			pdfSecondary: read("pdf-secondary"),
			pdfCurrent: read("pdf-current"),
		};
	});

	expect(styles.markdownSecondary.backgroundColor).toBe("rgba(185, 165, 255, 0.38)");
	expect(styles.markdownCurrent.outlineColor).toBe("rgb(185, 165, 255)");

	expect(styles.pdfSecondary.backgroundColor).toBe("rgba(112, 93, 207, 0.22)");
	expect(styles.pdfCurrent.outlineColor).toBe("rgb(46, 51, 56)");
});

test("native wildcard token highlight uses markdown secondary fill", async ({ page }) => {
	await page.setContent(`
		<style>:root { --incsearch-secondary-fill: rgba(112, 93, 207, 0.22); }</style>
		<span id="text">plugin gap</span>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.evaluate(() => {
		const highlights = CSS.highlights as unknown as Map<string, Highlight>;
		const text = document.getElementById("text")!.firstChild!;
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, 6);
		highlights.set("incsearch-pdf-current-token", new Highlight(range));
	});

	expect(await page.evaluate(() =>
		(CSS.highlights as unknown as Map<string, Highlight>).has("incsearch-pdf-current-token")
	)).toBe(true);
	expect(await page.locator("#text").evaluate((el) => el.childNodes.length)).toBe(1);
});

test("on-demand mode hides only native PDF secondary matches", async ({ page }) => {
	await page.setContent(`
		<div class="incsearch-active-pdf incsearch-pdf-hide-other-matches">
			<div class="textLayer">
				<span id="secondary" class="highlight appended">secondary</span>
				<span id="current" class="highlight selected appended">current</span>
			</div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });

	await expect(page.locator("#secondary")).toHaveCSS("opacity", "0");
	await expect(page.locator("#current")).toHaveCSS("opacity", "1");
});

test("joined native current fragments clip only their internal edges", async ({ page }) => {
	await page.setContent(`
		<div class="incsearch-active-pdf">
			<div class="textLayer">
				<span id="begin" class="highlight begin selected incsearch-join-next">evaluation</span>
				<span id="end" class="highlight end selected incsearch-join-prev">Disc</span>
				<span id="next-line" class="highlight end selected">next line</span>
			</div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });

	await expect(page.locator("#begin")).toHaveCSS("clip-path", "inset(-4px 0px -4px -4px)");
	await expect(page.locator("#end")).toHaveCSS("clip-path", "inset(-4px -4px -4px 0px)");
	await expect(page.locator("#next-line")).toHaveCSS("clip-path", "none");
});
