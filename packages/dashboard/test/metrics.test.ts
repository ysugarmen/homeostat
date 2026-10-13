import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Event, validate } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import {
  agentLiveness,
  contributions,
  coverage,
  desirePaths,
  health,
  impact,
  type Snapshot,
} from "../src/metrics.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;

function snapshot(events: Event[] = [], now = "2026-10-14T12:00:00Z"): Snapshot {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if ((f.endsWith(".md") || f.endsWith(".yaml")) && f !== "README.md")
      files[f] = readFileSync(join(starter, f), "utf8");
  }
  const kb = validate(files);
  if (!kb.config) throw new Error("config");
  return { config: kb.config, entries: kb.entries.map((e) => e.entry), events, now: new Date(now) };
}

const ev = (ts: string, type: string, rest: Record<string, unknown> = {}): Event => ({
  ts,
  type,
  ...rest,
});

describe("agent liveness", () => {
  test("last run, last success, failures this week and the next scheduled run", () => {
    const [curator, deepDive] = agentLiveness(
      snapshot([
        ev("2026-10-12T06:00:00Z", "agent-run", {
          agent: "curator",
          ok: true,
          summary: "2 drafted",
        }),
        ev("2026-10-13T06:00:00Z", "agent-run", {
          agent: "curator",
          ok: false,
          summary: "no token",
        }),
      ]),
    );
    expect(curator).toMatchObject({
      agent: "curator",
      lastRun: { ts: "2026-10-13T06:00:00Z", ok: false, summary: "no token" },
      lastSuccess: "2026-10-12T06:00:00Z",
      failures7d: 1,
      nextRun: "2026-10-15T06:00:00.000Z",
    });
    expect(deepDive?.lastRun).toBeUndefined();
    expect(deepDive?.nextRun).toBe("2026-10-19T07:00:00.000Z");
  });
});

describe("health", () => {
  test("counts by status and the stability share", () => {
    const h = health(snapshot());
    expect(h.byStatus).toEqual({ candidate: 1, accepted: 2, disputed: 0, retired: 0 });
    expect(h.stability).toBeCloseTo(2 / 3);
    expect(h.stale).toEqual([]);
  });

  test("old confirmations are stale and lower stability", () => {
    const h = health(snapshot([], "2027-06-01T00:00:00Z"));
    expect(h.stale.sort()).toEqual(["outbound-http-retry-helper", "redact-before-logging"]);
    expect(h.stability).toBe(0);
  });
});

describe("contributions", () => {
  test("alphabetical, never ranked", () => {
    const c = contributions(
      snapshot([ev("2026-10-13T00:00:00Z", "entry-created", { author: "lee" })]),
    );
    expect(c.map((x) => x.member)).toEqual(["dana", "lee", "sam"]);
    expect(c.find((x) => x.member === "lee")).toMatchObject({
      authored: 2,
      accepted: 1,
      acceptedRatio: 0.5,
      captured30d: 1,
    });
    expect(c.find((x) => x.member === "sam")?.acceptedRatio).toBeUndefined();
  });
});

describe("coverage", () => {
  test("accepted entries per area, and areas with none", () => {
    const { areas, sources } = coverage(snapshot());
    expect(areas).toEqual([
      { area: "core", globs: ["**"], accepted: 1, candidates: 0 },
      {
        area: "integrations",
        globs: ["services/integrations/**", "packages/http-client/**"],
        accepted: 1,
        candidates: 0,
      },
      { area: "frontend", globs: ["apps/web/**", "packages/ui/**"], accepted: 0, candidates: 1 },
    ]);
    expect(sources).toEqual([
      { repo: "acme/integrations-api", entries: 1 },
      { repo: "acme/web-app", entries: 0 },
    ]);
  });
});

describe("impact", () => {
  test("injections per day, per session, top rules and tool use", () => {
    const i = impact(
      snapshot([
        ev("2026-10-13T09:00:00Z", "injection", {
          session: "a",
          tokens: 100,
          entries: [{ id: "x" }, { id: "y" }],
        }),
        ev("2026-10-14T09:00:00Z", "injection", {
          session: "b",
          tokens: 50,
          entries: [{ id: "x" }],
        }),
        ev("2026-10-14T10:00:00Z", "mcp-call", { tool: "search" }),
      ]),
    );
    expect(i.injectionsByDay).toHaveLength(14);
    expect(i.injectionsByDay.slice(-2)).toEqual([
      { day: "2026-10-13", count: 1 },
      { day: "2026-10-14", count: 1 },
    ]);
    expect(i).toMatchObject({ sessions: 2, rulesPerInjection: 1.5, tokensPerInjection: 75 });
    expect(i.topRules).toEqual([
      { id: "x", injections: 2 },
      { id: "y", injections: 1 },
    ]);
    expect(i.toolUse).toEqual([{ tool: "search", calls: 1 }]);
  });
});

describe("desire paths", () => {
  test("guessed names with counts, the resolved tool, most frequent first", () => {
    expect(
      desirePaths(
        snapshot([
          ev("2026-10-13T00:00:00Z", "mcp-alias", { name: "get_rules", resolved: "context" }),
          ev("2026-10-14T00:00:00Z", "mcp-alias", { name: "get_rules", resolved: "context" }),
          ev("2026-10-14T01:00:00Z", "mcp-unknown-tool", { name: "summarize" }),
        ]),
      ),
    ).toEqual([
      { name: "get_rules", resolved: "context", count: 2, last: "2026-10-14T00:00:00Z" },
      { name: "summarize", count: 1, last: "2026-10-14T01:00:00Z" },
    ]);
  });
});
