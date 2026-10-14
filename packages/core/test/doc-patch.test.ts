import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseDoc } from "../src/doc.ts";
import { applySectionPatch, changedSections, PatchError } from "../src/doc-patch.ts";

const doc = readFileSync(
  new URL(
    "../../../examples/starter-kb/knowledge/integrations/docs/partner-calls.md",
    import.meta.url,
  ),
  "utf8",
);
const prov = {
  source: "curator",
  url: "https://bitbucket.org/acme/web-app/pull-requests/9#comment-1",
  updated: "2026-10-14",
};

/** Lines outside the patched section, which must be byte-for-byte unchanged. */
const outside = (text: string, id: string) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(`{#${id}}`));
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start), ...lines.slice(end)]
    .filter((l) => !l.startsWith("updated:"))
    .join("\n");
};

describe("applySectionPatch (K4)", () => {
  test("replace changes exactly one section and bumps updated", () => {
    const out = applySectionPatch(
      doc,
      {
        op: "replace",
        id: "http-client",
        body: "Every outbound call goes through `withRetry()` from `@acme/net`.",
        provenance: prov,
      },
      "2026-10-14",
    );
    expect(changedSections(doc, out)).toEqual(["http-client"]);
    expect(outside(out, "http-client")).toBe(outside(doc, "http-client"));
    expect(out).toContain("updated: 2026-10-14");
    expect(out).toContain(
      "## The shared HTTP client {#http-client}\n<!-- homeostat: source=curator",
    );
    expect(parseDoc(out).issues).toEqual([]);
  });

  test("append keeps the old text and adds the new under fresh provenance", () => {
    const out = applySectionPatch(
      doc,
      {
        op: "append",
        id: "timeouts",
        body: "Refund calls also wait 30 seconds.",
        provenance: prov,
      },
      "2026-10-14",
    );
    const section = parseDoc(out).doc?.sections.find((s) => s.id === "timeouts");
    expect(section?.body).toContain("Partner calls time out after 10 seconds.");
    expect(section?.body.endsWith("Refund calls also wait 30 seconds.")).toBe(true);
    expect(section?.provenance?.source).toBe("curator");
    expect(changedSections(doc, out)).toEqual(["timeouts"]);
  });

  test("add appends a new section and nothing else", () => {
    const out = applySectionPatch(
      doc,
      {
        op: "add",
        id: "webhooks",
        heading: "Partner webhooks",
        body: "Webhooks land on /hooks/partner.",
        provenance: prov,
      },
      "2026-10-14",
    );
    expect(changedSections(doc, out)).toEqual(["webhooks"]);
    expect(parseDoc(out).issues).toEqual([]);
  });

  test.each([
    [
      { op: "replace" as const, id: "missing", body: "x", provenance: prov },
      'no section with id "missing"',
    ],
    [
      { op: "add" as const, id: "timeouts", heading: "New", body: "x", provenance: prov },
      "already exists",
    ],
    [
      { op: "add" as const, id: "t2", heading: "Timeouts", body: "x", provenance: prov },
      'already headed "Timeouts"',
    ],
    [
      { op: "replace" as const, id: "timeouts", body: "```\nunclosed", provenance: prov },
      "would break the document",
    ],
  ])("refuses a patch that cannot apply cleanly: %#", (patch, message) => {
    expect(() => applySectionPatch(doc, patch, "2026-10-14")).toThrow(PatchError);
    expect(() => applySectionPatch(doc, patch, "2026-10-14")).toThrow(message);
  });
});
