import { describe, expect, test } from "vitest";
import { envAuth, providerFor } from "../src/provider.ts";

/** A fetch that records each request's Authorization header. */
function recorder() {
  const seen: string[] = [];
  const fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers.Authorization ?? "");
    return new Response("[]", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

const basic = (user: string, token: string) =>
  `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

describe("providerFor", () => {
  test("a Bitbucket API token goes out as Basic auth with its account email", async () => {
    const { seen, fetch } = recorder();
    const env = { HOMEOSTAT_GIT_TOKEN: "tok", HOMEOSTAT_GIT_EMAIL: "dev@example.com" };
    const bb = providerFor("bitbucket", { env, fetch } as never, "test");
    await bb.listCommits({ owner: "w", name: "r" }, 1).catch(() => {});
    expect(seen[0]).toBe(basic("dev@example.com", "tok"));

    seen.length = 0;
    const access = providerFor(
      "bitbucket",
      { env: { HOMEOSTAT_GIT_TOKEN: "tok" }, fetch } as never,
      "test",
    );
    await access.listCommits({ owner: "w", name: "r" }, 1).catch(() => {});
    expect(seen[0]).toBe("Bearer tok");
  });

  test("the old Bitbucket names still work, so existing knowledge bases keep running", async () => {
    const { seen, fetch } = recorder();
    const env = { HOMEOSTAT_BITBUCKET_TOKEN: "old", HOMEOSTAT_BITBUCKET_EMAIL: "dev@example.com" };
    const bb = providerFor("bitbucket", { env, fetch } as never, "test");
    await bb.listCommits({ owner: "w", name: "r" }, 1).catch(() => {});
    expect(seen[0]).toBe(basic("dev@example.com", "old"));
  });

  test("the new name wins over the old one; GitHub falls back to GITHUB_TOKEN last", () => {
    expect(
      envAuth("bitbucket", { HOMEOSTAT_GIT_TOKEN: "new", HOMEOSTAT_BITBUCKET_TOKEN: "old" }),
    ).toEqual({ token: "new", from: "HOMEOSTAT_GIT_TOKEN" });
    expect(envAuth("github", { HOMEOSTAT_GITHUB_TOKEN: "old", GITHUB_TOKEN: "actions" })).toEqual({
      token: "old",
      from: "HOMEOSTAT_GITHUB_TOKEN",
    });
    expect(envAuth("github", { HOMEOSTAT_GIT_TOKEN: "", GITHUB_TOKEN: "actions" })).toEqual({
      token: "actions",
      from: "GITHUB_TOKEN",
    });
    // An email is only for Bitbucket; a GitHub token never carries one.
    expect(envAuth("github", { HOMEOSTAT_GIT_TOKEN: "t", HOMEOSTAT_GIT_EMAIL: "x@y" })).toEqual({
      token: "t",
      from: "HOMEOSTAT_GIT_TOKEN",
    });
    expect(envAuth("bitbucket", { HOMEOSTAT_GITHUB_TOKEN: "wrong host" })).toBeUndefined();
  });

  test("a missing token names the new variable", () => {
    expect(() => providerFor("bitbucket", { env: {} } as never, "read PRs")).toThrow(
      "set HOMEOSTAT_GIT_TOKEN to read PRs",
    );
    expect(() => providerFor("github", { env: {} } as never, "read PRs")).toThrow(
      "set HOMEOSTAT_GIT_TOKEN or GITHUB_TOKEN to read PRs",
    );
  });
});
