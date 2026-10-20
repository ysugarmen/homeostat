import { readFileSync } from "node:fs";
import { configSchema, parseConfig } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { applySection, currentValue, SECTIONS } from "../src/settings.ts";

const starterYaml = readFileSync(
  new URL("../../../examples/starter-kb/homeostat.yaml", import.meta.url),
  "utf8",
);
const config = parseConfig(starterYaml).config;
if (!config) throw new Error("config");

/** The form a browser would submit for a section, with its current values. */
function formFor(sectionId: string): URLSearchParams {
  const form = new URLSearchParams();
  const section = SECTIONS.find((s) => s.id === sectionId);
  for (const f of section?.fields ?? []) {
    const v = currentValue(config!, f);
    const name = f.path.join(".");
    if (f.kind === "checkbox") {
      if (v) form.set(name, "on");
    } else if (f.kind === "checks") for (const x of (v as string[]) ?? []) form.append(name, x);
    else if (f.kind === "lines") form.set(name, ((v as string[]) ?? []).join("\n"));
    else if (v !== undefined) form.set(name, String(v));
  }
  return form;
}

describe("every config key is editable (4.2)", () => {
  /** Leaf keys of the config schema, as dotted paths. */
  function leafKeys(schema: unknown, prefix: string[] = []): string[] {
    const s = schema as {
      def?: { type?: string; shape?: Record<string, unknown>; innerType?: unknown };
    };
    const def = s.def;
    if (!def) return [prefix.join(".")];
    if (def.type === "default" || def.type === "prefault" || def.type === "optional") {
      return leafKeys(def.innerType, prefix);
    }
    if (def.type === "object" && def.shape) {
      return Object.entries(def.shape).flatMap(([k, v]) => leafKeys(v, [...prefix, k]));
    }
    return [prefix.join(".")];
  }

  test("each leaf of the schema has a field or a row editor", () => {
    const covered = new Set(SECTIONS.flatMap((s) => (s.fields ?? []).map((f) => f.path.join("."))));
    const rows = SECTIONS.flatMap((s) =>
      s.rows ? [{ team: "team.members", areas: "areas", teams: "teams" }[s.rows]] : [],
    );
    // repos and topics are edited in homeostat.yaml until their editors land (0.2.0 step 6).
    const later = ["repos", "topics"];
    const missing = leafKeys(configSchema).filter(
      (k) =>
        k !== "version" &&
        !covered.has(k) &&
        !rows.some((r) => k === r || k.startsWith(`${r}.`)) &&
        !later.some((r) => k === r || k.startsWith(`${r}.`)),
    );
    expect(missing).toEqual([]);
  });
});

