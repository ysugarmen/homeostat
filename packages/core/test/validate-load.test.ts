import { describe, expect, test } from "vitest";
import { readKbFiles } from "../src/files.ts";
import { validate } from "../src/validate.ts";

const multi = new URL("../../../examples/starter-multi-kb", import.meta.url).pathname;

describe("validate with checks off", () => {
  test("loads the same config, rules and documents as a full validation", () => {
    const files = readKbFiles(multi);
    const full = validate(files);
    const load = validate(files, { checks: false });
    expect(load.config).toEqual(full.config);
    expect(load.entries.map((e) => e.path)).toEqual(full.entries.map((e) => e.path));
    expect(load.docs.map((d) => d.path)).toEqual(full.docs.map((d) => d.path));
  });

  test("skips the content checks a full validation runs, keeping parse errors", () => {
    const files = readKbFiles(multi);
    const rule = Object.keys(files).find((p) => p.includes("outbound-http-retry-helper")) ?? "";
    const risky = {
      ...files,
      [rule]: (files[rule] ?? "").replace(
        "## Why",
        "See https://evil.biz/retry for details.\n\n## Why",
      ),
    };
    const codes = (r: ReturnType<typeof validate>) => r.issues.map((i) => i.code);
    expect(codes(validate(risky))).toContain("risk.unlisted-url");
    expect(codes(validate(risky, { checks: false }))).not.toContain("risk.unlisted-url");
    const broken = { ...files, "knowledge/core/bad.md": "no frontmatter" };
    expect(validate(broken, { checks: false }).issues.length).toBeGreaterThan(0);
  });
});

describe("rules follow their area's paths", () => {
  const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
  const scopeOf = (r: ReturnType<typeof validate>, id: string) =>
    r.entries.find((e) => e.entry.frontmatter.id === id)?.entry.frontmatter.scope;

  test("a folder added to the area reaches the rules written with its old globs, not narrower ones", () => {
    const files = readKbFiles(starter);
    // The team finds a folder the integrations area missed, and adds it: one line in the config.
    const widened: Record<string, string> = {
      ...files,
      "homeostat.yaml": (files["homeostat.yaml"] ?? "").replace(
        'integrations: ["services/integrations/**", "packages/http-client/**"]',
        'integrations: ["services/integrations/**", "packages/http-client/**", "services/partner-api/**"]',
      ),
      // Written by hand for one of the area's folders on purpose.
      "knowledge/integrations/queue-only.md": (
        files["knowledge/integrations/outbound-http-retry-helper.md"] ?? ""
      )
        .replace("id: outbound-http-retry-helper", "id: queue-only")
        .replace(
          'scope: ["services/integrations/**", "packages/http-client/**"]',
          'scope: ["services/integrations/**"]',
        )
        .replace(
          /source:\n {2}type: pr-feedback\n {2}url: .*\n {2}author: dana\n {2}changedCode: true/,
          "source:\n  type: manual\n  author: dana",
        ),
    };
    for (const checks of [true, false]) {
      const r = validate(widened, { checks });
      // Written with the area's two globs of the day: read with all three.
      expect(scopeOf(r, "outbound-http-retry-helper")).toEqual([
        "services/integrations/**",
        "packages/http-client/**",
        "services/partner-api/**",
      ]);
      expect(scopeOf(r, "queue-only")).toEqual(["services/integrations/**"]);
    }
    // The file is not rewritten: only the reading follows the area.
    expect(widened["knowledge/integrations/outbound-http-retry-helper.md"]).toContain(
      'scope: ["services/integrations/**", "packages/http-client/**"]',
    );
  });
});
