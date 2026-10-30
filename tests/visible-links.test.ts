import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import fc from "fast-check";
import { computeMatches } from "../src/engine";
import { mockFileCache } from "./__mocks__/obsidian";

const example = "- [ARCHITECTURE AND THEORY.md \u00b7 GitHub](https://github.com/notuntoward/obsidian-incremental-search/blob/master/doc/ARCHITECTURE_AND_THEORY.md)";

describe.each([false, true])("visible links (wildcard=%s)", (wildcard) => {
  const search = (doc: string, query: string, visible = true, cache?: ReturnType<typeof mockFileCache>) =>
    computeMatches(EditorState.create({ doc }), query, wildcard, visible, cache);

  it.each([undefined, mockFileCache()])("finds THEORY only in the GitHub label without fabricated URL cache entries (%j)", (cache) => {
    expect(search(example, "theory", true, cache).map(({ from, to }) => ({ from, to })))
      .toEqual([{ from: example.indexOf("THEORY"), to: example.indexOf("THEORY") + 6 }]);
    expect(search(example, "theory", false, cache)).toHaveLength(2);
  });

  it.each([
    ["[theory](https://example.com/theory)", "theory", [1]],
    ["[theory](theory.md)", "theory", [1]],
    ['[theory](https://example.com/theory "theory title")', "theory", [1]],
    ["[theory](<https://example.com/theory>)", "theory", [1]],
    ["[theory](https://example.com/a_(theory))", "theory", [1]],
    ["[nested [theory] label](https://example.com/theory)", "theory", [9]],
    [String.raw`[escaped \] theory](https://example.com/theory)`, "theory", [12]],
    ["[**theory**](https://example.com/theory)", "theory", [3]],
    ["[](https://example.com/theory)", "theory", []],
    ["![caption](https://example.com/theory.png)", "theory", []],
    ["[theory][reference]\n\n[reference]: https://example.com/theory", "theory", [1]],
    ["[theory][]\n\n[theory]: https://example.com/theory", "theory", [1]],
    ["[theory]\n\n[theory]: https://example.com/theory", "theory", [1]],
    ['[label][ref]\n\n[ref]: https://example.com/theory\n  "theory title"', "theory", []],
    ["<https://example.com/theory>", "theory", [21]],
    ["https://example.com/theory", "theory", [20]],
    ["[[theory]]", "theory", [2]],
    ["[[folder/theory#heading]]", "theory", [9]],
    ["[[note#theory]]", "theory", [7]],
    ["[[note#^theory]]", "theory", [8]],
    ["[[theory|label]]", "theory", []],
    ["[[theory|theory]]", "theory", [9]],
    ["[[theory#theory|label]]", "theory", []],
    ["[[note|theory]]", "theory", [7]],
    ["[[theory|]]", "theory", []],
    [String.raw`[[theory\|label]]`, "theory", []],
    [String.raw`\![[theory]]`, "theory", [4]],
    ["![[theory.png]]", "theory", []],
    ["![[theory|caption]]", "theory", []],
    ["[[theory|label]] [label](https://example.com/theory) [[theory]]", "theory", [55]],
  ] as const)("filters %s with exact source offsets", (doc, query, expected) => {
    expect(search(doc, query).map(match => match.from)).toEqual(expected);
    for (const match of search(doc, query)) {
      expect(doc.slice(match.from, match.to).toLowerCase()).toBe(query);
    }
  });

  it.each([
    "`[theory](https://example.com/theory)`",
    "```\n[theory](https://example.com/theory)\n```",
    String.raw`\[theory](https://example.com/theory)`,
  ])("does not mistake visibly literal link syntax for a rendered link: %s", (doc) => {
    expect(search(doc, "theory")).toHaveLength(2);
  });

  it.each([
    "[theory][missing]",
    "[theory](https://example.com/theory",
    "[[theory|label]",
    String.raw`\[[theory|label]]`,
    "    [theory](https://example.com/theory)",
  ])("keeps literal or incomplete link source searchable: %s", (doc) => {
    expect(search(doc, "theory").map(match => match.from))
      .toEqual(Array.from(doc.matchAll(/theory/g), match => match.index));
  });

  it.each([undefined, "", "theory"])("ignores optional cache displayText when excluding a URL (%s)", (displayText) => {
    const doc = "[label](https://example.com/theory)";
    const cache = mockFileCache({ links: [{
      original: doc, link: "https://example.com/theory", displayText,
      position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: doc.length, offset: doc.length } },
    }] });
    expect(search(doc, "theory", true, cache)).toEqual([]);
  });

  it("reparses after unsaved edits while safely reusing an unchanged document", () => {
    const state = EditorState.create({ doc: "[theory](https://example.com/theory)" });
    expect(computeMatches(state, "theory", wildcard, true)).toHaveLength(1);
    expect(computeMatches(state, "example", wildcard, true)).toEqual([]);
    const edited = state.update({ changes: { from: 1, to: 7, insert: "label" } }).state;
    expect(computeMatches(edited, "theory", wildcard, true)).toEqual([]);
    expect(computeMatches(state, "theory", wildcard, true)).toHaveLength(1);
  });

  it("uses the current unsaved document rather than shifted or incomplete cache offsets", () => {
    const old = "[[theory|label]]";
    const doc = "theory\n" + old + " [label](https://example.com/theory)\n[[theory]]";
    const cache = mockFileCache({ links: [{
      original: old, link: "theory", displayText: "label",
      position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: old.length, offset: old.length } },
    }] });
    expect(search(doc, "theory", true, cache).map(match => match.from))
      .toEqual([0, doc.lastIndexOf("theory")]);
  });

  it("preserves Unicode and multi-line source offsets", () => {
    const doc = "\u{1f50d} Caf\u00e9\n[theory](https://example.com/theory)\n[[theory|theory]]\n[[theory]]";
    expect(search(doc, "theory").map(match => match.from))
      .toEqual([doc.indexOf("[theory") + 1, doc.indexOf("|theory") + 1, doc.lastIndexOf("theory")]);
  });

  it("filters nested and multiline destinations and titles", () => {
    const doc = '[theory](\n<https://example.com/theory>\n"theory title"\n)';
    expect(search(doc, "theory").map(match => match.from)).toEqual([1]);
  });

  it("preserves smart-case and whole-word matching on visible labels", () => {
    const doc = "[Theory](https://example.com/THEORY) [theory](https://example.com/Theory)";
    expect(search(doc, "Theory").map(match => match.from)).toEqual([1]);
    expect(search(doc, "THEORY")).toEqual([]);
    expect(search(doc, "theory")).toHaveLength(2);
    const state = EditorState.create({ doc: "[theory](url)s [theory](url)" });
    expect(computeMatches(state, "theory", wildcard, true, undefined, { wholeWord: true }).map(match => match.from))
      .toEqual([state.doc.toString().lastIndexOf("theory")]);
  });

  it("retains original table cell offsets after hiding a destination", () => {
    const doc = "| Column |\n| --- |\n| [theory](https://example.com/theory) |";
    const cache = mockFileCache({ sections: [{
      type: "table",
      position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 2, col: 0, offset: doc.length } },
    }] });
    const matches = search(doc, "theory", true, cache);
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(doc.indexOf("theory"));
    expect(matches[0].tableMatchData).toMatchObject({
      rowIndex: 1, colIndex: 0, matchStartInCell: 2, matchEndInCell: 8,
      cellText: " [theory](https://example.com/theory) ",
    });
  });

  it("handles bounded long malformed syntax without hiding visible text", () => {
    const doc = "[[" + "word ".repeat(1000) + "theory\n[label](https://example.com/theory)";
    expect(search(doc, "theory").map(match => match.from)).toEqual([doc.indexOf("theory")]);
  });

  it("leaves all destinations searchable with filtering disabled", () => {
    const doc = "[theory](https://example.com/theory) [[theory|theory]]";
    expect(search(doc, "theory", false)).toHaveLength(4);
  });

  it("never exposes external destinations or aliased wikilink targets over varied labels and offsets", () => {
    const word = fc.array(fc.constantFrom("a", "b", "c", "d", "e"), { minLength: 1, maxLength: 20 })
      .map(chars => chars.join(""));
    fc.assert(fc.property(word, fc.integer({ min: 0, max: 30 }), (label, padding) => {
      const doc = "p".repeat(padding) + ` [${label}](https://example.com/hiddenneedle) [[hiddenneedle|${label}]] [[hiddenneedle]]`;
      expect(search(doc, "hiddenneedle").map(match => match.from)).toEqual([doc.lastIndexOf("hiddenneedle")]);
      expect(search(doc, "hiddenneedle", false)).toHaveLength(3);
    }), { numRuns: 100 });
  });
});

