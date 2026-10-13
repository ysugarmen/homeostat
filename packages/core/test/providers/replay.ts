import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

interface Exchange {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body?: unknown };
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Same origin, path and query parameters, regardless of order or encoding. */
function sameUrl(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  const params = (u: URL) => [...u.searchParams].sort(([x], [y]) => x.localeCompare(y));
  return (
    ua.origin === ub.origin &&
    ua.pathname === ub.pathname &&
    isDeepStrictEqual(params(ua), params(ub))
  );
}

/**
 * A fetch that replays a recorded session from test/fixtures. Any request not in the session
 * throws, so a provider under test can never reach the network.
 */
export function replayFetch(provider: "bitbucket" | "github") {
  const path = new URL(`../fixtures/${provider}/session.json`, import.meta.url);
  const { exchanges } = JSON.parse(readFileSync(path, "utf8")) as { exchanges: Exchange[] };
  const sent: SentRequest[] = [];

  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, body });

    const match = exchanges.find(
      (e) =>
        e.request.method === method &&
        sameUrl(e.request.url, url) &&
        (e.request.body === undefined || isDeepStrictEqual(e.request.body, body)),
    );
    if (!match) throw new Error(`unrecorded request: ${method} ${url} ${JSON.stringify(body)}`);
    const { status, headers, body: resBody } = match.response;
    return new Response(resBody === undefined ? null : JSON.stringify(resBody), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };

  return { fetch: fetchFn as typeof fetch, sent };
}
