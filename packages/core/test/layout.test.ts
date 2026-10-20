import { describe, expect, test } from "vitest";
import { isKnownArea, locate } from "../src/layout.ts";

describe("locate", () => {
  test("a one-repo KB: knowledge/<area>/ for rules, docs/ beneath it", () => {
    expect(locate("knowledge/payments/use-the-ledger.md")).toEqual({
      area: "payments",
      kind: "rule",
    });
    expect(locate("knowledge/core/docs/architecture.md")).toEqual({ area: "core", kind: "doc" });
    expect(locate("knowledge/api/payments/x.md")).toBeUndefined();
  });

  test("a multi-repo KB: shared core, then knowledge/<repo>/<area>/", () => {
    const repos = ["api", "worker"];
    expect(locate("knowledge/core/x.md", repos)).toEqual({ area: "core", kind: "rule" });
    expect(locate("knowledge/core/docs/architecture.md", repos)).toEqual({
      area: "core",
      kind: "doc",
    });
    expect(locate("knowledge/api/payments/x.md", repos)).toEqual({
      repo: "api",
      area: "payments",
      kind: "rule",
    });
    expect(locate("knowledge/worker/core/docs/jobs.md", repos)).toEqual({
      repo: "worker",
      area: "core",
      kind: "doc",
    });
    // A repo that is not listed, or an area folder missing, fits neither layout.
    expect(locate("knowledge/web/payments/x.md", repos)).toBeUndefined();
    expect(locate("knowledge/payments/x.md", repos)).toBeUndefined();
  });
});

describe("isKnownArea", () => {
  const multi = {
    areas: {},
    repos: {
      api: { source: "acme/api", areas: { payments: ["services/payments/**"] } },
      worker: { source: "acme/worker", areas: {} },
    },
  };
  test("multi-repo areas are named <repo>/<area>; core alone is the shared one", () => {
    expect(isKnownArea(multi, "core")).toBe(true);
    expect(isKnownArea(multi, "api/payments")).toBe(true);
    expect(isKnownArea(multi, "worker/core")).toBe(true);
    expect(isKnownArea(multi, "payments")).toBe(false);
    expect(isKnownArea(multi, "worker/payments")).toBe(false);
  });
  test("a one-repo KB keeps plain area names", () => {
    expect(isKnownArea({ areas: { payments: ["p/**"] } }, "payments")).toBe(true);
    expect(isKnownArea({ areas: { payments: ["p/**"] } }, "api/payments")).toBe(false);
  });
});

describe("comparable", () => {
  test("two rules can be the same lesson within a repo, or with a shared rule; never across repos", async () => {
    const { comparable } = await import("../src/layout.ts");
    const config = {
      repos: { api: { source: "acme/api", areas: {} }, web: { source: "acme/web", areas: {} } },
    };
    expect(comparable("knowledge/api/core/a.md", "knowledge/api/core/b.md", config)).toBe(true);
    expect(comparable("knowledge/api/core/a.md", "knowledge/core/b.md", config)).toBe(true);
    expect(comparable("knowledge/api/core/a.md", "knowledge/web/core/b.md", config)).toBe(false);
    expect(comparable("knowledge/core/a.md", "knowledge/frontend/b.md", {})).toBe(true);
  });
});
