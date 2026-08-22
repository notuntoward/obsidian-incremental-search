import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
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
    const state = EditorState.create({
      doc: "Here is a [link to match](http://match.com)",
    });

    // Both should find 'match' in the visible text
    let matches = computeMatches(state, "match", false, true);
    expect(matches).toHaveLength(1); // Only the visible "match"
    expect(matches[0].from).toBe(19);

    matches = computeMatches(state, "match", false, false);
    expect(matches).toHaveLength(2); // Visible "match" and hidden URL "match"
  });

  it("filters out hidden destinations in wikilinks when matchOnlyVisibleLinks is true", () => {
    const state = EditorState.create({
      doc: "Check out [[hidden_match|visible alias]]",
    });

    let matches = computeMatches(state, "match", false, true);
    expect(matches).toHaveLength(0); // The word "match" is entirely hidden

    matches = computeMatches(state, "match", false, false);
    expect(matches).toHaveLength(1); // Hidden "match" is found
  });

  it("does not filter out bare wikilinks", () => {
    const state = EditorState.create({
      doc: "Check out [[bare match]]",
    });

    const matches = computeMatches(state, "match", false, true);
    expect(matches).toHaveLength(1); // Bare wikilink destination is visible
  });
});
