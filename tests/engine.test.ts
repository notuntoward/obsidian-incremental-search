import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { mockFileCache } from "./__mocks__/obsidian";
import {
  isCaseSensitive,
  parseFuzzyQuery,
  findFuzzyMatches,
  findLiteralMatches,
  computeMatches,
} from "../src/engine";

describe("engine: isCaseSensitive", () => {
  it("returns false for lowercase queries", () => {
    expect(isCaseSensitive("hello")).toBe(false);
    expect(isCaseSensitive("hello world")).toBe(false);
    expect(isCaseSensitive("123 !@#")).toBe(false);
    expect(isCaseSensitive("")).toBe(false);
  });

  it("returns true if any uppercase character is present", () => {
    expect(isCaseSensitive("Hello")).toBe(true);
    expect(isCaseSensitive("hello World")).toBe(true);
    expect(isCaseSensitive("KAN")).toBe(true);
    expect(isCaseSensitive("a B c")).toBe(true);
  });
});

describe("engine: parseFuzzyQuery (space-as-wildcard)", () => {
  it("handles empty query", () => {
    expect(parseFuzzyQuery("", false)).toEqual([]);
  });

  it("handles single word", () => {
    expect(parseFuzzyQuery("hello", false)).toEqual(["hello"]);
    expect(parseFuzzyQuery("Hello", false)).toEqual(["hello"]);
    expect(parseFuzzyQuery("Hello", true)).toEqual(["Hello"]);
  });

  it("treats 1 space as a wildcard gap between tokens", () => {
    expect(parseFuzzyQuery("hello world", false)).toEqual(["hello", "world"]);
    expect(parseFuzzyQuery("a b c", false)).toEqual(["a", "b", "c"]);
  });

  it("treats 2 spaces as exactly 1 literal space", () => {
    expect(parseFuzzyQuery("hello  world", false)).toEqual(["hello world"]);
    expect(parseFuzzyQuery("the  KAN", false)).toEqual(["the kan"]);
    expect(parseFuzzyQuery("the  KAN", true)).toEqual(["the KAN"]);
  });

  it("treats 3 spaces as exactly 2 literal spaces", () => {
    expect(parseFuzzyQuery("hello   world", false)).toEqual(["hello  world"]);
  });

  it("treats N spaces as N-1 literal spaces", () => {
    expect(parseFuzzyQuery("hello    world", false)).toEqual(["hello   world"]);
    expect(parseFuzzyQuery("a     b", false)).toEqual(["a    b"]);
  });

  it("handles mixed space sequences", () => {
    // "a  b c   d" -> "a" + 1-space + "b", wildcard, "c" + 2-spaces + "d"
    expect(parseFuzzyQuery("a  b c   d", false)).toEqual(["a b", "c  d"]);
  });

  it("handles leading and trailing spaces", () => {
    expect(parseFuzzyQuery(" hello ", false)).toEqual(["hello"]);
    expect(parseFuzzyQuery("  hello", false)).toEqual([" hello"]);
    expect(parseFuzzyQuery("hello  ", false)).toEqual(["hello "]);
  });
});

