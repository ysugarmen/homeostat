import { describe, expect, test } from "vitest";
import {
  areaWideScopes,
  type Entry,
  originDistance,
  rankForFile,
  rulesForCode,
  selectEntries,
  usableTrigger,
} from "../src/index.ts";

const AREA = ["services/billing/**", "packages/billing/**"];

function rule(id: string, fm: Partial<Entry["frontmatter"]> = {}, text = `Rule ${id}.`): Entry {
  return {
    frontmatter: {
      id,
      title: `Title ${id}`,
      area: "billing",
      scope: AREA,
      status: "accepted",
      score: 3,
      owner: "ana",
      source: { type: "pr-feedback", author: "ana" },
      created: "2026-10-01",
      lastConfirmed: "2026-10-01",
      tokens: 20,
      ...fm,
    },
    body: "",
    sections: { rule: text, why: "Because." },
  } as Entry;
}

const learnedAt = (path: string) => ({
  source: { type: "pr-feedback" as const, author: "ana", path },
});

describe("where a rule was learned", () => {
  test("the same file, its folder, the folder above; nothing farther", () => {
    const f = "services/billing/invoices/totals.py";
    expect(originDistance(f, f)).toBe(0);
    expect(originDistance("services/billing/invoices/tax.py", f)).toBe(1);
    expect(originDistance("services/billing/refunds/api.py", f)).toBe(2);
    expect(originDistance("services/shipping/rates.py", f)).toBeUndefined();
    expect(originDistance(undefined, f)).toBeUndefined();
  });

  test("a file's own rules come before the area's, which only say what area it is in", () => {
    // Every rule here is scoped to the whole billing area: by scope alone, all tie.
    const entries = [
      rule("area-only-a", { score: 9 }),
      rule("area-only-b", { score: 8 }),
      rule("learned-in-folder", learnedAt("services/billing/invoices/tax.py")),
      rule("learned-here", learnedAt("services/billing/invoices/totals.py")),
      rule("everywhere", { scope: ["**"] }),
    ];
    const ranked = rankForFile(entries, "services/billing/invoices/totals.py", {
      broad: areaWideScopes({ billing: AREA }),
    });
    expect(ranked.map((r) => [r.entry.frontmatter.id, r.tier])).toEqual([
      ["learned-here", 0],
      ["learned-in-folder", 2],
      ["area-only-a", 4],
      ["area-only-b", 4],
    ]);
  });

  test("within a tier, the rule naming what the code calls comes first", () => {
    const here = learnedAt("services/billing/invoices/totals.py");
    const entries = [
      rule("rounding", { ...here, score: 9 }, "Round money with round_half_even only."),
      rule("retries", { ...here, score: 1 }, "Wrap ledger_client.post in with_retry."),
    ];
    const ranked = rankForFile(entries, "services/billing/invoices/totals.py", {
      code: "result = ledger_client.post(batch)",
    });
    expect(ranked.map((r) => r.entry.frontmatter.id)).toEqual(["retries", "rounding"]);
  });

  test("at session start an area-wide match ranks below a precise one", () => {
    const entries = [
      rule("area-wide", { score: 9 }),
      rule("precise", { scope: ["services/billing/invoices/**"], score: 1 }),
    ];
    const selection = selectEntries(entries, {
      paths: ["services/billing/invoices/totals.py"],
      tokenBudget: 10_000,
      broad: areaWideScopes({ billing: AREA }),
    });
    expect(selection.items.map((i) => i.entry.frontmatter.id)).toEqual(["precise", "area-wide"]);
  });
});

describe("code triggers", () => {
  test("only fragments specific enough to say something about the code fire", () => {
    for (const ok of [
      "Literal[",
      "freeze_time(",
      "MappingProxyType(",
      "# TODO(",
      "send_to_tracker=False",
    ])
      expect(usableTrigger(ok), ok).toBe(true);
    for (const no of [
      "# ",
      '"""',
      "def",
      "import ",
      "match ",
      "module docstring",
      "customer.*=.*@",
      "\\bfoo\\b",
      "ab",
    ])
      expect(usableTrigger(no), no).toBe(false);
  });

  test("a rule fires on code containing its trigger, in any file its scope covers", () => {
    const entries = [
      rule("strenum", { scope: ["**"], triggers: ["Literal["] }),
      rule("billing-only", { triggers: ["Literal["] }),
      rule("candidate", { scope: ["**"], status: "candidate", triggers: ["Literal["] }),
      rule("no-triggers", { scope: ["**"] }),
    ];
    const code = 'Kind = Literal["a", "b"]';
    expect(
      rulesForCode(entries, "services/shipping/kinds.py", code).map((e) => e.frontmatter.id),
    ).toEqual(["strenum"]);
    expect(
      rulesForCode(entries, "services/billing/kinds.py", code).map((e) => e.frontmatter.id),
    ).toEqual(["strenum", "billing-only"]);
    expect(rulesForCode(entries, "services/billing/kinds.py", "Kind = str")).toEqual([]);
  });
});
