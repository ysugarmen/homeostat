import { describe, expect, test } from "vitest";
import { generateCodeowners } from "../src/codeowners.ts";
import { parseConfig } from "../src/config.ts";
import { type Entry, parseEntry } from "../src/entry.ts";
import { renderContext, selectEntries } from "../src/select.ts";

const base = `version: 1
team:
  members:
    - { id: dana, role: senior, handle: "@dana" }
    - { id: lee, role: member, handle: "@lee" }
    - { id: sam, role: member, handle: "@sam" }
areas:
  integrations: ["services/integrations/**"]
  frontend: ["apps/web/**"]
`;

const config = (teams: string) => {
  const r = parseConfig(`${base}teams:\n${teams}`);
  return { config: r.config, codes: r.issues.map((i) => i.code) };
};

describe("teams (K3)", () => {
  test("an area's owning team approves it: by team handle, or by its members", () => {
    const { config: c } = config(`  partners:
    handle: "@acme/partners"
    members: [sam]
    areas: [integrations]
  web:
    members: [lee]
    areas: [frontend]
`);
    if (!c) throw new Error("bad config");
    const { text, issues } = generateCodeowners(c, []);
    expect(issues).toEqual([]);
    expect(text).toMatch(/^\/knowledge\/integrations\/\s+@acme\/partners$/m);
    expect(text).toMatch(/^\/knowledge\/frontend\/\s+@lee$/m);
    expect(text).toMatch(/^\/knowledge\/core\/\s+@dana$/m); // seniors own core
  });

  test.each([
    [
      "config.team.area.owned",
      "  a: { members: [lee], areas: [frontend] }\n  b: { members: [sam], areas: [frontend] }\n",
    ],
    ["config.team.member", "  a: { members: [nobody], areas: [frontend] }\n"],
    ["config.team.area", "  a: { members: [lee], areas: [mobile] }\n"],
    ["config.team.empty", "  a: { areas: [frontend] }\n"],
  ])("rejects %s", (code, teams) => {
    expect(config(teams).codes).toContain(code);
  });

  test("one team's rule reaches another team's session on the same paths", () => {
    const { config: c } = config(
      "  partners: { members: [sam], areas: [integrations] }\n  web: { members: [lee], areas: [frontend] }\n",
    );
    if (!c) throw new Error("bad config");
    const entry = parseEntry(`---
id: use-retry-helper
title: Use the retry helper
area: integrations
scope: ["services/integrations/**"]
status: accepted
score: 4
owner: sam
source: { type: manual, author: sam }
created: 2026-10-01
lastConfirmed: 2026-10-01
tokens: 20
---

## Rule
Wrap partner calls in withRetry().

## Why
Partners time out.
`).entry as Entry;
    // lee is on the web team; reads are org-wide, so the partners team's rule still applies.
    const text = renderContext(
      selectEntries([entry], { paths: ["services/integrations/client.ts"], tokenBudget: 2000 }),
    );
    expect(text).toContain("use-retry-helper");
  });
});
