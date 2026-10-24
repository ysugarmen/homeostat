import { describe, expect, test } from "vitest";
import { type Entry, formatEntry, parseEntry } from "../src/entry.ts";
import type { Frontmatter } from "../src/schema.ts";
import { CONTEXT_HEADER, renderContext, restCounts, selectEntries } from "../src/select.ts";
import { countTokens } from "../src/tokens.ts";
import { validFrontmatter, words } from "./helpers.ts";

function entry(id: string, patch: Partial<Frontmatter> = {}, rule = `Rule for ${id}.`): Entry {
  const body = `## Rule\n${rule}\n\n## Why\nBecause ${id} matters.`;
  const fm = {
    ...(validFrontmatter() as Frontmatter),
    id,
    title: `Title ${id}`,
    tokens: countTokens(body),
    ...patch,
  };
  const parsed = parseEntry(formatEntry(fm, body)).entry;
  if (!parsed) throw new Error(`bad fixture ${id}`);
  return parsed;
}

// Ten entries across areas, as in the 2.3 "done when".
const kb = [
  entry("api-retry", { scope: ["services/api/**"], score: 5 }),
  entry("api-timeouts", { scope: ["services/api/**"], score: 3 }),
  entry("web-tokens", { scope: ["apps/web/**"], score: 4 }),
  entry("web-a11y", { scope: ["apps/web/**/*.tsx"], score: 2 }),
  entry("global-logging", { scope: ["**"], score: 4 }),
  entry("global-secrets", { scope: ["**"], score: 6 }),
  entry("infra-terraform", { scope: ["infra/**"], score: 5 }),
  entry("candidate-api", { scope: ["services/api/**"], score: 9, status: "candidate" }),
  entry("retired-api", { scope: ["services/api/**"], score: 9, status: "retired" }),
  entry("docs-style", { scope: ["docs/**/*.md"], score: 1 }),
];

const ids = (paths: string[], tokenBudget = 10_000) =>
  selectEntries(kb, { paths, tokenBudget }).items.map((i) => i.entry.frontmatter.id);

