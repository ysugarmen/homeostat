import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { codeownersHandle, loginKey, memberForLogin } from "../src/handles.ts";

describe("handles", () => {
  // From a real Bitbucket workspace: most nicknames there are full names.
  const members = [
    { id: "yonatan", handle: "@Yonatan Sugarmen" },
    { id: "javi", handle: "@Javier Gallostra Acín" },
    { id: "joan", handle: "@joansalvatella" },
  ];

  test("a nickname with spaces or accents matches its member, whatever the case or spacing", () => {
    expect(memberForLogin(members, "Yonatan Sugarmen")?.id).toBe("yonatan");
    expect(memberForLogin(members, "yonatan  sugarmen")?.id).toBe("yonatan");
    expect(memberForLogin(members, "Javier Gallostra Acín")?.id).toBe("javi");
    expect(memberForLogin(members, "joansalvatella")?.id).toBe("joan");
    expect(memberForLogin(members, "someone else")).toBeUndefined();
    expect(loginKey('@"Ana Ruiz"')).toBe("ana ruiz");
  });

  test("CODEOWNERS quotes a handle with spaces and leaves the rest", () => {
    expect(codeownersHandle("@Yonatan Sugarmen")).toBe('@"Yonatan Sugarmen"');
    expect(codeownersHandle("@joansalvatella")).toBe("@joansalvatella");
    expect(codeownersHandle("@acme/payments")).toBe("@acme/payments");
  });

  test("homeostat.yaml accepts such handles, and still refuses a broken one", () => {
    const yaml = (handle: string) =>
      `version: 1\nteam:\n  members:\n    - { id: a, handle: "${handle}", role: lead, areas: [] }\nareas: {}\n`;
    expect(parseConfig(yaml("@Javier Gallostra Acín")).config).toBeDefined();
    expect(parseConfig(yaml("@ leading space")).config).toBeUndefined();
    expect(parseConfig(yaml("no-at-sign")).config).toBeUndefined();
  });
});

describe("memberFromGit", () => {
  const members = [
    { id: "yonatan", handle: "@Yonatan Sugarmen" },
    { id: "dana", handle: "@dana" },
    { id: "dani-toro", handle: "@dani.toro" },
  ];
  test("a git name finds its member by id, by handle, or by a unique first name", async () => {
    const { memberFromGit } = await import("../src/handles.ts");
    // From a real setup: git user.name "Yonatan Sugarmen", member yonatan, Bitbucket nickname
    // "Yonatan Sugarmen". It used to become yonatan-sugarmen, so sync kept every lesson local.
    expect(memberFromGit(members, "Yonatan Sugarmen")).toBe("yonatan");
    expect(memberFromGit(members, "Dana")).toBe("dana");
    expect(memberFromGit(members, "Dana Ruiz")).toBe("dana");
    expect(memberFromGit(members, "Someone Else")).toBe("someone-else");
    expect(memberFromGit(members, undefined)).toBe("owner");
  });

  test("an email in a member's emails wins over the name, whatever its case", async () => {
    const { memberFromGit } = await import("../src/handles.ts");
    // A laptop with no user.name signs commits with the computer's account name; others commit
    // as a login ("AnaRuiz", "lsmith") that is no id, handle or first name.
    const team = [
      { id: "ana", handle: "@Ana Ruiz Soler", emails: ["ana@acme.io", "ana@acme.com"] },
      { id: "lee", handle: "@leesmith", emails: ["lee@acme.io"] },
    ];
    expect(memberFromGit(team, { name: "AnaRuiz", email: "Ana@Acme.com" })).toBe("ana");
    expect(memberFromGit(team, { name: "lsmith", email: "lee@acme.io" })).toBe("lee");
    expect(memberFromGit(team, { name: "Ana Ruiz Soler", email: "ana@laptop.local" })).toBe("ana");
    expect(memberFromGit(team, { email: "someone@else.com" })).toBe("owner");
  });

  test("homeostat.yaml accepts a member's emails and refuses one that is no email", () => {
    const yaml = (emails: string) =>
      `version: 1\nteam:\n  members:\n    - { id: a, emails: ${emails}, role: lead, areas: [] }\nareas: {}\n`;
    expect(parseConfig(yaml("[a@acme.io, a@acme.com]")).config).toBeDefined();
    expect(parseConfig(yaml("[not-an-email]")).config).toBeUndefined();
  });
});
