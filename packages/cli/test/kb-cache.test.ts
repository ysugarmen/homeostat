import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKbView, validate } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { loadKbInForce } from "../src/kb-cache.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;

describe("the parsed KB cache for hooks", () => {
  test("parses once per state of the clone, and never serves a stale one", () => {
    const kb = mkdtempSync(join(tmpdir(), "homeostat-cache-"));
    cpSync(starter, kb, { recursive: true });
    const cache = join(kb, ".homeostat", "cache");

    const first = loadKbInForce(kb);
    expect(first.entries.length).toBeGreaterThan(0);
    const [file] = readdirSync(cache);
    expect(file).toMatch(/^kb-[0-9a-f]{32}\.json$/);
    // The second load reads the cache: equal to a fresh parse.
    const again = loadKbInForce(kb);
    expect(again).toEqual(JSON.parse(JSON.stringify(first)));
    const fresh = validate(readKbView(kb, { inForce: true }).files, { checks: false });
    expect(again.entries.map((e) => e.entry.frontmatter.id)).toEqual(
      fresh.entries.map((e) => e.entry.frontmatter.id),
    );

    // A rule changes: a new key, the old cache gone, the change read.
    const rule = join(kb, "knowledge/core/redact-before-logging.md");
    writeFileSync(rule, readFileSync(rule, "utf8").replace("score: 2", "score: 3"));
    const changed = loadKbInForce(kb);
    expect(
      changed.entries.find((e) => e.entry.frontmatter.id === "redact-before-logging")?.entry
        .frontmatter.score,
    ).toBe(3);
    const files = readdirSync(cache);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(file);
  });
});
