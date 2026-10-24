import { describe, expect, test } from "vitest";
import type { Asker } from "../src/claude.ts";
import { parseConfig } from "../src/config.ts";
import { distinctFacts, identifiersIn, numbersIn, sameLesson } from "../src/conflicts.ts";
import {
  applyUpdate,
  ClaudeConsolidator,
  consolidatePrompt,
  mergeCandidates,
  parseVerdict,
  type RuleCandidate,
  type verdictSchema,
} from "../src/consolidate.ts";
import { type Entry, parseEntry } from "../src/entry.ts";
import type { Frontmatter } from "../src/schema.ts";
import { validFrontmatter } from "./helpers.ts";

const rule = (
  id: string,
  title: string,
  text: string,
  patch: Partial<Frontmatter> = {},
  why = "It broke before.",
): Entry => ({
  frontmatter: {
    ...(validFrontmatter() as Frontmatter),
    id,
    title,
    scope: ["services/ops/**"],
    ...patch,
  },
  body: `## Rule\n${text}\n\n## Why\n${why}`,
  sections: { rule: text, why },
});

const pool = (...entries: Entry[]) =>
  entries.map((entry) => ({ path: `knowledge/ops/${entry.frontmatter.id}.md`, entry }));

describe("guards: facts that differ however alike the words", () => {
  test("numbers and versions, not digits inside names", () => {
    expect([...numbersIn("Use the v2 API on port 101, version 3.10")]).toEqual([
      "2",
      "101",
      "3.10",
    ]);
    expect([...numbersIn("Read files as utf8 from s3 buckets")]).toEqual([]);
    expect([...numbersIn("Pin 4.0, not 004")]).toEqual(["4"]);
  });

  test("identifiers: calls, camelCase, snake_case and code spans", () => {
    expect([
      ...identifiersIn("Call `withRetry()` with DATABASE_URL in useFooBar, not `ledger-sync`"),
    ]).toEqual(expect.arrayContaining(["withretry", "database_url", "usefoobar", "ledger-sync"]));
    // Hyphenated prose is not a name.
    expect(identifiersIn("Hand-rolled loops skip the request-id header")).toEqual(new Set());
  });

  test("each side has a number the other lacks: different facts", () => {
    const a = rule("a", "Call the billing API v1 for refunds", "Use the v1 refunds endpoint.");
    const b = rule("b", "Call the billing API v2 for refunds", "Use the v2 refunds endpoint.");
    expect(distinctFacts(a, b)).toBe("different numbers (1 and 2)");
    const c = rule("c", "Retry port 101 calls", "Retry calls to port 101.");
    const d = rule("d", "Retry port 102 calls", "Retry calls to port 102.");
    expect(distinctFacts(c, d)).toBe("different numbers (101 and 102)");
    // A number on one side only is a detail, not a different fact.
    expect(distinctFacts(a, rule("e", "Call the billing API for refunds", "Use refunds."))).toBe(
      undefined,
    );
  });

  test("look-alike names are different things; inflections are not", () => {
    const a = rule("a", "Wrap forms in useFoo", "Wrap every form in useFoo().");
    const b = rule("b", "Wrap forms in useFooBar", "Wrap every form in useFooBar().");
    expect(distinctFacts(a, b)).toBe("different names (usefoo and usefoobar)");
    const sync = rule("s", "Restart `ledger-sync` after deploys", "Restart `ledger-sync`.");
    const sink = rule("t", "Restart `ledger-sink` after deploys", "Restart `ledger-sink`.");
    expect(distinctFacts(sync, sink)).toContain("different names");
    const retry = rule("r", "Use withRetry for calls", "Use withRetry() for partner calls.");
    const retries = rule("q", "Use withRetries for calls", "Use withRetries() for calls.");
    expect(distinctFacts(retry, retries)).toBe(undefined);
  });

  test("sameLesson (daily run and deep dive) never matches guarded pairs", () => {
    const a = rule("a", "Call the billing API v1 for refunds", "Use the v1 refunds endpoint.");
    const b = rule("b", "Call the billing API v2 for refunds", "Use the v2 refunds endpoint.");
    expect(sameLesson(a, { ...a, frontmatter: { ...a.frontmatter, id: "a2" } })).toBe(true);
    expect(sameLesson(a, b)).toBe(false);
  });
});

