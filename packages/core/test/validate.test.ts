import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyFixes } from "../src/fix.ts";
import { type KbFiles, validate } from "../src/validate.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

function readKb(name: string): KbFiles {
  const root = join(examples, name);
  const files: KbFiles = {};
  for (const f of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".md") || f.endsWith(".yaml")) files[f] = readFileSync(join(root, f), "utf8");
  }
  return files;
}

const codes = (files: KbFiles) => validate(files).issues.map((i) => i.code);
const ENTRY = "knowledge/integrations/outbound-http-retry-helper.md";

describe("validate", () => {
  test("starter-kb is green", () => {
    const result = validate(readKb("starter-kb"));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(3);
  });

  test("broken-kb is red, with every issue located", () => {
    const result = validate(readKb("broken-kb"));
    expect(result.ok).toBe(false);
    expect(result.issues.every((i) => i.file)).toBe(true);
  });

  test("missing homeostat.yaml is an error but entries are still checked", () => {
    const files = readKb("starter-kb");
    delete files["homeostat.yaml"];
    const result = validate(files);
    expect(result.issues.map((i) => i.code)).toEqual(["config.missing"]);
    expect(result.entries).toHaveLength(3);
  });

  test("non-entry files are ignored", () => {
    const files = { ...readKb("starter-kb"), "README.md": "# hi", "docs/x.md": "nope" };
    expect(codes(files)).toEqual([]);
  });

  test("a hand-edited score is a fixable warning", () => {
    const files = readKb("starter-kb");
    files[ENTRY] = files[ENTRY]?.replace("score: 4", "score: 9") ?? "";
    const result = validate(files);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "score.mismatch",
        severity: "warning",
        file: ENTRY,
        fix: { field: "score", value: 4 },
      }),
    ]);
  });

  test("a hand-edited score is caught as stale", () => {
    const files = readKb("starter-kb");
    const path = "knowledge/core/redact-before-logging.md";
    files[path] =
      files[path]?.replace("score: 2", "score: 5").replace("approvedBy: dana\n", "") ?? "";
    expect(codes(files)).toEqual(["score.mismatch"]);
  });

  test("conflicts across entries are reported on the right file", () => {
    const files = readKb("starter-kb");
    files[ENTRY] =
      files[ENTRY]?.replace(
        "status: accepted",
        "status: disputed\nconflictsWith: [redact-before-logging]",
      ) ?? "";
    const result = validate(files);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "conflict.one-sided-conflict", file: ENTRY }),
    );
  });
});

describe("applyFixes", () => {
  test("rewrites only the fixed fields and keeps the rest byte-for-byte", () => {
    const original = readKb("starter-kb")[ENTRY] ?? "";
    const broken = original.replace("score: 4", "score: 9").replace(/tokens: \d+/, "tokens: 1");
    const files = { ...readKb("starter-kb"), [ENTRY]: broken };
    const fixes = validate(files).issues.flatMap((i) => (i.fix ? [i.fix] : []));
    expect(applyFixes(broken, fixes)).toBe(original);
  });

  test("leaves files without frontmatter alone", () => {
    expect(applyFixes("no frontmatter", [{ field: "score", value: 1 }])).toBe("no frontmatter");
  });
});

describe("validate: a multi-repo KB", () => {
  // The starter's retry rule, filed under repo api; one shared rule; one document per layout.
  const starter = readKb("starter-kb");
  const rule = (starter[ENTRY] ?? "").replace(
    "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33",
    "https://github.com/acme/api/pull/812#discussion_r33",
  );
  const yaml = (extra = "") => `version: 1
team:
  members:
    - { id: dana, handle: "@dana", role: senior, areas: [api/integrations] }
    - { id: lee, handle: "@lee", role: member, areas: [] }
    - { id: sam, handle: "@sam", role: senior, areas: [core] }
repos:
  api:
    source: acme/api
    areas:
      integrations: ["services/integrations/**"]
  worker:
    source: acme/worker
sources:
  host: github
  kbRepo: acme/team-kb
${extra}`;
  const kb = (files: KbFiles = {}, extra = ""): KbFiles => ({
    "homeostat.yaml": yaml(extra),
    "knowledge/api/integrations/outbound-http-retry-helper.md": rule,
    ...files,
  });

  test("a repo's rules live under knowledge/<repo>/<area>/, and the KB is green", () => {
    const result = validate(kb());
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.config?.sources?.repos).toEqual(["acme/api", "acme/worker"]);
  });

  test("the one-repo path, an unlisted repo, or an area of another repo is an error", () => {
    const moved = (path: string) => {
      const files = kb();
      delete files["knowledge/api/integrations/outbound-http-retry-helper.md"];
      return codes({ ...files, [path]: rule });
    };
    expect(moved(ENTRY)).toContain("path.root");
    expect(moved("knowledge/web/integrations/outbound-http-retry-helper.md")).toContain(
      "path.root",
    );
    expect(moved("knowledge/worker/integrations/outbound-http-retry-helper.md")).toContain(
      "area.unknown",
    );
  });

  test("a rule learned from one repo's PR, filed under another, is misfiled", () => {
    const files = kb();
    delete files["knowledge/api/integrations/outbound-http-retry-helper.md"];
    const worker = yaml().replace(
      "  worker:\n    source: acme/worker",
      '  worker:\n    source: acme/worker\n    areas:\n      integrations: ["x/**"]',
    );
    expect(
      codes({
        ...files,
        "homeostat.yaml": worker,
        "knowledge/worker/integrations/outbound-http-retry-helper.md": rule,
      }),
    ).toContain("source.url.repo-folder");
  });

  test("documents follow the same layout", () => {
    const doc = (area: string) =>
      `---\ntitle: Notes\narea: ${area}\nowner: dana\nscope: ["**"]\nupdated: 2026-10-01\n---\n\n## One {#one}\n<!-- homeostat: source=imported updated=2026-10-01 -->\nText.\n`;
    expect(
      validate(
        kb({ "knowledge/api/integrations/docs/partners.md": doc("integrations") }),
      ).issues.filter((i) => i.code.startsWith("doc.path") || i.code.startsWith("doc.area")),
    ).toEqual([]);
    expect(codes(kb({ "knowledge/core/docs/architecture.md": doc("core") }))).not.toContain(
      "doc.path",
    );
    expect(codes(kb({ "knowledge/integrations/docs/partners.md": doc("integrations") }))).toContain(
      "doc.path",
    );
  });

  test("top-level areas, a second repo list, or a reserved short name are config errors", () => {
    const bad = (text: string) => codes({ ...kb(), "homeostat.yaml": text });
    expect(bad(yaml("areas:\n  integrations: [x/**]\n"))).toContain("config.areas.with-repos");
    expect(
      bad(yaml().replace("kbRepo: acme/team-kb", "kbRepo: acme/team-kb\n  repos: [acme/api]")),
    ).toContain("config.sources.repos.with-repos");
    expect(bad(yaml().replace("  worker:", "  docs:"))).toContain("config.repos.reserved");
    expect(bad(yaml().replace("areas: [api/integrations]", "areas: [integrations]"))).toContain(
      "config.member.area",
    );
  });
});
