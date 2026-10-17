import { describe, expect, test } from "vitest";
import { detectConflicts, sameLesson } from "../src/conflicts.ts";
import type { Entry } from "../src/entry.ts";
import type { Frontmatter } from "../src/schema.ts";
import { validFrontmatter } from "./helpers.ts";

const e = (id: string, patch: Partial<Frontmatter> = {}): Frontmatter => ({
  ...(validFrontmatter() as Frontmatter),
  id,
  title: `Rule ${id}`,
  ...patch,
});
const kinds = (entries: Frontmatter[]) => detectConflicts(entries).map((c) => c.kind);

describe("detectConflicts", () => {
  test("no findings for unrelated entries", () => {
    expect(detectConflicts([e("a"), e("b")])).toEqual([]);
  });

  test("duplicate ids", () => {
    expect(detectConflicts([e("a"), e("a")])).toEqual([
      expect.objectContaining({ kind: "duplicate-id", ids: ["a"] }),
    ]);
  });

  test("conflictsWith pointing at a missing entry", () => {
    expect(kinds([e("a", { status: "disputed", conflictsWith: ["nope"] })])).toEqual([
      "missing-reference",
    ]);
  });

  test("one-sided conflictsWith", () => {
    const a = e("a", { status: "disputed", conflictsWith: ["b"] });
    expect(detectConflicts([a, e("b")])).toEqual([
      expect.objectContaining({ kind: "one-sided-conflict", ids: ["a", "b"] }),
    ]);
    const b = e("b", { status: "disputed", conflictsWith: ["a"] });
    expect(detectConflicts([a, b])).toEqual([]);
  });

  test("supersedes pointing at a missing entry", () => {
    expect(kinds([e("a", { supersedes: "nope" })])).toEqual(["missing-reference"]);
  });

  test("supersedes cycle", () => {
    const entries = [
      e("a", { supersedes: "b", status: "retired" }),
      e("b", { supersedes: "c", status: "retired" }),
      e("c", { supersedes: "a", status: "retired" }),
    ];
    expect(detectConflicts(entries)).toEqual([
      expect.objectContaining({ kind: "supersedes-cycle", ids: ["a", "b", "c"] }),
    ]);
  });

  test("a superseded entry must be retired once its replacement is accepted", () => {
    expect(kinds([e("new", { supersedes: "old" }), e("old")])).toEqual(["superseded-not-retired"]);
    expect(kinds([e("new", { supersedes: "old" }), e("old", { status: "retired" })])).toEqual([]);
    expect(kinds([e("new", { supersedes: "old", status: "candidate" }), e("old")])).toEqual([]);
  });

  describe("possible duplicates", () => {
    const title = "Use the shared retry helper for outbound HTTP calls";

    test("accepted entries with overlapping scope and near-identical titles", () => {
      const a = e("a", { title, scope: ["services/**"] });
      const b = e("b", {
        title: "Use the shared retry helper for all outbound HTTP calls",
        scope: ["services/integrations/**"],
      });
      expect(detectConflicts([a, b])).toEqual([
        expect.objectContaining({ kind: "possible-duplicate", ids: ["a", "b"] }),
      ]);
    });

    test("not flagged when scopes are disjoint", () => {
      const a = e("a", { title, scope: ["services/**"] });
      const b = e("b", { title, scope: ["apps/web/**"] });
      expect(kinds([a, b])).toEqual([]);
    });

    test("not flagged when titles differ", () => {
      const a = e("a", { title, scope: ["**"] });
      const b = e("b", { title: "Redact bodies before logging", scope: ["**"] });
      expect(kinds([a, b])).toEqual([]);
    });

    test("only accepted entries are compared", () => {
      const a = e("a", { title, scope: ["**"] });
      const b = e("b", { title, scope: ["**"], status: "candidate" });
      expect(kinds([a, b])).toEqual([]);
    });
  });

  test("findings are severity-tagged: structural ones are errors", () => {
    const [dup] = detectConflicts([e("a"), e("a")]);
    expect(dup?.severity).toBe("error");
    const [similar] = detectConflicts([
      e("a", { title: "Same title here", scope: ["**"] }),
      e("b", { title: "Same title here", scope: ["**"] }),
    ]);
    expect(similar?.severity).toBe("warning");
  });
});

describe("sameLesson", () => {
  const entry = (title: string, rule: string, scope = ["services/integrations/**"]) =>
    ({ frontmatter: { title, scope }, sections: { rule } }) as unknown as Entry;

  test("rules naming the same code are the same lesson, whatever their titles", () => {
    expect(
      sameLesson(
        entry(
          "Use the shared retry helper for partner calls",
          "Wrap every partner API call in withRetry() from services/integrations/http.ts.",
        ),
        entry(
          "Use withRetry instead of hand-rolled retry loops",
          "Call withRetry() from services/integrations/http.ts instead of writing retry loops.",
        ),
      ),
    ).toBe(true);
  });

  test("different code, or scopes that do not overlap, are different lessons", () => {
    const retry = entry(
      "Use the retry helper",
      "Wrap calls in withRetry() from services/integrations/http.ts.",
    );
    expect(
      sameLesson(
        retry,
        entry("Parse responses", "Parse every response with schema.parse() first."),
      ),
    ).toBe(false);
    expect(
      sameLesson(retry, entry("Use the retry helper", "Wrap calls in withRetry().", ["web/**"])),
    ).toBe(false);
  });
});
