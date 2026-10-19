import { describe, expect, test } from "vitest";
import { providerFor } from "../src/provider.ts";

describe("providerFor", () => {
  test("a Bitbucket API token goes out as Basic auth with its account email", async () => {
    const seen: string[] = [];
    const fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization ?? "");
      return new Response("[]", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const env = { HOMEOSTAT_BITBUCKET_TOKEN: "tok", HOMEOSTAT_BITBUCKET_EMAIL: "dev@example.com" };
    const bb = providerFor("bitbucket", { env, fetch } as never, "test");
    await bb.listCommits({ owner: "w", name: "r" }, 1).catch(() => {});
    expect(seen[0]).toBe(`Basic ${Buffer.from("dev@example.com:tok").toString("base64")}`);

    seen.length = 0;
    const access = providerFor(
      "bitbucket",
      { env: { HOMEOSTAT_BITBUCKET_TOKEN: "tok" }, fetch } as never,
      "test",
    );
    await access.listCommits({ owner: "w", name: "r" }, 1).catch(() => {});
    expect(seen[0]).toBe("Bearer tok");
  });
});
