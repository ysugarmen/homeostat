import { expect, test } from "vitest";
import {
  type DecisionRecord,
  type DecisionsFile,
  MAX_DECISIONS,
  mergeDecisions,
  mergeStateFiles,
} from "../src/automation.ts";

const record = (hash: string, decision: DecisionRecord["decision"], at: string) => ({
  path: `knowledge/core/${hash}.md`,
  id: hash,
  hash,
  decision,
  reason: decision,
  at,
});
const file = (...decided: DecisionRecord[]): DecisionsFile => ({ member: "lee", decided });
const json = (v: unknown) => `${JSON.stringify(v, null, 1)}\n`;

test("decisions merge by hash: both runs' records stay, settled beats in review, else the later", () => {
  const ours = file(
    record("a", "review", "2026-10-16T06:00:00Z"),
    record("b", "merged", "2026-10-17T06:00:00Z"),
    record("c", "review", "2026-10-17T06:00:00Z"),
  );
  const theirs = file(
    record("a", "declined", "2026-10-16T07:00:00Z"),
    record("b", "merged", "2026-10-16T06:00:00Z"),
    record("d", "merged", "2026-10-17T05:00:00Z"),
  );
  const merged = mergeDecisions(ours, theirs).decided;
  expect(merged.map((r) => [r.hash, r.decision, r.at])).toEqual([
    ["a", "declined", "2026-10-16T07:00:00Z"],
    ["b", "merged", "2026-10-17T06:00:00Z"],
    ["d", "merged", "2026-10-17T05:00:00Z"],
    ["c", "review", "2026-10-17T06:00:00Z"],
  ]);
  // A settled record wins even over a later one still in review.
  const late = mergeDecisions(
    file(record("a", "review", "2026-10-18T00:00:00Z")),
    file(record("a", "merged", "2026-10-17T00:00:00Z")),
  );
  expect(late.decided[0]?.decision).toBe("merged");
  const many = Array.from({ length: MAX_DECISIONS }, (_, i) => record(`t${i}`, "merged", "x"));
  expect(mergeDecisions(file(record("new", "merged", "y")), file(...many)).decided).toHaveLength(
    MAX_DECISIONS,
  );
});

test("state files merge per file: run reports add, heartbeats keep the newer", () => {
  const remote: Record<string, string> = {
    "runs/2026-10-17T06-00-00Z.json": '{"at":"theirs"}\n',
    "heartbeats/lee.json": '{"member":"lee","at":"2026-10-17T05:00:00Z"}\n',
    "heartbeats/sam.json": '{"member":"sam","at":"2026-10-15T05:00:00Z"}\n',
    "decisions/lee.json": json(file(record("d", "merged", "2026-10-17T05:00:00Z"))),
  };
  const out = mergeStateFiles(
    {
      "runs/2026-10-17T06-00-00Z.json": '{"at":"ours"}\n',
      "runs/2026-10-17T06-30-00Z.json": '{"at":"ours, later"}\n',
      "heartbeats/lee.json": '{"member":"lee","at":"2026-10-16T05:00:00Z"}\n',
      "heartbeats/sam.json": '{"member":"sam","at":"2026-10-16T05:00:00Z"}\n',
      "decisions/lee.json": json(file(record("c", "review", "2026-10-17T06:00:00Z"))),
    },
    (p) => remote[p],
  );
  // The clashing name keeps theirs where it is (the base tree has it) and adds ours beside it.
  expect(out["runs/2026-10-17T06-00-00Z.json"]).toBeUndefined();
  expect(out["runs/2026-10-17T06-00-00Z-2.json"]).toBe('{"at":"ours"}\n');
  expect(out["runs/2026-10-17T06-30-00Z.json"]).toBe('{"at":"ours, later"}\n');
  expect(out["heartbeats/lee.json"]).toBe(remote["heartbeats/lee.json"]);
  expect(out["heartbeats/sam.json"]).toContain("2026-10-16");
  const lee = JSON.parse(out["decisions/lee.json"] ?? "") as DecisionsFile;
  expect(lee.decided.map((r) => r.hash)).toEqual(["d", "c"]);
});