describe("mergeCandidates", () => {
  const parse = rule(
    "parse-db-urls-by-last-at",
    "Parse DB URLs by last '@' for asyncpg in ops scripts",
    "In ops scripts, split the database URL at its last '@' before passing it to asyncpg.",
  );
  const lesson = rule(
    "parse-database-url-by-last-at",
    "Parse the DATABASE_URL by last '@', not urlsplit",
    "Split DATABASE_URL at the last '@'; urlsplit breaks on passwords that contain '@'.",
  );

  test("finds the rule a re-worded lesson refines", () => {
    const other = rule("log-levels", "Log at info in cron jobs", "Use info level in cron jobs.");
    const found = mergeCandidates(lesson, pool(parse, other));
    expect(found.map((c) => c.entry.frontmatter.id)).toEqual(["parse-db-urls-by-last-at"]);
  });

  test("guards, scope and the lesson itself exclude a rule", () => {
    const v2 = rule("v2", "Parse the DATABASE_URL v2 by last '@'", "Split DATABASE_URL v2 at '@'.");
    const v3 = rule("v3", "Parse the DATABASE_URL v3 by last '@'", "Split DATABASE_URL v3 at '@'.");
    expect(mergeCandidates(v2, pool(v3))).toEqual([]);
    const elsewhere = rule("x", parse.frontmatter.title, parse.sections.rule ?? "", {
      scope: ["apps/web/**"],
    });
    expect(mergeCandidates(lesson, pool(elsewhere, lesson))).toEqual([]);
  });

  test("code every rule names counts for less than code few rules name", () => {
    const helper = (id: string, extra: string) =>
      rule(id, `Rule ${id}`, `Call logEvent() and ${extra} in ops scripts.`);
    const rare = helper("rare", "rotateKeys()");
    const common = [1, 2, 3, 4, 5].map((n) => helper(`c${n}`, `step${"abcde"[n - 1]}()`));
    const mine = rule(
      "mine",
      "Rotate keys after every deploy",
      "Call rotateKeys() and logEvent().",
    );
    const found = mergeCandidates(mine, pool(...common, rare), { min: 0 });
    expect(found[0]?.entry.frontmatter.id).toBe("rare");
    expect(found).toHaveLength(3);
  });
});

