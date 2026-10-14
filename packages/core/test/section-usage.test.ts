import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseDoc } from "../src/doc.ts";
import type { Event } from "../src/events.ts";
import { sectionUsage } from "../src/section-usage.ts";

const path = "knowledge/integrations/docs/partner-calls.md";
const text = readFileSync(new URL(`../../../examples/starter-kb/${path}`, import.meta.url), "utf8");
const doc = parseDoc(text).doc;
if (!doc) throw new Error("bad example document");

test("counts reads and session injections per section, and marks unused, unconfirmed ones (K7)", () => {
  const events: Event[] = [
    {
      ts: "2026-10-10T00:00:00Z",
      type: "doc-read",
      doc: "integrations/partner-calls",
      section: "http-client",
    },
    { ts: "2026-10-11T00:00:00Z", type: "doc-read", doc: "integrations/partner-calls" },
    {
      ts: "2026-10-12T00:00:00Z",
      type: "doc-injection",
      sections: [{ doc: "integrations/partner-calls", id: "http-client" }],
    },
  ];
  const now = new Date("2026-10-14T00:00:00Z");
  const usage = sectionUsage([{ path, doc }], events, now);
  expect(usage.map((u) => [u.id, u.reads, u.injected, u.lastUsed])).toEqual([
    ["http-client", 2, 1, "2026-10-12T00:00:00Z"],
    ["timeouts", 1, 0, "2026-10-11T00:00:00Z"],
  ]);
  expect(usage.every((u) => !u.decaying)).toBe(true);

  // Half a year on, with no use: both are review candidates, since neither was confirmed since.
  const later = sectionUsage([{ path, doc }], [], new Date("2027-04-14T00:00:00Z"));
  expect(later.map((u) => u.decaying)).toEqual([true, true]);
});