describe("visible link wildcard matching", () => {
  it("does not let a hidden URL steal a visible first token", () => {
    const doc = "alpha [link](https://example.com/alpha) omega";
    const matches = computeMatches(EditorState.create({ doc }), "alpha omega", true, true);
    expect(matches.map(({ chars }) => chars)).toEqual([[
      { from: 0, to: 5 }, { from: doc.indexOf("omega"), to: doc.indexOf("omega") + 5 },
    ]]);
  });

  it("does not accept a query token from a hidden destination", () => {
    const doc = "[alpha](https://example.com/hiddenneedle) omega";
    expect(computeMatches(EditorState.create({ doc }), "alpha hiddenneedle omega", true, true)).toEqual([]);
  });

  it("matches visible text across a link without highlighting its hidden syntax", () => {
    const doc = "alpha [theory](https://example.com/hiddenneedle) omega";
    const matches = computeMatches(EditorState.create({ doc }), '"alpha theory omega"', true, true);
    expect(matches).toHaveLength(1);
    expect(matches[0].chars?.map(({ from, to }) => doc.slice(from, to)).join("")).toBe("alpha theory omega");
    expect(matches[0].chars?.some(({ from, to }) => doc.slice(from, to).includes("hiddenneedle"))).toBe(false);
  });

  it("applies wildcard gap limits to visible text rather than a hidden URL", () => {
    const doc = "[alpha](https://example.com/" + "hidden".repeat(20) + ") omega";
    const state = EditorState.create({ doc });
    expect(computeMatches(state, "alpha omega", true, true, undefined, { maxGapChars: 1 })).toHaveLength(1);
    expect(computeMatches(state, "alpha omega", true, false, undefined, { maxGapChars: 1 })).toEqual([]);
  });
});
