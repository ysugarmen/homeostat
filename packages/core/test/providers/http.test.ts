import { expect, test } from "vitest";
import { ProviderError, requestJson } from "../../src/providers/http.ts";

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
