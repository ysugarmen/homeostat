import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Config, parseConfig } from "../src/config.ts";
import { migratedPath, migrateKb } from "../src/migrate.ts";
import { parseTopicFile } from "../src/topics.ts";
import { type KbFiles, validate } from "../src/validate.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;
function readKb(): KbFiles {
  const files: KbFiles = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if ((f.endsWith(".md") || f.endsWith(".yaml")) && f !== "README.md") {
      files[f] = readFileSync(join(starter, f), "utf8");
    }
  }
  return files;
}
const config = parseConfig(readKb()["homeostat.yaml"] ?? "").config as Config;
const plan = {
  repos: { api: "acme/integrations-api", web: "acme/web-app" },
  areas: { integrations: "api", frontend: "web", core: undefined },
};
const apply = (files: KbFiles, changes: Record<string, string | null>): KbFiles => {
  const out = { ...files };
  for (const [p, t] of Object.entries(changes)) {
    if (t === null) delete out[p];
    else out[p] = t;
  }
  return out;
};

describe("migrateKb", () => {
  test("the starter becomes a green multi-repo KB, like examples/starter-multi-kb", () => {
    const files = readKb();
    const result = migrateKb(files, config, plan);
    expect(result.issues).toEqual([]);
    expect(result.moved.map(([, to]) => to).sort()).toEqual([
      "knowledge/api/integrations/docs/partner-calls.md",
      "knowledge/api/integrations/outbound-http-retry-helper.md",
      "knowledge/web/frontend/use-design-tokens-for-colors.md",
    ]);
    const after = apply(files, result.files);
    const migrated = validate(after);
    expect(migrated.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(migrated.config?.repos).toEqual({
      api: { source: "acme/integrations-api", areas: { integrations: config.areas.integrations } },
      web: { source: "acme/web-app", areas: { frontend: config.areas.frontend } },
    });
    expect(migrated.config?.team.members.map((m) => m.areas)).toEqual([
      ["api/integrations", "core"],
      ["web/frontend"],
      ["web/frontend", "core"],
    ]);
    expect(migrated.config?.migrated).toEqual({
      integrations: "api",
      frontend: "web",
      core: "shared",
    });
    // Comments in homeostat.yaml survive.
    expect(after["homeostat.yaml"]).toContain("# Name of the CI secret holding the webhook URL.");
  });

  test("with topics, rules are folded into topic files; unassigned ones go to general", () => {
    const files = readKb();
    const result = migrateKb(files, config, {
      ...plan,
      topics: {
        api: {
          topics: { http: "Outbound HTTP calls" },
          assign: { "outbound-http-retry-helper": "http" },
        },
        "": { topics: { logging: "What we log" }, assign: {} },
      },
    });
    expect(result.issues).toEqual([]);
    const after = apply(files, result.files);
    expect(
      parseTopicFile(
        "knowledge/api/integrations/http.md",
        after["knowledge/api/integrations/http.md"] ?? "",
      ).sections.map((s) => s.id),
    ).toEqual(["outbound-http-retry-helper"]);
    expect(after["knowledge/core/general.md"]).toContain("{#redact-before-logging}");
    expect(after["knowledge/core/redact-before-logging.md"]).toBeUndefined();
  });

  test("a developer's pending lesson at an old path finds its new one", () => {
    const after = parseConfig(
      apply(readKb(), migrateKb(readKb(), config, plan).files)["homeostat.yaml"] ?? "",
    ).config as Config;
    expect(migratedPath("knowledge/frontend/x.md", after)).toBe("knowledge/web/frontend/x.md");
    expect(migratedPath("knowledge/core/x.md", after)).toBe("knowledge/core/x.md");
  });
});
