import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { DEFAULT_WEIGHTS, parseConfig } from "../src/config.ts";

const validConfig = () => ({
  version: 1,
  team: {
    members: [
      { id: "dana", role: "senior", areas: ["integrations"] },
      { id: "lee", role: "member", areas: ["frontend", "core"] },
    ],
  },
  areas: {
    integrations: ["services/integrations/**"],
    frontend: ["apps/web/**"],
  },
  scoring: { autoMergeThreshold: 3, reviewCadence: "weekly" },
  agents: {
    curator: { enabled: true, schedule: "0 6 * * *" },
    deepDive: { enabled: false, schedule: "0 7 * * 1" },
  },
  distribution: { exports: ["claude", "agents-md"], tokenBudget: 2000 },
  notifications: { slackWebhookEnv: "KBX_SLACK_WEBHOOK", digestDay: "monday" },
});

const parse = (patch: (c: Record<string, any>) => void = () => {}) => {
  const c: Record<string, any> = validConfig();
  patch(c);
  return parseConfig(stringify(c));
};
const messages = (patch: (c: Record<string, any>) => void) =>
  parse(patch).issues.map((i) => i.message);

describe("parseConfig", () => {
  test("parses a valid config and fills default weights", () => {
    const { config, issues } = parse();
    expect(issues).toEqual([]);
    expect(config?.scoring.weights).toEqual(DEFAULT_WEIGHTS);
    expect(config?.team.members.map((m) => m.id)).toEqual(["dana", "lee"]);
  });

  test("weights can be overridden one at a time", () => {
    const { config } = parse((c) => (c.scoring.weights = { conflict: -5 }));
    expect(config?.scoring.weights).toEqual({ ...DEFAULT_WEIGHTS, conflict: -5 });
  });

  test("sections other than team and areas are optional", () => {
    const { config, issues } = parse((c) => {
      delete c.agents;
      delete c.distribution;
      delete c.notifications;
      delete c.scoring;
    });
    expect(issues).toEqual([]);
    expect(config?.scoring.autoMergeThreshold).toBe(3);
    expect(config?.distribution.tokenBudget).toBe(2000);
  });

  test("invalid YAML", () => {
    expect(parseConfig("team: [").issues.map((i) => i.code)).toEqual(["config.yaml"]);
  });

  test("malformed config gets a clear, located message", () => {
    expect(messages((c) => (c.team.members[0].role = "lead"))).toEqual([
      'team.members.0.role: Invalid option: expected one of "senior"|"member"',
    ]);
  });

  test("the old `verticals` key gets a hint", () => {
    expect(
      messages((c) => {
        c.verticals = c.areas;
        delete c.areas;
      }),
    ).toEqual(expect.arrayContaining(['verticals: unknown key; did you mean "areas"?']));
  });

  test("a literal webhook URL is rejected so secrets stay out of the repo", () => {
    expect(
      messages((c) => (c.notifications = { slackWebhook: "https://hooks.slack.com/x" })),
    ).toEqual(['notifications.slackWebhook: unknown key; did you mean "slackWebhookEnv"?']);
  });

  test("duplicate member ids", () => {
    expect(parse((c) => c.team.members.push({ id: "dana", role: "member" })).issues).toContainEqual(
      expect.objectContaining({ code: "config.member.duplicate" }),
    );
  });

  test("member areas must exist", () => {
    expect(parse((c) => (c.team.members[0].areas = ["payments"])).issues).toContainEqual(
      expect.objectContaining({ code: "config.member.area" }),
    );
  });

  test("`core` is reserved and cannot be redefined", () => {
    expect(parse((c) => (c.areas.core = ["**"])).issues).toContainEqual(
      expect.objectContaining({ code: "config.area.reserved" }),
    );
  });

  test("area names follow the id pattern and need at least one glob", () => {
    expect(parse((c) => (c.areas["Front End"] = ["x/**"])).issues.length).toBeGreaterThan(0);
    expect(parse((c) => (c.areas.frontend = [])).issues.length).toBeGreaterThan(0);
  });
});
