import { describe, expect, test } from "vitest";
import { idempotentWrite, ProviderError, requestJson } from "../../src/providers/http.ts";

const dropped = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function host(...replies: (Response | Error)[]) {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r ?? ok();
  }) as typeof fetch;
  const pauses: number[] = [];
  const sleep = async (ms: number) => {
    pauses.push(ms);
  };
  return { fetchFn, calls, pauses, sleep };
}

test("a read survives a dropped connection and a busy host, backing off between tries", async () => {
  const h = host(dropped("ECONNRESET"), new Response("", { status: 503 }), ok());
  const r = await requestJson("Bitbucket", h.fetchFn, "https://api.example/x", { headers: {} }, h);
  expect(r.body).toEqual({ ok: true });
  expect(h.calls).toHaveLength(3);
  expect(h.pauses).toEqual([1000, 2000]);
});

test("a 429 waits as long as the host's Retry-After says", async () => {
  const busy = new Response("", { status: 429, headers: { "retry-after": "7" } });
  const h = host(busy, ok());
  await requestJson("GitHub", h.fetchFn, "https://api.example/x", { headers: {} }, h);
  expect(h.pauses).toEqual([7000]);
});

test("a write is not sent again after a mid-request drop, since it may have landed", async () => {
  const h = host(dropped("ECONNRESET"), ok());
  const sent = requestJson(
    "Bitbucket",
    h.fetchFn,
    "https://api.example/pr",
    { method: "POST", headers: {}, body: { title: "x" } },
    h,
  );
  await expect(sent).rejects.toThrow(/network error ECONNRESET after 1 try/);
  expect(h.calls).toEqual(["POST"]);
});

test("a write is retried when the connection failed before anything was sent", async () => {
  const h = host(dropped("ECONNREFUSED"), ok());
  await requestJson(
    "Bitbucket",
    h.fetchFn,
    "https://api.example/pr",
    { method: "POST", headers: {} },
    h,
  );
  expect(h.calls).toEqual(["POST", "POST"]);
});

test("after the last try, a network failure is a ProviderError that says to rerun", async () => {
  const h = host(...Array.from({ length: 4 }, () => dropped("ECONNRESET")));
  const e = await requestJson(
    "Bitbucket",
    h.fetchFn,
    "https://api.example/x",
    { headers: {} },
    h,
  ).catch((err: unknown) => err);
  expect(e).toBeInstanceOf(ProviderError);
  expect((e as ProviderError).status).toBe(0);
  expect((e as Error).message).toMatch(/network error ECONNRESET after 4 tries; rerun/);
  expect(h.pauses).toEqual([1000, 2000, 4000]);
});

test("a refusal such as 404 is not retried", async () => {
  const h = host(new Response(JSON.stringify({ error: { message: "nope" } }), { status: 404 }));
  await expect(
    requestJson("Bitbucket", h.fetchFn, "https://api.example/x", { headers: {} }, h),
  ).rejects.toThrow(/404.*nope/);
  expect(h.calls).toHaveLength(1);
});

describe("a write a dropped connection may have carried out", () => {
  const drop = () =>
    new ProviderError("Bitbucket", 0, "https://api.example/pr", "network error UND_ERR_SOCKET");

  test("is not sent again when it landed: the existing result is used", async () => {
    let writes = 0;
    const out = await idempotentWrite(
      async () => {
        writes++;
        throw drop();
      },
      async () => ({ value: { id: 7 } }),
    );
    expect(out).toEqual({ id: 7 });
    expect(writes).toBe(1);
  });

  test("is sent again when it did not land", async () => {
    let writes = 0;
    const out = await idempotentWrite(
      async () => {
        writes++;
        if (writes === 1) throw drop();
        return { id: 8 };
      },
      async () => undefined,
    );
    expect(out).toEqual({ id: 8 });
    expect(writes).toBe(2);
  });

  test("a refusal from the host is not retried", async () => {
    let looked = 0;
    const refused = new ProviderError("Bitbucket", 400, "https://api.example/pr", "bad");
    await expect(
      idempotentWrite(
        async () => {
          throw refused;
        },
        async () => {
          looked++;
          return undefined;
        },
      ),
    ).rejects.toBe(refused);
    expect(looked).toBe(0);
  });
});
