import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Asker } from "../src/claude.ts";
import { deepDive } from "../src/deepdive.ts";
import { citedDocument, parseDoc } from "../src/doc.ts";
import { parseEntry } from "../src/entry.ts";
import {
  ClaudeRetractor,
  citesId,
  findCitations,
  RETRACT_SYSTEM,
  type Retraction,
  type RetractionInput,
  type Retractor,
  retiredRule,
  retractCitations,
} from "../src/retract.ts";
import { validate } from "../src/validate.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;
const RULE = "knowledge/integrations/outbound-http-retry-helper.md";
const DOC = "knowledge/integrations/docs/partner-calls.md";
const TODAY = "2026-10-20";

/** The starter KB, its document citing the retry rule by id in #http-client and #timeouts. */
function kb(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".md") || f.endsWith(".yaml")) files[f] = readFileSync(join(starter, f), "utf8");
  }
  delete files["README.md"];
  files[DOC] = (files[DOC] ?? "")
    .replace(
      "sets the `x-request-id` header that partner support asks for.",
      "sets the `x-request-id` header that partner support asks for. Never hand-roll a retry loop or use `axios-retry` (outbound-http-retry-helper).",
    )
    .replace(
      "because two partners confirm synchronously.",
      "because two partners confirm synchronously. Retries for it follow outbound-http-retry-helper.",
    );
  return files;
}

const rule = () => {
  const entry = parseEntry(kb()[RULE] ?? "").entry;
  if (!entry) throw new Error("rule");
  return retiredRule(entry, "a reviewer closed its dispute PR");
};

/** Retracts the hand-roll sentence from #http-client; nothing in #timeouts rests on the rule. */
class FakeRetractor implements Retractor {
  asked: RetractionInput[] = [];
  answer?: (i: RetractionInput) => Retraction | null;
  async retract(i: RetractionInput): Promise<Retraction | null> {
    this.asked.push(i);
    if (this.answer) return this.answer(i);
    if (i.section.id === "timeouts") return { change: false, body: "", reason: "" };
    return {
      change: true,
      body: i.section.body.replace(
        " Never hand-roll a retry loop or use `axios-retry` (outbound-http-retry-helper).",
        "",
      ),
      reason: "the ban on hand-rolled retries came from the retired rule",
    };
  }
}

const run = (retractor?: Retractor, calls = 10, files = kb()) =>
  retractCitations({
    files,
    retired: [rule()],
    retractor,
    inForce: new Map(),
    calls,
    today: TODAY,
    source: "curator",
  });

describe("finding sections that cite a retired rule", () => {
  test("by id (whole token) and by the rule's review thread as provenance; never by words alone", () => {
    expect(findCitations(kb(), [rule()]).map((c) => [c.section.id, c.by])).toEqual([
      ["http-client", "id"],
      ["timeouts", "id"],
    ]);
    // The section's provenance is the rule's own thread, in another URL form.
    const byUrl = kb();
    byUrl[DOC] = (byUrl[DOC] ?? "").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/790#comment-41",
      "https://bitbucket.org/acme/integrations-api/pull-requests/812/overview#comment-33",
    );
    expect(findCitations(byUrl, [rule()]).map((c) => [c.section.id, c.by])).toEqual([
      ["http-client", "url"],
      ["timeouts", "id"],
    ]);
    // The starter document talks about withRetry() but cites no rule: no citation.
    const plain: Record<string, string> = {};
    for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
      if (f.endsWith(".md") || f.endsWith(".yaml"))
        plain[f] = readFileSync(join(starter, f), "utf8");
    }
    expect(findCitations(plain, [rule()])).toEqual([]);
  });

  test("a one-word id counts only in a credit form", () => {
    expect(citesId("see `retries` here", "retries")).toBe(true);
    expect(citesId("From Homeostat (retries)", "retries")).toBe(true);
    expect(citesId("retries are capped at three", "retries")).toBe(false);
    expect(
      citesId("use the outbound-http-retry-helper-v2 rule", "outbound-http-retry-helper"),
    ).toBe(false);
  });
});

