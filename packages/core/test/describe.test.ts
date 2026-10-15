import { expect, test } from "vitest";

test("explain names who approved a rule (found in the phase 1 run)", async () => {
  const { explainEntry } = await import("../src/describe.ts");
  const { parseEntry } = await import("../src/entry.ts");
  const { parseConfig } = await import("../src/config.ts");
  const config = parseConfig(
    "version: 1\nteam:\n  members:\n    - { id: dana, role: senior }\nareas: {}\n",
  ).config;
  const entry = parseEntry(`---
id: use-retry
title: Use the retry helper
area: core
scope: ["**"]
status: accepted
approvedBy: dana
score: 2
owner: dana
source: { type: manual, author: dana }
created: 2026-10-15
lastConfirmed: 2026-10-15
tokens: 10
---

## Rule
Use withRetry().

## Why
Timeouts.
`).entry;
  if (!entry || !config) throw new Error("bad fixture");
  expect(explainEntry(entry, config)).toContain("approved by dana");
});
