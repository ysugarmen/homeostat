import { expect, test } from "vitest";
import { usageCounts } from "../src/metrics/usage.ts";
import { ev, NOW } from "./metrics-fixture.ts";

test("per-day counts for the last seven days, sessions distinct, nothing older, nothing named", () => {
  const u = usageCounts(
    [
      ev("2026-10-21T08:00:00Z", "injection", {
        session: "a",
        entries: [{ id: "x" }, { id: "y" }],
      }),
      ev("2026-10-21T09:00:00Z", "injection", {
        session: "a",
        source: "update",
        entries: [{ id: "z" }],
      }),
      ev("2026-10-21T10:00:00Z", "injection", { session: "b", source: "mcp", entries: [] }),
      ev("2026-10-21T10:01:00Z", "mcp-call", { tool: "context" }),
      ev("2026-10-21T10:02:00Z", "doc-read", { doc: "integrations/partner-calls" }),
      ev("2026-10-15T10:00:00Z", "injection", { session: "old", entries: [{ id: "x" }] }),
      // Eight days ago: outside the seven kept.
      ev("2026-10-14T10:00:00Z", "injection", { session: "older", entries: [{ id: "x" }] }),
      ev("2026-10-21T10:03:00Z", "entry-created", { id: "x" }),
    ],
    NOW,
  );
  expect(Object.keys(u)).toEqual([
    "2026-10-15",
    "2026-10-16",
    "2026-10-17",
    "2026-10-18",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
  ]);
  expect(u["2026-10-21"]).toEqual({
    sessions: 2,
    injections: 3,
    rules: 3,
    mcpCalls: 1,
    docReads: 1,
    turns: 0,
    retrievedTurns: 0,
    creditedTurns: 0,
    // An injection with no source (an older version's) is "other"; "update" is a prompt's.
    moments: { other: 2, prompt: 1, mcp: 0 },
  });
  expect(u["2026-10-15"]).toEqual({
    sessions: 1,
    injections: 1,
    rules: 1,
    mcpCalls: 0,
    docReads: 0,
    turns: 0,
    retrievedTurns: 0,
    creditedTurns: 0,
    moments: { other: 1 },
  });
  expect(u["2026-10-16"]).toEqual({
    sessions: 0,
    injections: 0,
    rules: 0,
    mcpCalls: 0,
    docReads: 0,
    turns: 0,
    retrievedTurns: 0,
    creditedTurns: 0,
  });
  expect(JSON.stringify(u)).not.toMatch(/x|partner|context/);
});

test("counts rules by moment, findings given and fixed, and commits held and changed", () => {
  const u = usageCounts(
    [
      ev("2026-10-21T08:00:00Z", "injection", {
        session: "a",
        source: "startup",
        entries: [{ id: "x" }, { id: "y" }],
      }),
      ev("2026-10-21T08:01:00Z", "injection", {
        session: "a",
        source: "file",
        entries: [{ id: "z" }],
      }),
      ev("2026-10-21T08:02:00Z", "injection", {
        session: "a",
        source: "code",
        entries: [
          { id: "f", form: "finding" },
          { id: "t", form: "title" },
        ],
      }),
      ev("2026-10-21T08:03:00Z", "finding-settled", { session: "a", id: "f", outcome: "fixed" }),
      ev("2026-10-21T08:04:00Z", "finding-settled", { session: "a", id: "g", outcome: "gone" }),
      ev("2026-10-21T08:05:00Z", "injection", {
        session: "a",
        source: "commit",
        entries: [{ id: "c" }],
      }),
      ev("2026-10-21T08:06:00Z", "commit-after-hold", { session: "a", changed: true }),
      ev("2026-10-21T08:07:00Z", "commit-after-hold", { session: "a", changed: false }),
    ],
    NOW,
  );
  expect(u["2026-10-21"]).toMatchObject({
    moments: { start: 2, file: 1, code: 2, commit: 1 },
    findings: 1,
    findingsFixed: 1,
    commitsHeld: 1,
    commitsChanged: 1,
  });
});
