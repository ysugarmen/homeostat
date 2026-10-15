import { describe, expect, test } from "vitest";
import { type ConfidenceInput, confidence, explainConfidence } from "../src/confidence.ts";
import { parseConfig } from "../src/config.ts";
import type { Entry } from "../src/entry.ts";
import type { Frontmatter } from "../src/schema.ts";

function config(extra = "") {
  const c = parseConfig(`version: 1
team:
  members:
    - { id: lead, role: lead, areas: [core] }
    - { id: sam, role: senior, areas: [integrations] }
    - { id: lee, role: member, areas: [web] }
    - { id: jo, role: junior, areas: [web] }
areas:
  integrations: ["services/integrations/**"]
  web: ["apps/web/**"]
${extra}`).config;
  if (!c) throw new Error("bad config");
  return c;
}

function entry(
  fm: Partial<Frontmatter> = {},
  rule = "Wrap every partner call in withRetry() from services/integrations/http.ts.",
): Entry {
  return {
    frontmatter: {
      id: "use-retry",
      title: "Use the shared retry helper for partner calls",
      area: "integrations",
      scope: ["services/integrations/**"],
      status: "candidate",
      score: 0,
      owner: "sam",
      source: { type: "pr-feedback", url: "https://x/pull/1", author: "sam", changedCode: true },
      created: "2026-10-16",
      lastConfirmed: "2026-10-16",
      tokens: 20,
      ...fm,
    },
    body: "",
    sections: { rule, why: "Timeouts." },
  };
}

const decide = (i: Partial<ConfidenceInput> & { entry?: Entry }, extra = "") =>
  confidence({ entry: entry(), config: config(extra), originator: "sam", ...i });

describe("confidence (automation, step 3)", () => {
  test("a senior's review comment that led to a code change, in their own area, merges", () => {
    const c = decide({});
    expect(c.score).toBe(82);
    expect(c.decision).toBe("merged");
    expect(explainConfidence(c)).toBe(
      "+50 review comment followed by a code change · +14 from sam (senior) · +6 sam works in integrations · +8 names a concrete function, path or package · +4 clear title",
    );
  });

  test("the role of the person the lesson came from moves the score", () => {
    const scores = ["jo", "lee", "sam", "lead"].map((who) => decide({ originator: who }).score);
    expect(scores).toEqual([62, 68, 82, 82]); // jo 0, lee +6, sam +14 +6 owner, lead +20 (no owner bonus)
    expect(decide({ originator: "lee" }).decision).toBe("review");
    expect(decide({ originator: "jo" }).decision).toBe("review");
  });

  test("a vague, unspecific lesson from a junior is declined", () => {
    const c = decide({
      originator: "jo",
      entry: entry(
        { title: "lesson1", area: "web", source: { type: "manual", author: "jo" } },
        "stop using annotations library",
      ),
    });
    expect(c.score).toBe(36); // 45 manual + 0 junior + 6 owner - 15 vague title
    expect(
      decide({
        originator: "jo",
        entry: entry(
          { title: "lesson1", source: { type: "manual", author: "jo" } },
          "stop using annotations library",
        ),
      }).decision,
    ).toBe("declined");
  });

  test("rules that reach every session need more confidence", () => {
    const global = entry({ area: "core", scope: ["**"] });
    expect(decide({ entry: global }).score).toBe(76);
    expect(decide({ entry: global }).decision).toBe("review"); // below coreAccept 80
  });

  test("hard rules: errors and duplicates decline; risky content and contradictions go to a person", () => {
    expect(decide({ errors: ["secret.found"] }).decision).toBe("declined");
    const dup = decide({ duplicateOf: "outbound-http-retry-helper" });
    expect(dup).toMatchObject({
      decision: "declined",
      reason: "duplicate of outbound-http-retry-helper, which it reconfirms",
    });
    expect(decide({ risks: ["runs downloaded code"] }).decision).toBe("review");
    const conflict = decide({ conflictsWith: ["use-fetch-directly"] });
    expect(conflict.decision).toBe("review");
    expect(conflict.score).toBe(57);
  });

  test("repeats, the model's rating and flags count", () => {
    expect(decide({ occurrences: 3 }).score).toBe(100);
    expect(decide({ modelRating: 0 }).score).toBe(72);
    expect(
      decide({ entry: entry({ flags: [{ by: "lee", reason: "wrong", date: "2026-10-16" }] }) })
        .score,
    ).toBe(62);
  });

  test("agent-written lessons start lower", () => {
    const c = decide({
      originator: "lee",
      entry: entry({ area: "web", source: { type: "agent-handoff", author: "lee" } }),
    });
    expect(c.score).toBe(49);
    expect(c.decision).toBe("review");
  });

  test("auto-merge scope still applies: an excluded area always gets a reviewer", () => {
    const c = decide({}, "scoring:\n  autoMerge: { excludeAreas: [integrations] }\n");
    expect(c).toMatchObject({
      decision: "review",
      reason: "confidence 82; area integrations always gets a reviewer",
    });
  });

  test("thresholds and weights come from homeostat.yaml", () => {
    const strict = "scoring:\n  confidence:\n    accept: 90\n    roles: { senior: 30 }\n";
    expect(decide({}, strict)).toMatchObject({ score: 98, decision: "merged" });
  });
});