describe("engine: findFuzzyMatches", () => {
  it("returns empty array for empty query or whitespace wildcard", () => {
    expect(findFuzzyMatches("some text", "", 0, false)).toEqual([]);
    expect(findFuzzyMatches("some text", " ", 0, false)).toEqual([]);
  });

  it("matches single token in text", () => {
    const matches = findFuzzyMatches("the quick brown fox", "quick", 0, false);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      from: 4,
      to: 9,
      chars: [{ from: 4, to: 9 }],
    });
  });

  it("matches sequential tokens with wildcard gap (1 space)", () => {
    const text = "paper, while the original KAN paper's";
    const matches = findFuzzyMatches(text, "the KAN", 0, false);
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(13); // "the" starts at 13
    expect(matches[0].to).toBe(29);   // "KAN" ends at 29
    expect(matches[0].chars).toEqual([
      { from: 13, to: 16 }, // "the"
      { from: 26, to: 29 }, // "KAN"
    ]);
  });

  it("requires literal space when 2 spaces are typed", () => {
    const text = "the original KAN and the KAN";
    // "the  KAN" requires "the KAN" literally (1 space)
    const matches = findFuzzyMatches(text, "the  KAN", 0, false);
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(21); // second "the KAN"
    expect(matches[0].to).toBe(28);
  });

  it("respects case sensitivity when enabled", () => {
    const text = "KAN and kan and Kan";
    const insensitiveMatches = findFuzzyMatches(text, "kan", 0, false);
    expect(insensitiveMatches).toHaveLength(3);

    const sensitiveMatches = findFuzzyMatches(text, "KAN", 0, true);
    expect(sensitiveMatches).toHaveLength(1);
    expect(sensitiveMatches[0].from).toBe(0);
    expect(sensitiveMatches[0].to).toBe(3);
  });

  it("applies offset correctly to all returned positions", () => {
    const matches = findFuzzyMatches("hello world", "world", 100, false);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      from: 106,
      to: 111,
      chars: [{ from: 106, to: 111 }],
    });
  });

  it("handles regex special characters safely as literals", () => {
    const text = "function(a: string): boolean { return [a, b].includes(c); }";
    const matches = findFuzzyMatches(text, "(a: [a, b]", 0, false);
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(8);
    expect(matches[0].to).toBe(44);
  });

  it("finds multiple non-overlapping matches across the line", () => {
    const text = "the fox and the dog";
    const matches = findFuzzyMatches(text, "the", 0, false);
    expect(matches).toHaveLength(2);
    expect(matches[0].from).toBe(0);
    expect(matches[0].to).toBe(3);
    expect(matches[1].from).toBe(12);
    expect(matches[1].to).toBe(15);
  });
});

describe("engine: findLiteralMatches", () => {
  it("returns empty array for empty query", () => {
    expect(findLiteralMatches("some text", "", 0, false)).toEqual([]);
  });

  it("finds all literal occurrences with case matching", () => {
    const text = "abc ABC abc";
    expect(findLiteralMatches(text, "abc", 0, false)).toHaveLength(3);
    expect(findLiteralMatches(text, "ABC", 0, true)).toHaveLength(1);
    expect(findLiteralMatches(text, "ABC", 0, true)[0]).toEqual({ from: 4, to: 7 });
  });

  it("handles offset and special characters safely", () => {
    const text = "cost is $10.00 each";
    const matches = findLiteralMatches(text, "$10.00", 50, false);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ from: 58, to: 64 });
  });
});

