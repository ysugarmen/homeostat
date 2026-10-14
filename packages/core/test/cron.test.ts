import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { cronMatches, dueAgents } from "../src/cron.ts";

const at = (iso: string) => new Date(iso);

describe("cronMatches (UTC)", () => {
  test.each([
    ["0 6 * * *", "2026-10-13T06:00:00Z", true],
    ["0 6 * * *", "2026-10-13T06:01:00Z", false],
    ["0 7 * * 1", "2026-10-12T07:00:00Z", true], // a Monday
    ["0 7 * * 1", "2026-10-13T07:00:00Z", false],
    ["*/15 * * * *", "2026-10-13T10:45:00Z", true],
    ["*/15 * * * *", "2026-10-13T10:46:00Z", false],
    ["0 9-17 * * 1-5", "2026-10-13T12:00:00Z", true],
    ["0 9-17 * * 1-5", "2026-10-11T12:00:00Z", false], // Sunday
    ["30 6,18 * * *", "2026-10-13T18:30:00Z", true],
    ["0 0 1 * *", "2026-11-01T00:00:00Z", true],
    ["0 0 * * 7", "2026-10-11T00:00:00Z", true], // 7 is Sunday too
  ])("%s at %s → %s", (expr, iso, expected) => {
    expect(cronMatches(expr, at(iso))).toBe(expected);
  });

  test("day-of-month and day-of-week both restricted means either matches", () => {
    expect(cronMatches("0 0 13 * 5", at("2026-10-13T00:00:00Z"))).toBe(true); // the 13th, a Tuesday
    expect(cronMatches("0 0 13 * 5", at("2026-10-16T00:00:00Z"))).toBe(true); // a Friday
    expect(cronMatches("0 0 13 * 5", at("2026-10-14T00:00:00Z"))).toBe(false);
  });

  test("malformed expressions never match", () => {
    expect(cronMatches("not cron", at("2026-10-13T06:00:00Z"))).toBe(false);
    expect(cronMatches("61 * * * *", at("2026-10-13T06:00:00Z"))).toBe(false);
  });
});

describe("dueAgents", () => {
  const config = parseConfig(`version: 1
team: { members: [{ id: a, role: senior }] }
areas: {}
agents:
  curator: { schedule: "0 6 * * *" }
  deepDive: { schedule: "0 6 * * 1", enabled: false }
`).config;

  test("lists enabled agents whose schedule matches the minute", () => {
    if (!config) throw new Error("config");
    expect(dueAgents(config, at("2026-10-12T06:00:00Z"))).toEqual(["curator"]);
    expect(dueAgents(config, at("2026-10-12T06:05:00Z"))).toEqual([]);
  });
});

describe("nextRun", () => {
  test("finds the next matching minute", async () => {
    const { nextRun } = await import("../src/cron.ts");
    expect(nextRun("0 6 * * *", new Date("2026-10-13T06:00:30Z"))?.toISOString()).toBe(
      "2026-10-14T06:00:00.000Z",
    );
    expect(nextRun("0 7 * * 1", new Date("2026-10-13T08:00:00Z"))?.toISOString()).toBe(
      "2026-10-19T07:00:00.000Z",
    );
    expect(nextRun("0 6 * * *", new Date("2026-10-13T05:59:00Z"))?.toISOString()).toBe(
      "2026-10-13T06:00:00.000Z",
    );
    expect(nextRun("bad", new Date())).toBeUndefined();
  });
});

test("the digest is due at 08:00 UTC on digestDay, and only with a webhook configured", async () => {
  const { digestDue } = await import("../src/cron.ts");
  const { parseConfig } = await import("../src/config.ts");
  const base = "version: 1\nteam:\n  members:\n    - { id: dana, role: senior }\nareas: {}\n";
  const withHook = parseConfig(
    `${base}notifications:\n  slackWebhookEnv: HOOK\n  digestDay: tuesday\n`,
  ).config;
  const without = parseConfig(base).config;
  if (!withHook || !without) throw new Error("bad config");
  const tuesday8 = new Date("2026-10-13T08:00:00Z"); // a Tuesday
  expect(digestDue(withHook, tuesday8)).toBe(true);
  expect(digestDue(withHook, new Date("2026-10-13T09:00:00Z"))).toBe(false);
  expect(digestDue(withHook, new Date("2026-10-12T08:00:00Z"))).toBe(false);
  expect(digestDue(without, new Date("2026-10-12T08:00:00Z"))).toBe(false);
});