describe("applySection", () => {
  test("submitting a section unchanged keeps the config equivalent", () => {
    for (const s of SECTIONS.filter((x) => x.fields)) {
      const result = applySection(starterYaml, s.id, formFor(s.id));
      expect(result.issues, s.id).toEqual([]);
      expect(parseConfig(result.text ?? "").config, s.id).toEqual(config);
    }
  });

  test("a change is written and comments elsewhere survive", () => {
    const form = formFor("scoring");
    form.set("scoring.autoMergeThreshold", "4");
    const { text } = applySection(starterYaml, "scoring", form);
    expect(parseConfig(text ?? "").config?.scoring.autoMergeThreshold).toBe(4);
    expect(text).toContain("# Area name -> paths it covers.");
  });

  test("checkboxes and multi-checks", () => {
    const form = formFor("agents");
    form.delete("agents.deepDive.enabled");
    const agents = parseConfig(applySection(starterYaml, "agents", form).text ?? "").config?.agents;
    expect(agents?.deepDive.enabled).toBe(false);
    const dist = formFor("distribution");
    dist.delete("distribution.exports");
    dist.append("distribution.exports", "cursor");
    expect(
      parseConfig(applySection(starterYaml, "distribution", dist).text ?? "").config?.distribution
        .exports,
    ).toEqual(["cursor"]);
  });

  test("members: edit, add and remove rows", () => {
    const form = new URLSearchParams({
      "member.0.id": "dana",
      "member.0.handle": "@dana",
      "member.0.role": "senior",
      "member.0.areas": "integrations, core",
      "member.1.id": "lee",
      "member.1.role": "member",
      "member.1.areas": "frontend",
      "member.1.remove": "on",
      "member.2.id": "kim",
      "member.2.handle": "@kim",
      "member.2.role": "senior",
      "member.2.areas": "",
      "member.3.id": "",
    });
    const members = parseConfig(applySection(starterYaml, "team", form).text ?? "").config?.team
      .members;
    expect(members?.map((m) => m.id)).toEqual(["dana", "kim"]);
    expect(members?.[0]?.areas).toEqual(["integrations", "core"]);
  });

  test("areas row editor", () => {
    const form = new URLSearchParams({
      "area.0.name": "integrations",
      "area.0.globs": "services/integrations/**\npackages/http-client/**",
      "area.1.name": "frontend",
      "area.1.globs": "apps/web/**",
      "area.2.name": "payments",
      "area.2.globs": "services/payments/**",
    });
    const areas = parseConfig(applySection(starterYaml, "areas", form).text ?? "").config?.areas;
    expect(Object.keys(areas ?? {})).toEqual(["integrations", "frontend", "payments"]);
  });

  test("saving one changed field changes only that line (found in the phase 1 run)", () => {
    const yaml = `version: 1
team:
  members:
    - id: dana
      handle: "@dana"
      role: senior
      areas: [core, web]
areas:
  web: ["web/**"]
distribution:
  tokenBudget: 2000
`;
    // What a browser submits: every field of the section, most of them unchanged.
    const form = new URLSearchParams([
      ["distribution.exports", "claude"],
      ["distribution.exports", "cursor"],
      ["distribution.exports", "agents-md"],
      ["distribution.exports", "copilot"],
      ["distribution.tokenBudget", "1500"],
      ["distribution.docTokenBudget", "1000"],
    ]);
    const text = applySection(yaml, "distribution", form).text ?? "";
    expect(text).toBe(yaml.replace("tokenBudget: 2000", "tokenBudget: 1500"));
  });

  test("submitting the team section unchanged leaves the file byte for byte", () => {
    const yaml = `version: 1
team:
  members:
    - id: dana
      handle: "@dana"
      role: senior
      areas: [core, web]
areas:
  web: ["web/**"]
`;
    const form = new URLSearchParams({
      "member.0.id": "dana",
      "member.0.handle": "@dana",
      "member.0.role": "senior",
      "member.0.areas": "core, web",
    });
    expect(applySection(yaml, "team", form).text).toBe(yaml);
  });

  test("teams row editor (K3)", () => {
    const form = new URLSearchParams({
      "teamrow.0.name": "partners",
      "teamrow.0.handle": "@acme/partners",
      "teamrow.0.members": "dana, sam",
      "teamrow.0.areas": "integrations",
      "teamrow.0.repos": "acme/integrations-api",
      "teamrow.1.name": "",
    });
    const result = applySection(starterYaml, "teams", form);
    expect(result.issues).toEqual([]);
    expect(parseConfig(result.text ?? "").config?.teams).toEqual({
      partners: {
        handle: "@acme/partners",
        members: ["dana", "sam"],
        areas: ["integrations"],
        repos: ["acme/integrations-api"],
      },
    });
  });

  test("an invalid change is refused with the reason, and nothing is returned to write", () => {
    const form = formFor("agents");
    form.set("agents.curator.schedule", "every day");
    const result = applySection(starterYaml, "agents", form);
    expect(result.text).toBeUndefined();
    expect(result.issues[0]?.message).toContain(
      "agents.curator.schedule: must be a five-field cron expression",
    );
  });

  test("removing a member an area still references is refused", () => {
    const form = new URLSearchParams({
      "member.0.id": "lee",
      "member.0.role": "member",
      "member.0.areas": "nope",
    });
    expect(applySection(starterYaml, "team", form).issues[0]?.message).toContain(
      '"nope" is not in areas',
    );
  });

  test("an empty host removes the sources section", () => {
    const form = formFor("sources");
    form.set("sources.host", "");
    const { text } = applySection(starterYaml, "sources", form);
    expect(parseConfig(text ?? "").config?.sources).toBeUndefined();
  });

  test("an emptied optional field is removed, not set to an empty string", () => {
    const form = formFor("notifications");
    form.set("notifications.slackWebhookEnv", "");
    const { text } = applySection(starterYaml, "notifications", form);
    expect(parseConfig(text ?? "").config?.notifications.slackWebhookEnv).toBeUndefined();
  });
});