describe("retracting", () => {
  test("a cited claim is removed by a one-section patch with new provenance; a section that does not rest on it is left", async () => {
    const retractor = new FakeRetractor();
    const out = await run(retractor);
    expect(retractor.asked.map((a) => a.section.id)).toEqual(["http-client", "timeouts"]);
    expect(out.calls).toBe(2);
    expect(out.docs).toHaveLength(1);
    const doc = parseDoc(out.docs[0]?.text ?? "").doc;
    const http = doc?.sections.find((s) => s.id === "http-client");
    expect(http?.body).not.toContain("hand-roll");
    expect(http?.body).toContain("sets the `x-request-id` header");
    expect(http?.provenance).toMatchObject({
      source: "curator",
      url: "https://bitbucket.org/acme/integrations-api/pull-requests/790#comment-41",
      updated: TODAY,
      note: "retracted outbound-http-retry-helper",
    });
    expect(doc?.sections.find((s) => s.id === "timeouts")?.body).toContain(
      "Retries for it follow outbound-http-retry-helper.",
    );
    expect(out.docs[0]?.sections).toEqual([
      {
        id: "http-client",
        ruleId: "outbound-http-retry-helper",
        reason: "the ban on hand-rolled retries came from the retired rule",
      },
    ]);
    expect(out.notes).toEqual([
      `${DOC}#timeouts cites the retired outbound-http-retry-helper; nothing in it rests on the rule, so it is left as it is`,
    ]);
    expect(validate({ ...kb(), [DOC]: out.docs[0]?.text ?? "" }).ok).toBe(true);
  });

  test("the retired rule's thread is dropped from the provenance", async () => {
    const files = kb();
    const url = "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33";
    files[DOC] = (files[DOC] ?? "").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/790#comment-41",
      url,
    );
    const out = await run(new FakeRetractor(), 10, files);
    const http = parseDoc(out.docs[0]?.text ?? "").doc?.sections.find(
      (s) => s.id === "http-client",
    );
    expect(http?.provenance?.url).toBeUndefined();
  });

  test("a rewrite that adds text, keeps the citation or empties the section is refused", async () => {
    for (const [body, why] of [
      [
        "Every call goes through withRetry() and also the new circuitBreaker() helper now, always.",
        "added text",
      ],
      [
        "Every outbound call goes through `withRetry()` (outbound-http-retry-helper).",
        "still cites it",
      ],
      ["", "empty the section"],
    ] as const) {
      const retractor = new FakeRetractor();
      retractor.answer = (i) =>
        i.section.id === "http-client"
          ? { change: true, body, reason: "r" }
          : { change: false, body: "", reason: "" };
      const out = await run(retractor);
      expect(out.docs).toEqual([]);
      expect(out.notes.join("\n")).toContain(why);
    }
  });

  test("the cap stops the calls; without a retractor every citation is a note", async () => {
    const capped = await run(new FakeRetractor(), 1);
    expect(capped.calls).toBe(1);
    expect(capped.notes).toContain(
      `${DOC}#timeouts cites the retired outbound-http-retry-helper; not checked: the cap on retraction calls was reached`,
    );
    const off = await run(undefined);
    expect(off.calls).toBe(0);
    expect(off.docs).toEqual([]);
    expect(off.notes).toHaveLength(2);
  });

  test("secrets are redacted before the section reaches the model", async () => {
    const files = kb();
    files[DOC] = (files[DOC] ?? "").replace(
      "with backoff",
      "with backoff (token ghp_abcdefghijklmnopqrstuvwxyz0123456789)",
    );
    const retractor = new FakeRetractor();
    retractor.answer = () => ({ change: false, body: "", reason: "" });
    await run(retractor, 10, files);
    expect(retractor.asked[0]?.section.body).toContain("[REDACTED:");
    expect(retractor.asked[0]?.section.body).not.toContain("ghp_abcdef");
  });

  test("the model is told to take away only, and gets the retired rule and the section", async () => {
    expect(RETRACT_SYSTEM).toContain("When in doubt, keep it");
    let user = "";
    const ask: Asker = async (_s, u) => {
      user = u;
      return { change: false, body: "", reason: "" } as never;
    };
    const out = await new ClaudeRetractor(ask).retract({
      section: { path: DOC, id: "timeouts", heading: "Timeouts", body: "Ten seconds." },
      retired: rule(),
      supported: [],
    });
    expect(out?.change).toBe(false);
    expect(user).toContain('<retired-rule id="outbound-http-retry-helper">');
    expect(user).toContain("Retired because: a reviewer closed its dispute PR");
    expect(user).toContain("Ten seconds.");
  });
});

