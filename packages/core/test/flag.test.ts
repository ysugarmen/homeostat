import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { checkEntry } from "../src/check.ts";
import { parseConfig } from "../src/config.ts";
import { parseEntry } from "../src/entry.ts";
import { flagEntry } from "../src/flag.ts";
import { score } from "../src/score.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;
const config = parseConfig(readFileSync(`${starter}homeostat.yaml`, "utf8")).config;
const path = "knowledge/integrations/outbound-http-retry-helper.md";
const entry = parseEntry(readFileSync(`${starter}${path}`, "utf8")).entry;

describe("flagEntry", () => {
  test("adds the flag, sends an accepted entry to review and lowers the score", () => {
    if (!config || !entry) throw new Error("fixture");
    const text = flagEntry(
      entry,
      { by: "lee", reason: "withRetry was removed in v3", date: "2026-10-14" },
      config,
    );
    const flagged = parseEntry(text).entry;
    expect(flagged?.frontmatter.flags).toEqual([
      { by: "lee", reason: "withRetry was removed in v3", date: "2026-10-14" },
    ]);
    expect(flagged?.frontmatter.status).toBe("disputed");
    expect(flagged?.frontmatter.score).toBe(entry.frontmatter.score - 2);
    expect(flagged?.body).toBe(entry.body);
  });

  test("each further flag costs another 2", () => {
    if (!config || !entry) throw new Error("fixture");
    const once = parseEntry(
      flagEntry(entry, { by: "lee", reason: "a", date: "2026-10-14" }, config),
    ).entry;
    if (!once) throw new Error("once");
    const twice = parseEntry(
      flagEntry(once, { by: "sam", reason: "b", date: "2026-10-14" }, config),
    ).entry;
    expect(twice?.frontmatter.score).toBe(entry.frontmatter.score - 4);
    expect(score(twice?.frontmatter ?? entry.frontmatter, { config }).reasons.at(-1)).toMatchObject(
      {
        signal: "flag",
        delta: -4,
      },
    );
  });

  test("a flag by someone outside the team is reported", () => {
    if (!config || !entry) throw new Error("fixture");
    const flagged = parseEntry(
      flagEntry(entry, { by: "ghost", reason: "r", date: "2026-10-14" }, config),
    ).entry;
    if (!flagged) throw new Error("flagged");
    const codes = checkEntry(flagged, {
      path,
      areas: Object.keys(config.areas),
      autoMergeThreshold: 3,
      members: config.team.members.map((m) => m.id),
    }).map((i) => i.message);
    expect(codes).toContain('flags.0.by: "ghost" is not a team member');
  });
});
