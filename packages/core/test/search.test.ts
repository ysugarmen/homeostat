import { describe, expect, test } from "vitest";
import { type Entry, formatEntry, parseEntry } from "../src/entry.ts";
import type { Frontmatter } from "../src/schema.ts";
import { searchEntries, tokenize } from "../src/search.ts";
import { countTokens } from "../src/tokens.ts";
import { validFrontmatter } from "./helpers.ts";

function entry(id: string, title: string, rule: string, patch: Partial<Frontmatter> = {}): Entry {
  const body = `## Rule\n${rule}\n\n## Why\nBecause.`;
  const { tags: _tags, ...base } = validFrontmatter() as Frontmatter;
  const fm = {
    ...base,
    id,
    title,
    tokens: countTokens(body),
    ...patch,
  };
  const parsed = parseEntry(formatEntry(fm, body)).entry;
  if (!parsed) throw new Error("fixture");
  return parsed;
}

const kb = [
  entry(
    "retry",
    "Use withRetry for outbound HTTP calls",
    "Wrap partner HTTP calls in withRetry().",
    {
      tags: ["http", "resilience"],
      scope: ["services/**"],
    },
  ),
  entry(
    "redact",
    "Redact bodies before logging",
    "Pass request bodies through redact() before logging.",
    {
      scope: ["**"],
    },
  ),
  entry(
    "tokens",
    "Use colour tokens instead of hex",
    "Use var(--color-*) in styles, never hex values.",
    {
      scope: ["web/**"],
    },
  ),
  entry("old-retry", "Retry HTTP calls three times", "Retry by hand.", { status: "retired" }),
];

const ids = (query: string, opts = {}) =>
  searchEntries(kb, query, opts).map((r) => r.entry.frontmatter.id);

describe("tokenize", () => {
  test("lowercases, splits identifiers, drops stop words (with, the, for) and stems", () => {
    expect(tokenize("Use withRetry() for the HTTP-client calls")).toEqual([
      "retry",
      "http",
      "client",
      "call",
    ]);
  });
});

describe("searchEntries", () => {
  test("finds the entry whose words match, best first", () => {
    expect(ids("how do I retry an http request")[0]).toBe("retry");
    expect(ids("logging request bodies")[0]).toBe("redact");
  });

  test("matches identifiers written differently", () => {
    expect(ids("with_retry")).toEqual(["retry"]);
    expect(ids("colour token")).toEqual(["tokens"]);
  });

  test("tags count", () => {
    expect(ids("resilience")).toEqual(["retry"]);
  });

  test("only accepted entries unless asked", () => {
    expect(ids("retry")).not.toContain("old-retry");
    expect(ids("retry", { statuses: ["accepted", "retired"] })).toContain("old-retry");
  });

  test("filters by area and by a path the entry's scope must cover", () => {
    expect(ids("hex", { path: "web/button.css" })).toEqual(["tokens"]);
    expect(ids("hex", { path: "services/api.ts" })).toEqual([]);
    expect(ids("hex", { area: "integrations" })).toEqual(["tokens"]);
    expect(ids("hex", { area: "nope" })).toEqual([]);
  });

  test("an empty or stop-word-only query returns nothing", () => {
    expect(ids("")).toEqual([]);
    expect(ids("the and of")).toEqual([]);
  });

  test("respects the limit", () => {
    expect(searchEntries(kb, "retry logging hex", { limit: 1 })).toHaveLength(1);
    expect(searchEntries(kb, "retry logging hex").length).toBeGreaterThan(1);
  });
});