describe("the decider's answer", () => {
  const target = rule(
    "parse-db-urls-by-last-at",
    "Parse DB URLs by last '@' in ops scripts",
    "In ops scripts, split the database URL at its last '@'.",
  );
  const candidates: RuleCandidate[] = [
    { path: "knowledge/ops/x.md", entry: target, similarity: 0.4 },
  ];
  const lesson = rule("l", "Parse DATABASE_URL by last '@'", "Never use urlsplit on DATABASE_URL.");
  const out = (o: Partial<ReturnType<typeof verdictSchema.parse>>) => ({
    reason: "same parsing rule",
    action: "update" as const,
    rule_id: "parse-db-urls-by-last-at",
    contradicts: "",
    title: "Parse DB URLs by last '@', never urlsplit",
    rule: "In ops scripts, split the database URL at its last '@'; never use urlsplit.",
    why: "Passwords can contain '@'.",
    ...o,
  });

  test("update, duplicate and create", () => {
    expect(parseVerdict(out({}), lesson, candidates)).toEqual({
      action: "update",
      id: "parse-db-urls-by-last-at",
      reason: "same parsing rule",
      rule: {
        title: "Parse DB URLs by last '@', never urlsplit",
        rule: "In ops scripts, split the database URL at its last '@'; never use urlsplit.",
        why: "Passwords can contain '@'.",
      },
    });
    expect(parseVerdict(out({ action: "duplicate" }), lesson, candidates)).toMatchObject({
      action: "duplicate",
      id: "parse-db-urls-by-last-at",
    });
    expect(
      parseVerdict(
        out({ action: "create", rule_id: "", contradicts: "parse-db-urls-by-last-at" }),
        lesson,
        candidates,
      ),
    ).toEqual({
      action: "create",
      reason: "same parsing rule",
      contradicts: "parse-db-urls-by-last-at",
    });
  });

  test("unusable answers are null, so the run falls back", () => {
    expect(parseVerdict(null, lesson, candidates)).toBe(null);
    expect(parseVerdict(out({ rule_id: "made-up" }), lesson, candidates)).toBe(null);
    const long = Array.from({ length: 70 }, () => "word").join(" ");
    expect(parseVerdict(out({ rule: long }), lesson, candidates)).toBe(null);
    expect(parseVerdict(out({ title: "" }), lesson, candidates)).toBe(null);
  });

  test("an update or create with the candidate's exact text is a duplicate", () => {
    expect(
      parseVerdict(out({ rule: ` ${target.sections.rule}  ` }), lesson, candidates),
    ).toMatchObject({ action: "duplicate" });
    const same = rule("s", "Other words", target.sections.rule ?? "");
    expect(parseVerdict(out({ action: "create" }), same, candidates)).toMatchObject({
      action: "duplicate",
      id: "parse-db-urls-by-last-at",
    });
  });

  test("the prompt marks newer rules and redacts secrets", () => {
    const secret = rule(
      "l2",
      "Never log DATABASE_URL",
      "Never log postgres://admin:hunter2-very-secret@db.internal:5432/app in ops scripts.",
      { created: "2026-10-01" },
    );
    const prompt = consolidatePrompt(secret, candidates);
    expect(prompt).not.toContain("hunter2-very-secret");
    expect(prompt).toContain('id="parse-db-urls-by-last-at" newer="true"');
    expect(
      consolidatePrompt(rule("l3", "t", "r", { created: "2026-10-20" }), candidates),
    ).toContain('newer="false"');
  });

  test("ClaudeConsolidator asks once with the candidates, and not at all without them", async () => {
    let asked = 0;
    const ask = (async () => {
      asked++;
      return out({ action: "duplicate" });
    }) as Asker;
    const decider = new ClaudeConsolidator(ask);
    expect(await decider.decide(lesson, candidates)).toMatchObject({ action: "duplicate" });
    expect(await decider.decide(lesson, [])).toMatchObject({ action: "create" });
    expect(asked).toBe(1);
  });
});

describe("applyUpdate", () => {
  const config = parseConfig(
    "version: 1\nteam:\n  members:\n    - { id: dana, role: senior, areas: [integrations] }\nareas:\n  integrations: [services/integrations/**]\n",
  ).config;

  test("rewrites the rule, keeps its identity and first source, records the lesson's", () => {
    if (!config) throw new Error("config");
    const target = rule("outbound-http-retry-helper", "Use withRetry", "Use withRetry().", {}, "W");
    target.sections.example = "withRetry(() => get(url))";
    const lesson = rule("l", "t", "r", {
      owner: "lee",
      source: {
        type: "pr-feedback",
        url: "https://github.com/acme/web-app/pull/120#discussion_r9001",
        author: "sam",
        changedCode: true,
      },
    });
    const text = applyUpdate(
      target,
      { title: "Use withRetry and pass the request id", rule: "Use withRetry().", why: "W2" },
      lesson,
      "2026-10-16",
      config,
    );
    const fm = parseEntry(text).entry?.frontmatter;
    expect(fm).toMatchObject({
      id: "outbound-http-retry-helper",
      title: "Use withRetry and pass the request id",
      owner: "dana",
      source: { url: target.frontmatter.source.url },
      alsoFrom: ["https://github.com/acme/web-app/pull/120#discussion_r9001"],
      lastConfirmed: "2026-10-16",
      created: target.frontmatter.created,
    });
    expect(text).toContain("## Example\nwithRetry(() => get(url))");
    expect(text.indexOf("alsoFrom")).toBeLessThan(text.indexOf("created"));
    // Folding the same lesson in again records its URL once.
    const again = parseEntry(text).entry;
    if (!again) throw new Error("entry");
    expect(
      parseEntry(
        applyUpdate(again, { title: "T", rule: "R", why: "W" }, lesson, "2026-10-17", config),
      ).entry?.frontmatter.alsoFrom,
    ).toHaveLength(1);
  });
});
