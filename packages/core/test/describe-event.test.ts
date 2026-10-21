import { describe, expect, test } from "vitest";
import { describeEvent } from "../src/events.ts";

describe("describeEvent", () => {
  test("document reads and injections read as sentences, not JSON", () => {
    expect(
      describeEvent({
        ts: "t",
        type: "doc-read",
        doc: "integrations/partner-notes",
        section: "timeouts",
      }),
    ).toBe("integrations/partner-notes#timeouts");
    expect(
      describeEvent({
        ts: "t",
        type: "doc-injection",
        docs: ["integrations/partner-notes"],
        sections: [{ doc: "integrations/partner-notes", id: "webhooks" }],
      }),
    ).toBe("1 document listed, 1 section included");
    expect(describeEvent({ ts: "t", type: "sync-run", ms: 1200, ok: true })).toBe("1200 ms");
    expect(describeEvent({ ts: "t", type: "sync-run", ms: 80, ok: false, step: "push" })).toBe(
      "80 ms, failed at push",
    );
    expect(
      describeEvent({
        ts: "t",
        type: "seed-run",
        repo: "app",
        topics: ["architecture"],
        paths: 3,
        chars: 20,
      }),
    ).toBe("app: architecture from 3 paths (20 chars sent)");
  });
});