describe("the deep dive retracts claims of rules it retires as stale", () => {
  test("a stale rule's citing section is patched in the same changes; another is a note", async () => {
    const files = kb();
    files[RULE] = (files[RULE] ?? "")
      .replace("lastConfirmed: 2026-10-07", "lastConfirmed: 2026-03-01")
      .replace("created: 2026-09-30", "created: 2026-03-01");
    const retractor = new FakeRetractor();
    const result = await deepDive({ files, today: TODAY, retractor });
    const rule = result.changes.find((c) => c.path === RULE);
    expect(rule?.actions[0]?.action).toBe("retired-stale");
    const doc = result.changes.find((c) => c.path === DOC);
    expect(doc?.actions).toEqual([
      {
        action: "retracted",
        note: "#http-client no longer states the retired outbound-http-retry-helper: the ban on hand-rolled retries came from the retired rule",
      },
    ]);
    expect(doc?.text).toContain("source=deep-dive");
    expect(retractor.asked[0]?.retired.reason).toContain("not confirmed for");
    expect(result.notes.join("\n")).toContain("#timeouts cites the retired");

    // Without the model (--no-llm) the citations are notes and the document is left alone.
    const offline = await deepDive({ files, today: TODAY });
    expect(offline.changes.find((c) => c.path === DOC)).toBeUndefined();
    expect(offline.notes.filter((n) => n.includes("cites the retired"))).toHaveLength(2);
  });
});

describe("documents never cite each other as evidence in a loop", () => {
  const second = `---
title: Partner retries
area: integrations
owner: dana
scope: ["services/integrations/**"]
updated: 2026-10-12
---

## Retries {#retries}
<!-- homeostat: source=manual url=knowledge/integrations/docs/partner-calls.md#timeouts updated=2026-10-12 -->
Retries follow the partner-calls document.
`;
  test("a link to a document is recognised in any form", () => {
    expect(citedDocument("knowledge/integrations/docs/partner-calls.md#timeouts")).toBe(DOC);
    expect(
      citedDocument(
        "https://github.com/acme/team-kb/blob/main/knowledge/web/frontend/docs/arch.md",
      ),
    ).toBe("knowledge/web/frontend/docs/arch.md");
    expect(citedDocument("https://github.com/acme/web-app/pull/1#discussion_r2")).toBeUndefined();
  });

  test("a one-way citation passes; a loop, or a section citing its own document, fails", () => {
    const files: Record<string, string> = {
      ...kb(),
      "knowledge/integrations/docs/retries.md": second,
    };
    expect(validate(files).issues.filter((i) => i.code === "doc.provenance.loop")).toEqual([]);
    files[DOC] = (files[DOC] ?? "").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/790#comment-41",
      "knowledge/integrations/docs/retries.md#retries",
    );
    const loop = validate(files).issues.filter((i) => i.code === "doc.provenance.loop");
    expect(loop).toHaveLength(1);
    expect(loop[0]?.message).toContain(
      "knowledge/integrations/docs/partner-calls.md → knowledge/integrations/docs/retries.md → knowledge/integrations/docs/partner-calls.md",
    );
    const self = kb();
    self[DOC] = (self[DOC] ?? "").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/790#comment-41",
      "knowledge/integrations/docs/partner-calls.md#timeouts",
    );
    expect(validate(self).issues.some((i) => i.code === "doc.provenance.loop")).toBe(true);
  });
});
