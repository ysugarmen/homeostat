import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { editConfig } from "../src/migrate.ts";
import {
  bitbucketCron,
  localSetupChecks,
  readSetupRecord,
  SETUP_STEPS,
  setupRows,
  writeSetupRecord,
} from "../src/setup.ts";

const CONFIG = `# team config
version: 1
team:
  members:
    - id: ada # the lead
      handle: "@ada"
      role: lead
distribution:
  tokenBudget: 2000
`;

describe("editConfig", () => {
  test("sets, appends and deletes in place, keeping comments", () => {
    const out = editConfig(CONFIG, [
      { path: ["sources", "host"], set: "github" },
      { path: ["team", "members"], append: { id: "lee", handle: "@lee", role: "member" } },
      { path: ["team", "reviewers"], set: ["ada"] },
      { path: ["distribution"], delete: true },
    ]);
    expect(out).toContain("# team config");
    expect(out).toContain("# the lead");
    expect(out).toContain("id: lee");
    expect(out).toContain("host: github");
    expect(out).not.toContain("distribution:");
  });
});

describe("bitbucketCron", () => {
  test("adds seconds and a year, and names weekdays", () => {
    expect(bitbucketCron("0 6 * * *")).toBe("0 0 6 * * ? *");
    expect(bitbucketCron("30 7 * * 1")).toBe("0 30 7 ? * MON *");
    expect(bitbucketCron("0 8 * * 1-5")).toBe("0 0 8 ? * MON-FRI *");
    expect(bitbucketCron("0 8 * * 0")).toBe("0 0 8 ? * SUN *");
  });
});

describe("the setup checklist", () => {
  test("every step says why it matters", () => {
    for (const s of SETUP_STEPS) expect(s.why.length).toBeGreaterThan(10);
  });

  test("local checks decide what the files can", () => {
    const root = mkdtempSync(join(tmpdir(), "homeostat-setup-core-"));
    expect(localSetupChecks(root, {}).host?.state).toBe("missing");
    const files = { "homeostat.yaml": CONFIG };
    const local = localSetupChecks(root, files);
    expect(local.host).toEqual({
      state: "missing",
      reason: "no sources section (host and KB repo)",
    });
    expect(local.team?.state).toBe("done");
    expect(local.areas?.state).toBe("optional");
    expect(local.token).toBeUndefined();
  });

  test("remote rows read the record, and a shared build leaves them out", () => {
    const root = mkdtempSync(join(tmpdir(), "homeostat-setup-core-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    for (const f of ["homeostat-curator.yml", "homeostat-deep-dive.yml"])
      writeFileSync(join(root, ".github/workflows", f), "on: schedule\n");
    const files = {
      "homeostat.yaml": `${CONFIG}sources:\n  host: github\n  kbRepo: acme/team-kb\n  repos: [acme/web-app]\n`,
    };
    writeSetupRecord(
      root,
      { token: { state: "done", reason: "stored" } },
      new Date("2026-10-20T09:00:00Z"),
    );
    const rows = setupRows(root, files, readSetupRecord(root));
    const by = (n: string) => rows.find((r) => r.name === n);
    expect(by("token")).toMatchObject({
      state: "done",
      source: "record",
      checkedAt: "2026-10-20T09:00:00.000Z",
    });
    expect(by("model")).toMatchObject({ state: "unknown", source: "none" });
    expect(by("repos")).toMatchObject({ state: "done", source: "local" });
    const shared = setupRows(root, files, readSetupRecord(root), { shared: true });
    expect(shared.some((r) => r.source !== "local")).toBe(false);
    expect(shared.find((r) => r.name === "token")).toBeUndefined();
  });
});
