import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type Config, parseConfig } from "../src/config.ts";
import { ClaudeRuleFixer, fixProblems, fixPrompt, resolveDispute } from "../src/dispute.ts";
import { type Entry, formatEntry, parseEntry } from "../src/entry.ts";
import { countTokens } from "../src/tokens.ts";

const starter = new URL("../../../examples/starter-kb/homeostat.yaml", import.meta.url).pathname;
const config = parseConfig(readFileSync(starter, "utf8")).config as Config;
const body =
  "## Rule\nSum Cents with add() from src/money.ts, never a bare +.\n\n## Why\nA bare + drops the Cents type.";
const disputed = parseEntry(
  formatEntry(
    {
      id: "sum-cents-with-add",
      title: "Sum Cents with add(), never a bare +",
      area: "core",
      scope: ["**"],
      status: "disputed",
      score: 2,
      owner: "dana",
      source: { type: "manual", author: "dana" },
      created: "2026-10-01",
      lastConfirmed: "2026-10-01",
      tokens: countTokens(body),
      flags: [{ by: "dana", reason: "add() was renamed sum()", date: "2026-10-05" }],
    },
    body,
  ),
).entry as Entry;

describe("resolveDispute", () => {
  test("a fix puts the corrected rule back in force and answers its flags", () => {
    const text = resolveDispute(
      disputed,
      {
        title: "Sum Cents with sum(), never a bare +",
        rule: "Sum Cents with sum() from src/money.ts, never a bare +.",
        why: "A bare + drops the Cents type.",
      },
      "2026-10-08",
      config,
    );
    const fm = parseEntry(text).entry?.frontmatter;
    expect(fm).toMatchObject({
      status: "accepted",
      lastConfirmed: "2026-10-08",
      title: "Sum Cents with sum(), never a bare +",
    });
    expect(fm?.flags).toBeUndefined();
    expect(text).toContain("never a bare +");
    expect(text).not.toContain("add()");
  });

  test("without a fix, the rule is retired as it stands", () => {
    const fm = parseEntry(resolveDispute(disputed, null, "2026-10-08", config)).entry?.frontmatter;
    expect(fm?.status).toBe("retired");
    expect(fm?.flags).toHaveLength(1);
  });

  test("an overlong fix is reported as unusable", () => {
    expect(fixProblems({ title: "T", rule: Array(70).fill("w").join(" "), why: "W" })[0]).toContain(
      "70 words",
    );
  });
});

describe("ClaudeRuleFixer", () => {
  test("sends the rule and its flags; an unfixable answer means retire", async () => {
    let prompt = "";
    const fixer = new ClaudeRuleFixer(async (_s, user) => {
      prompt = user;
      return { fixable: false, title: "", rule: "", why: "", example: "" } as never;
    });
    expect(await fixer.fix(disputed)).toBeNull();
    expect(prompt).toBe(fixPrompt(disputed));
    expect(prompt).toContain("- dana (2026-10-05): add() was renamed sum()");
  });
});
