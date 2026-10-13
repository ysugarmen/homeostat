import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ClaudeClient } from "../src/claude.ts";
import {
  ClaudeConflictJudge,
  ClaudeMerger,
  type ConflictJudge,
  deepDive,
  type Merger,
} from "../src/deepdive.ts";
import { type Entry, formatEntry, parseEntry } from "../src/entry.ts";
import type { Frontmatter } from "../src/schema.ts";
import { countTokens } from "../src/tokens.ts";
import { validate } from "../src/validate.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;
const TODAY = "2026-10-13";
const KEEP = "knowledge/integrations/outbound-http-retry-helper.md";
const DUP = "knowledge/integrations/retry-helper-for-all-outbound-http.md";

function entryText(
  fm: Partial<Frontmatter> & { id: string },
  rule = "Rule text.",
  why = "Why text.",
) {
  const body = `## Rule\n${rule}\n\n## Why\n${why}`;
  const full: Frontmatter = {
    title: `Title ${fm.id}`,
    area: "integrations",
    scope: ["services/integrations/**"],
    status: "accepted",
    score: 3,
    owner: "dana",
    source: { type: "manual", author: "dana" },
    created: "2026-10-01",
    lastConfirmed: "2026-10-01",
    tokens: countTokens(body),
    ...fm,
  };
  return formatEntry(full, body);
}

/** The starter KB plus a near-duplicate of its retry-helper entry. */
function kb(extra: Record<string, string> = {}) {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".md") || f.endsWith(".yaml")) files[f] = readFileSync(join(starter, f), "utf8");
  }
  delete files["README.md"];
  files[DUP] = entryText(
    {
      id: "retry-helper-for-all-outbound-http",
      title: "Use the shared retry helper for all outbound HTTP calls",
      scope: ["services/integrations/**", "services/payments/**"],
      created: "2026-10-10",
      lastConfirmed: "2026-10-10",
    },
    "Every outbound HTTP call goes through withRetry().",
    "Hand-rolled retries skipped the request-id header.",
  );
  return { ...files, ...extra };
}

const fm = (text: string) => parseEntry(text).entry?.frontmatter;
const change = (result: Awaited<ReturnType<typeof deepDive>>, path: string) =>
  result.changes.find((c) => c.path === path);