describe("engine: computeMatches", () => {
  it("computes matches across multi-line EditorState documents", () => {
    const state = EditorState.create({
      doc: "Line 1: first match\nLine 2: second match\nLine 3: third",
    });

    const matches = computeMatches(state, "match", true, false);
    expect(matches).toHaveLength(2);
    expect(matches[0].from).toBe(14);
    expect(matches[0].to).toBe(19);
    expect(matches[1].from).toBe(35);
    expect(matches[1].to).toBe(40);
  });

  it("returns empty array for empty query in computeMatches", () => {
    const state = EditorState.create({ doc: "Hello world" });
    expect(computeMatches(state, "", true, false)).toEqual([]);
    expect(computeMatches(state, "", false, false)).toEqual([]);
  });

  it("filters out hidden URLs in markdown links when matchOnlyVisibleLinks is true", () => {
    const doc = "Here is a [link to match](http://match.com)";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "http://match.com",
        original: "[link to match](http://match.com)",
        displayText: "link to match",
        position: {
          start: { line: 0, col: 10, offset: 10 },
          end: { line: 0, col: 43, offset: 43 }
        }
      }]
    });

    // Both should find 'match' in the visible text
    let matches = computeMatches(state, "match", false, true, cache);
    expect(matches).toHaveLength(1); // Only the visible "match"
    expect(matches[0].from).toBe(19);

    matches = computeMatches(state, "match", false, false, cache);
    expect(matches).toHaveLength(2); // Visible "match" and hidden URL "match"
  });

  it("filters out hidden destinations in wikilinks when matchOnlyVisibleLinks is true", () => {
    const doc = "Check out [[hidden_match|visible alias]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "hidden_match",
        original: "[[hidden_match|visible alias]]",
        displayText: "visible alias",
        position: {
          start: { line: 0, col: 10, offset: 10 },
          end: { line: 0, col: 40, offset: 40 }
        }
      }]
    });

    let matches = computeMatches(state, "match", false, true, cache);
    expect(matches).toHaveLength(0); // The word "match" is entirely hidden

    matches = computeMatches(state, "match", false, false, cache);
    expect(matches).toHaveLength(1); // Hidden "match" is found
  });

  it("filters out hidden destinations in wikilinks (regression)", () => {
    const doc = "[[Lee24aerobicResistTrnCVrisk|this study]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "Lee24aerobicResistTrnCVrisk",
        original: "[[Lee24aerobicResistTrnCVrisk|this study]]",
        displayText: "this study",
        position: {
          start: { line: 0, col: 0, offset: 0 },
          end: { line: 0, col: 42, offset: 42 }
        }
      }]
    });
    const matches = computeMatches(state, "resist", true, true, cache);
    expect(matches).toHaveLength(0);
  });

  it("does not filter out bare wikilinks", () => {
    const doc = "Check out [[bare match]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "bare match",
        original: "[[bare match]]",
        displayText: "bare match",
        position: {
          start: { line: 0, col: 10, offset: 10 },
          end: { line: 0, col: 24, offset: 24 }
        }
      }]
    });

    const matches = computeMatches(state, "match", false, true, cache);
    expect(matches).toHaveLength(1); // Bare wikilink destination is visible
  });

  // NEW FIXTURE-BASED TESTS
  it("filters out hidden heading subpath with alias", () => {
    const doc = "[[dest#heading|alias]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "dest",
        original: "[[dest#heading|alias]]",
        displayText: "alias",
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 22, offset: 22 } }
      }]
    });
    const matches = computeMatches(state, "heading", false, true, cache);
    expect(matches).toHaveLength(0);
  });

  it("filters out hidden block reference with alias", () => {
    const doc = "[[dest^blockref|alias]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "dest",
        original: "[[dest^blockref|alias]]",
        displayText: "alias",
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 23, offset: 23 } }
      }]
    });
    const matches = computeMatches(state, "blockref", false, true, cache);
    expect(matches).toHaveLength(0);
  });

  it("does not incorrectly hide subpath without alias", () => {
    const doc = "[[dest#heading]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "dest",
        original: "[[dest#heading]]",
        displayText: "dest > heading", // Obsidian often formats bare subpaths this way
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 16, offset: 16 } }
      }]
    });
    const matches = computeMatches(state, "heading", false, true, cache);
    expect(matches).toHaveLength(1); // visible!
  });

  it("filters out reference-style link destinations", () => {
    const doc = "[text][ref]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "ref",
        original: "[text][ref]",
        displayText: "text",
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 11, offset: 11 } }
      }]
    });
    const matches = computeMatches(state, "ref", false, true, cache);
    expect(matches).toHaveLength(0);
  });


  it("filters out link inside a YAML frontmatter block", () => {
    const doc = "---\nlink: [[hidden_dest|visible]]\n---";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      frontmatterPosition: { start: { line: 0, col: 0, offset: 0 }, end: { line: 2, col: 3, offset: 37 } }
    });
    const matches = computeMatches(state, "hidden_dest", false, true, cache);
    expect(matches).toHaveLength(0);
  });

  it("regression: always excludes frontmatter text regardless of matchOnlyVisibleLinks setting", () => {
    const doc = "---\ntags: [exercise, fitness]\nauthor: Scott\n---\nHere is the body with exercise text.";
    const state = EditorState.create({ doc });
    const frontmatterEnd = doc.indexOf("\nHere");
    const cache = mockFileCache({
      frontmatter: {
        tags: ["exercise", "fitness"],
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: frontmatterEnd } }
      },
      sections: [
        {
          type: "yaml",
          position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: frontmatterEnd } }
        },
        {
          type: "paragraph",
          position: { start: { line: 4, col: 0, offset: frontmatterEnd + 1 }, end: { line: 4, col: 36, offset: doc.length } }
        }
      ]
    });

    // Searching for "exercise" when matchOnlyVisibleLinks is FALSE
    // Should NOT match the frontmatter "tags: [exercise, fitness]"!
    // Should ONLY match "exercise" in the body line.
    const matchesWithoutLinkFiltering = computeMatches(state, "exercise", false, false, cache);
    expect(matchesWithoutLinkFiltering).toHaveLength(1);
    expect(matchesWithoutLinkFiltering[0].from).toBeGreaterThan(frontmatterEnd);

    // Searching for "Scott" which only exists in frontmatter
    const authorMatches = computeMatches(state, "Scott", false, false, cache);
    expect(authorMatches).toHaveLength(0);
  });

  it("handles standard markdown link where visible text matches query", () => {
    const doc = "Some text [Resistance training](http://example.com) more text.";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
        links: [{
            link: "http://example.com",
            original: "[Resistance training](http://example.com)",
            displayText: "Resistance training",
            position: {
                start: { line: 0, col: 10, offset: 10 },
                end: { line: 0, col: 53, offset: 53 }
            }
        }]
    });
    const matches = computeMatches(state, "Resis", false, true, cache);
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(11);
    expect(matches[0].to).toBe(16);
  });

  it("filters out exact wikilink regression case Lee24aerobicResistTrnCVrisk", () => {
    const doc = "contradicts [[Lee24aerobicResistTrnCVrisk|this study]], which found";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
        links: [{
            link: "Lee24aerobicResistTrnCVrisk",
            original: "[[Lee24aerobicResistTrnCVrisk|this study]]",
            displayText: "this study",
            position: {
                start: { line: 0, col: 12, offset: 12 },
                end: { line: 0, col: 54, offset: 54 }
            }
        }]
    });
    const matches = computeMatches(state, "resis", false, true, cache);
    expect(matches).toHaveLength(0);
  });

  it("handles adjacent links on the same line correctly", () => {
    const doc = "[[dest1|alias1]][[dest2|alias2]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [
        {
          link: "dest1",
          original: "[[dest1|alias1]]",
          displayText: "alias1",
          position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 16, offset: 16 } }
        },
        {
          link: "dest2",
          original: "[[dest2|alias2]]",
          displayText: "alias2",
          position: { start: { line: 0, col: 16, offset: 16 }, end: { line: 0, col: 32, offset: 32 } }
        }
      ]
    });
    // searching for "dest1" or "dest2" should yield 0 matches
    expect(computeMatches(state, "dest", false, true, cache)).toHaveLength(0);
  });

  it("safely handles [[note|note]] trap without matching the wrong note", () => {
    const doc = "[[note|note]]";
    const state = EditorState.create({ doc });
    const cache = mockFileCache({
      links: [{
        link: "note",
        original: "[[note|note]]",
        displayText: "note",
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 13, offset: 13 } }
      }]
    });
    // The first "note" is hidden. The second "note" is visible!
    // So searching for "note" should yield exactly 1 match (the alias).
    const matches = computeMatches(state, "note", false, true, cache);
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(7); // The alias "note" is from index 7 to 11
  });

  it("identifies matches inside table sections and extracts cell metadata", () => {
    const doc = "Header line\n| Exercise Type | Reps |\n| --- | --- |\n| Bench Press | 10 |\nFooter";
    const state = EditorState.create({ doc });
    const tableStart = doc.indexOf("| Exercise Type");
    const tableEnd = doc.indexOf("\nFooter");
    const cache = mockFileCache({
      sections: [
        {
          type: "paragraph",
          position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 11, offset: 11 } }
        },
        {
          type: "table",
          position: { start: { line: 1, col: 0, offset: tableStart }, end: { line: 3, col: 20, offset: tableEnd } }
        }
      ]
    });

    // Match inside table header: "Exercise"
    const tableMatches = computeMatches(state, "Exercise", false, false, cache);
    expect(tableMatches).toHaveLength(1);
    expect(tableMatches[0].inTable).toBe(true);
    expect(tableMatches[0].tableMatchData).toBeDefined();
    expect(tableMatches[0].tableMatchData?.cellText).toBe(" Exercise Type ");
    expect(tableMatches[0].tableMatchData?.sectionStart).toBe(tableStart);
    expect(tableMatches[0].tableMatchData?.matchStartInCell).toBe(1);
    expect(tableMatches[0].tableMatchData?.matchEndInCell).toBe(9);
    expect(tableMatches[0].tableMatchData?.rowIndex).toBe(0);
    expect(tableMatches[0].tableMatchData?.colIndex).toBe(0);

    // Match inside body cell: "10" (row 1, col 1)
    const bodyMatches = computeMatches(state, "10", false, false, cache);
    expect(bodyMatches).toHaveLength(1);
    expect(bodyMatches[0].inTable).toBe(true);
    expect(bodyMatches[0].tableMatchData?.rowIndex).toBe(1);
    expect(bodyMatches[0].tableMatchData?.colIndex).toBe(1);

    // Match outside table: "Header"
    const nonTableMatches = computeMatches(state, "Header", false, false, cache);
    expect(nonTableMatches).toHaveLength(1);
    expect(nonTableMatches[0].inTable).toBeFalsy();
    expect(nonTableMatches[0].tableMatchData).toBeUndefined();
  });

});

