import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { type Config, parseConfig } from "../src/config.ts";
import type { Frontmatter } from "../src/schema.ts";
import { score } from "../src/score.ts";
import { validFrontmatter } from "./helpers.ts";

function config(weights: Record<string, number> = {}): Config {
  const { config, issues } = parseConfig(
    stringify({
      version: 1,
      team: {
        members: [
          { id: "dana", role: "senior" },
          { id: "lee", role: "member" },
        ],
      },
      areas: { integrations: ["services/**"] },
      scoring: { weights },
    }),
  );
  if (!config) throw new Error(JSON.stringify(issues));
  return config;
}

type Patch = Omit<Partial<Frontmatter>, "source"> & { source?: Partial<Frontmatter["source"]> };

const fm = (patch: Patch = {}): Frontmatter => {
  const base = validFrontmatter() as Frontmatter;
  return { ...base, ...patch, source: { ...base.source, author: "lee", ...patch.source } };
};

describe("score", () => {
  test("accepted PR feedback (comment followed by a code change) is +3", () => {
    expect(score(fm(), { config: config() })).toMatchObject({
      score: 3,
      reasons: [{ signal: "prFeedbackChangedCode", delta: 3 }],
    });
  });

  test("PR feedback without a code change is worth nothing by default", () => {
    expect(score(fm({ source: { changedCode: false } }), { config: config() }).score).toBe(0);
  });

  test.each([
    ["manual", 2],
    ["agent-handoff", 0],
    ["deep-dive", 0],
  ] as const)("source.type %s has base %i", (type, expected) => {
    const entry = fm({ source: { type, url: undefined, changedCode: undefined } });
    expect(score(entry, { config: config() }).score).toBe(expected);
  });

  test("a senior author adds +1", () => {
    const result = score(fm({ source: { author: "dana" } }), { config: config() });
    expect(result.score).toBe(4);
    expect(result.reasons.map((r) => r.signal)).toEqual(["prFeedbackChangedCode", "seniorAuthor"]);
  });

  test("an unknown author gets no seniority bonus", () => {
    expect(score(fm({ source: { author: "ghost" } }), { config: config() }).score).toBe(3);
  });

  test("a conflict is -2, counted once however many entries it conflicts with", () => {
    const entry = fm({ status: "disputed", conflictsWith: ["a", "b"] });
    expect(score(entry, { config: config() }).score).toBe(1);
  });

  test("each open flag is -2", () => {
    expect(score(fm(), { config: config(), flags: 2 }).score).toBe(-1);
  });

  test("weights come from the config", () => {
    const c = config({ prFeedbackChangedCode: 5, seniorAuthor: 2 });
    expect(score(fm({ source: { author: "dana" } }), { config: c }).score).toBe(7);
  });

  test("zero-weight signals are not listed as reasons", () => {
    const entry = fm({ source: { type: "agent-handoff", url: undefined, changedCode: undefined } });
    expect(score(entry, { config: config() }).reasons).toEqual([]);
  });
});
