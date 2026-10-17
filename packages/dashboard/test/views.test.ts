import { parseConfig, parseEntry } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { entryPage, eventsPage, gauge, schedule } from "../src/views.ts";

describe("schedule", () => {
  test("common cron shapes read as words; anything else is shown as is", () => {
    expect(schedule("0 6 * * *")).toBe("daily at 06:00 UTC");
    expect(schedule("30 7 * * 1")).toBe("Mondays at 07:30 UTC");
    expect(schedule("*/15 * * * *")).toBe("*/15 * * * * UTC");
  });
});

describe("eventsPage", () => {
  const events = [
    { ts: "2026-10-17T10:00:00Z", type: "injection", entries: [], tokens: 0 },
    { ts: "2026-10-17T09:00:00Z", type: "entry-flagged", id: "x", by: "dana", reason: "moved" },
  ];
  test("counts each type and filters to one", () => {
    const all = eventsPage(events);
    expect(all).toContain('href="/events?type=injection"');
    expect(all).toContain("entry-flagged 1");
    const one = eventsPage(events, "entry-flagged");
    expect(one).toContain("x by dana: moved");
    expect(one).not.toContain("0 rules");
  });
});

describe("entryPage", () => {
  test("a rejected decision shows its proposal and why not, never as a rule", () => {
    const text = `---
id: put-a-graphql-gateway
title: Put a GraphQL gateway in front of partner APIs
status: accepted
area: core
scope: ["**"]
owner: dana
kind: decision
adopted: false
source: { type: manual, author: dana }
created: 2026-10-16
lastConfirmed: 2026-10-16
score: 3
tokens: 40
---

## Rule
Route partner calls through a GraphQL gateway.

## Why
Partners change shapes weekly and the gateway schema would lag.
`;
    const entry = parseEntry(text).entry;
    const config = parseConfig(
      "version: 1\nteam:\n  members:\n    - { id: dana, handle: '@dana', role: senior, areas: [] }\nareas: {}\n",
    ).config;
    if (!entry || !config) throw new Error("fixture");
    const html = entryPage(entry, config);
    expect(html).toContain("decided against");
    expect(html).toContain('<span class="label">Proposal</span>');
    expect(html).toContain('<span class="label">Why not</span>');
    expect(html).not.toContain('<span class="label">Rule</span>');
  });
});

describe("gauge", () => {
  test("the needle stands upright when steady and swings further the further things drift", () => {
    expect(gauge("good")).toContain("rotate(0 60 66)");
    expect(gauge("warning")).toContain("rotate(30 60 66)");
    expect(gauge("critical")).toContain("rotate(62 60 66)");
    expect(gauge("off")).toContain("rotate(-66 60 66)");
    expect(gauge("warning", 120, "Developer sync: needs attention")).toContain(
      'aria-label="Developer sync: needs attention"',
    );
  });
});