describe("deepDive: duplicates", () => {
  test("merges two seeded duplicates into the higher-scoring entry", async () => {
    const result = await deepDive({ files: kb(), today: TODAY });
    expect(result.changes.map((c) => c.path).sort()).toEqual([KEEP, DUP].sort());

    const keep = fm(change(result, KEEP)?.text ?? "");
    expect(keep).toMatchObject({
      status: "accepted",
      supersedes: "retry-helper-for-all-outbound-http",
      lastConfirmed: TODAY,
      scope: ["services/integrations/**", "packages/http-client/**", "services/payments/**"],
    });
    expect(fm(change(result, DUP)?.text ?? "")?.status).toBe("retired");
    expect(change(result, KEEP)?.actions).toEqual([
      { action: "merged", note: "absorbed retry-helper-for-all-outbound-http" },
    ]);

    const after = { ...kb(), ...Object.fromEntries(result.changes.map((c) => [c.path, c.text])) };
    expect(validate(after).issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("with a merger, the survivor gets the combined text", async () => {
    const merger: Merger = {
      merge: async () => ({
        title: "Route every outbound HTTP call through withRetry",
        rule: "Wrap every outbound HTTP call in withRetry() from @app/http-client.",
        why: "It adds backoff and the request-id header that hand-rolled retries skipped.",
      }),
    };
    const result = await deepDive({ files: kb(), today: TODAY, merger });
    const keep = parseEntry(change(result, KEEP)?.text ?? "").entry;
    expect(keep?.frontmatter.title).toBe("Route every outbound HTTP call through withRetry");
    expect(keep?.sections.rule).toBe(
      "Wrap every outbound HTTP call in withRetry() from @app/http-client.",
    );
    expect(keep?.sections.example).toContain("withRetry"); // the survivor's example is kept
  });

  test("unusable merged text is ignored with a note", async () => {
    const merger: Merger = {
      merge: async () => ({ title: "T", rule: Array(70).fill("word").join(" "), why: "W" }),
    };
    const result = await deepDive({ files: kb(), today: TODAY, merger });
    expect(fm(change(result, KEEP)?.text ?? "")?.title).toBe(
      "Use the shared retry helper for outbound HTTP calls",
    );
    expect(result.notes[0]).toContain("## Rule has 70 words");
  });

  test("a survivor that already supersedes something is left for a human", async () => {
    const files = kb();
    files[KEEP] = (files[KEEP] ?? "").replace(
      "status: accepted",
      "status: accepted\nsupersedes: old-retry",
    );
    files["knowledge/integrations/old-retry.md"] = entryText({
      id: "old-retry",
      status: "retired",
    });
    const result = await deepDive({ files, today: TODAY });
    expect(change(result, DUP)).toBeUndefined();
    expect(result.notes[0]).toContain("merge them by hand");
  });
});

describe("deepDive: staleness", () => {
  test("accepted entries not confirmed within staleAfterDays are retired", async () => {
    const files = kb({
      "knowledge/core/old-rule.md": entryText({
        id: "old-rule",
        area: "core",
        scope: ["**"],
        lastConfirmed: "2026-03-01",
        created: "2026-03-01",
      }),
    });
    const result = await deepDive({ files, today: TODAY });
    const old = change(result, "knowledge/core/old-rule.md");
    expect(fm(old?.text ?? "")?.status).toBe("retired");
    expect(old?.actions[0]?.note).toBe("not confirmed for 226 days (limit 180)");
  });
});

describe("deepDive: conflicts", () => {
  const files = () => {
    const f = kb();
    delete f[DUP];
    f["knowledge/integrations/no-retries.md"] = entryText({
      id: "no-retries",
      title: "Never retry partner calls",
      scope: ["services/integrations/**"],
      created: "2026-10-12",
      lastConfirmed: "2026-10-12",
    });
    return f;
  };

  test("this week's entries are checked against overlapping accepted ones, once per pair", async () => {
    const asked: { entry: string; candidates: string[] }[] = [];
    const judge: ConflictJudge = {
      conflicts: async (entry: Entry, candidates: Entry[]) => {
        asked.push({
          entry: entry.frontmatter.id,
          candidates: candidates.map((c) => c.frontmatter.id),
        });
        return entry.frontmatter.id === "no-retries"
          ? [{ id: "outbound-http-retry-helper", reason: "one says always retry, the other never" }]
          : [];
      },
    };
    const result = await deepDive({ files: files(), today: TODAY, judge });
    expect(asked).toEqual([
      { entry: "no-retries", candidates: ["redact-before-logging", "outbound-http-retry-helper"] },
    ]);
    for (const path of [KEEP, "knowledge/integrations/no-retries.md"]) {
      const e = fm(change(result, path)?.text ?? "");
      expect(e?.status).toBe("disputed");
      expect(e?.conflictsWith).toHaveLength(1);
    }
    expect(fm(change(result, KEEP)?.text ?? "")?.score).toBe(2); // 4 minus the conflict weight
  });

  test("the judge cannot name entries it was not shown", async () => {
    const judge: ConflictJudge = {
      conflicts: async () => [{ id: "use-design-tokens-for-colors", reason: "made up" }],
    };
    const result = await deepDive({ files: files(), today: TODAY, judge });
    expect(result.changes).toEqual([]);
  });
});

test("a tidy KB produces no changes", async () => {
  const f = kb();
  delete f[DUP];
  expect(await deepDive({ files: f, today: TODAY })).toEqual({ changes: [], notes: [] });
});

describe("Claude merger and judge", () => {
  function stub(parsed: unknown) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { stop_reason: "end_turn", parsed_output: parsed };
          },
        },
      },
    } as unknown as ClaudeClient;
    return { client, calls };
  }
  const entries = () => {
    const files = kb();
    return validate(files).entries.map((e) => e.entry);
  };

  test("the merger sends both entries and returns the combined text", async () => {
    const { client, calls } = stub({ title: " T ", rule: "R", why: "W" });
    const [a, b] = entries();
    const merged = await new ClaudeMerger({
      client,
      model: "claude-opus-5-5",
      effort: "medium",
    }).merge(a as Entry, b as Entry);
    expect(merged).toEqual({ title: "T", rule: "R", why: "W" });
    expect(String((calls[0]?.messages as { content: string }[])[0]?.content)).toContain(
      `id: ${(a as Entry).frontmatter.id}`,
    );
  });

  test("the judge drops ids that were not among the candidates", async () => {
    const [a, b] = entries();
    const { client } = stub({
      conflicts: [
        { id: (b as Entry).frontmatter.id, reason: "r" },
        { id: "invented", reason: "r" },
      ],
    });
    const found = await new ClaudeConflictJudge({ client, model: "m", effort: "low" }).conflicts(
      a as Entry,
      [b as Entry],
    );
    expect(found).toEqual([{ id: (b as Entry).frontmatter.id, reason: "r" }]);
  });
});