describe("selectEntries", () => {
  test("only accepted entries whose scope matches, then global ones, each by score", () => {
    expect(ids(["services/api/handler.ts"])).toEqual([
      "api-retry",
      "api-timeouts",
      "global-secrets",
      "global-logging",
    ]);
  });

  test("globs match at any depth and by extension", () => {
    expect(ids(["apps/web/src/Button.tsx"])).toEqual([
      "web-tokens",
      "web-a11y",
      "global-secrets",
      "global-logging",
    ]);
    expect(ids(["apps/web/src/theme.css"])).not.toContain("web-a11y");
  });

  test("with no touched paths only global entries apply", () => {
    expect(ids([])).toEqual(["global-secrets", "global-logging"]);
  });

  test("a path match outranks a global entry, whatever their scores", () => {
    expect(ids(["apps/web/x.ts"])).toEqual(["web-tokens", "global-secrets", "global-logging"]);
  });

  test("a global rule naming a touched file outranks one naming other files, and conventions sit between", () => {
    const g = (id: string, rule: string, score = 4) =>
      ({
        frontmatter: { ...entry(id, { scope: ["**"], score }).frontmatter },
        body: "",
        sections: { rule, why: "Because." },
      }) as never;
    const rules = [
      g("charts-rule", "Use the helper in charts/platform-jobs/templates/_helpers.tpl.", 6),
      g("alembic-rule", "Never run backfills in env.py migrations."),
      g("plain-rule", "Write the PR description to match HEAD."),
    ];
    const order = (paths: string[]) =>
      selectEntries(rules, { paths, tokenBudget: 10_000 }).items.map((i) => i.entry.frontmatter.id);
    // Touching a migration: the env.py rule first, the convention next, the Helm rule last.
    expect(order(["packages/shared-services/alembic/env.py"])).toEqual([
      "alembic-rule",
      "plain-rule",
      "charts-rule",
    ]);
    // A file next to the one the rule names is the same folder's business.
    expect(order(["charts/platform-jobs/templates/cronjob.yaml"])).toEqual([
      "charts-rule",
      "plain-rule",
      "alembic-rule",
    ]);
  });

  test("rules that do not fit are left over, and counted by topic", () => {
    const sel = selectEntries(kb, { paths: ["services/api/handler.ts"], tokenBudget: 60 });
    expect(sel.rest.map((e) => e.frontmatter.id)).toEqual(sel.dropped);
    const counted = [...restCounts(sel.rest).values()].reduce((a, b) => a + b, 0);
    expect(counted).toBe(sel.dropped.length);
  });

  test("dotfiles match", () => {
    const dot = entry("ci", { scope: [".github/workflows/**"] });
    const sel = selectEntries([dot], { paths: [".github/workflows/ci.yml"], tokenBudget: 1000 });
    expect(sel.items).toHaveLength(1);
  });

  describe("token budget", () => {
    const paths = ["services/api/handler.ts"];

    test("the rendered context never exceeds the budget", () => {
      for (const budget of [40, 80, 120, 160, 400]) {
        const sel = selectEntries(kb, { paths, tokenBudget: budget });
        expect(countTokens(renderContext(sel))).toBeLessThanOrEqual(budget);
        expect(sel.tokens).toBeLessThanOrEqual(budget);
      }
    });

    test("falls back to the Rule alone before dropping an entry", () => {
      const long = entry("long", { score: 10, scope: ["**"] }, "Short rule.");
      const longWhy = parseEntry(
        formatEntry({ ...long.frontmatter }, `## Rule\nShort rule.\n\n## Why\n${words(90)}`),
      ).entry;
      if (!longWhy) throw new Error("fixture");
      const full = selectEntries([longWhy], { paths: [], tokenBudget: 10_000 });
      const tight = selectEntries([longWhy], {
        paths: [],
        tokenBudget: full.tokens - 5,
      });
      expect(full.items[0]?.form).toBe("full");
      expect(tight.items[0]?.form).toBe("rule");
      expect(renderContext(tight)).not.toContain("w89");
    });

    test("entries that do not fit at all are reported as dropped", () => {
      const sel = selectEntries(kb, { paths, tokenBudget: countTokens(CONTEXT_HEADER) + 15 });
      expect(sel.dropped.length).toBeGreaterThan(0);
      expect(sel.items.length + sel.dropped.length).toBe(4);
    });

    test("a budget smaller than the header injects nothing", () => {
      const sel = selectEntries(kb, { paths, tokenBudget: 3 });
      expect(sel.items).toEqual([]);
      expect(renderContext(sel)).toBe("");
    });
  });
});

describe("renderContext", () => {
  test("lists each rule under its title with its id", () => {
    const sel = selectEntries(kb, { paths: ["infra/main.tf"], tokenBudget: 10_000 });
    const text = renderContext(sel);
    expect(text.startsWith(CONTEXT_HEADER)).toBe(true);
    expect(text).toContain("## Title infra-terraform (infra-terraform)\nRule for infra-terraform.");
    expect(text).toContain("Why: Because infra-terraform matters.");
  });

  test("is empty when nothing applies", () => {
    expect(renderContext(selectEntries([], { paths: [], tokenBudget: 100 }))).toBe("");
  });
});

describe("character cap", () => {
  test("the rendered context never exceeds maxChars", () => {
    for (const maxChars of [900, 1200, 1600]) {
      const sel = selectEntries(kb, {
        paths: ["services/api/x.ts"],
        tokenBudget: 10_000,
        maxChars,
      });
      expect(renderContext(sel).length).toBeLessThanOrEqual(maxChars);
      expect(sel.items.length).toBeGreaterThan(0);
    }
  });
});

describe("restCounts", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    entry(`rule-${i}`, { topic: `topic-${i % 8}`, title: `A fairly long rule title number ${i}` }),
  );

  test("counts every topic, most first, and names no rule", () => {
    const counts = restCounts([...many, entry("extra", { topic: "topic-3" })]);
    expect([...counts.keys()][0]).toBe("topic-3");
    expect(counts.get("topic-3")).toBe(6);
    expect(counts.get("topic-0")).toBe(5);
    expect(counts.size).toBe(8);
  });
});
