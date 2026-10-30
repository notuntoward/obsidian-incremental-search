import { Text } from "@codemirror/state";
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import type { Code, Construct, State } from "micromark-util-types";

type Range = { from: number; to: number };
type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>["children"][number];

declare module "micromark-util-types" {
	interface TokenTypeMap {
		incrementalSearchWikiLink: "incrementalSearchWikiLink";
	}
}

// Obsidian's cache omits external URLs and lags unsaved edits. Use CommonMark
// source positions, with a syntax extension only for Obsidian's wikilinks.
const wikiLink: Construct = {
	name: "incrementalSearchWikiLink",
	tokenize(effects, ok, nok) {
		let closing = false;
		return first;

		function first(code: Code): State | undefined {
			effects.enter("incrementalSearchWikiLink");
			effects.consume(code);
			return code === 33 ? open : second;
		}
		function open(code: Code): State | undefined {
			if (code !== 91) return nok(code);
			effects.consume(code);
			return second;
		}
		function second(code: Code): State | undefined {
			if (code !== 91) return nok(code);
			effects.consume(code);
			return inside;
		}
		function inside(code: Code): State | undefined {
			if (code === null || code === -3 || code === -4 || code === -5 || code === 91) return nok(code);
			if (closing) {
				if (code !== 93) return nok(code);
				effects.consume(code);
				effects.exit("incrementalSearchWikiLink");
				return ok;
			}
			closing = code === 93;
			effects.consume(code);
			return inside;
		}
	},
};
const wikiSyntax: NonNullable<Options["extensions"]>[number] = { text: { 33: wikiLink, 91: wikiLink } };

const hiddenLinks = new WeakMap<Text, readonly Range[]>();

export function getHiddenLinkRanges(doc: Text): readonly Range[] {
	const cached = hiddenLinks.get(doc);
	if (cached) return cached;

	const source = doc.toString();
	const tree = fromMarkdown(source, {
		extensions: [wikiSyntax],
		mdastExtensions: [{
			enter: {
				incrementalSearchWikiLink(token) {
					this.enter({ type: "link", url: "", children: [], data: { incrementalSearchWikiLink: true } }, token);
				},
			},
			exit: {
				incrementalSearchWikiLink(token) { this.exit(token); },
			},
		}],
	});
	const ranges: Range[] = [];

	function visit(node: MarkdownNode): void {
		const from = node.position?.start.offset;
		const to = node.position?.end.offset;
		if (from !== undefined && to !== undefined) {
			if (node.type === "image" || node.type === "imageReference" || node.type === "definition") {
				ranges.push({ from, to });
				return;
			}
			if (node.type === "link" && node.data && "incrementalSearchWikiLink" in node.data) {
				if (source[from] === "!") {
					ranges.push({ from, to });
				} else {
					const pipe = source.indexOf("|", from + 2);
					ranges.push({ from, to: pipe !== -1 && pipe < to ? pipe + 1 : from + 2 });
					ranges.push({ from: to - 2, to });
				}
				return;
			}
			if (node.type === "link" || node.type === "linkReference") {
				const start = node.children[0]?.position?.start.offset;
				const end = node.children[node.children.length - 1]?.position?.end.offset;
				ranges.push({ from, to: start ?? to });
				if (end !== undefined) ranges.push({ from: end, to });
			}
		}
		if ("children" in node) node.children.forEach(visit);
	}
	visit(tree);
	ranges.sort((a, b) => a.from - b.from);
	hiddenLinks.set(doc, ranges);
	return ranges;
}
