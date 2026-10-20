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
});
