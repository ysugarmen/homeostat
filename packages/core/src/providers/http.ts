export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly url: string;

  constructor(provider: string, status: number, url: string, detail: string) {
    super(`${provider} API ${status} for ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.url = url;
  }
}

export interface JsonResponse {
  body: unknown;
  headers: Headers;
}

/** Tries per request, and the pause before each retry (doubled each time, or the host's Retry-After). */
export const HTTP_ATTEMPTS = 4;
const FIRST_PAUSE_MS = 1000;
const MAX_PAUSE_MS = 30_000;
/** Statuses that mean "not now", never "no": the request was not processed. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** Connection failures where nothing reached the host, so even a write can be sent again. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
/** Failures mid-request: the host may have acted, so only reads are sent again. */
const DROPPED = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/** The error code behind `fetch failed` (Node puts it on `cause`). */
const networkCode = (e: unknown): string | undefined => {
  const cause = (e as { cause?: { code?: unknown } })?.cause;
  const code = cause?.code ?? (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends a JSON request and throws a `ProviderError` on any non-2xx status. Transient failures are
 * retried with backoff, so one dropped connection in an hour-long run does not end it: a 429 or
 * 5xx gateway status, and a connection that failed before the request was sent; a connection
 * dropped mid-request is retried for reads only, since a write may already have landed. When the
 * tries run out, a network failure is reported as a `ProviderError` with status 0.
 */
export async function requestJson(
  provider: string,
  fetchFn: typeof fetch,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: unknown },
  retry: { sleep?: (ms: number) => Promise<void>; attempts?: number } = {},
): Promise<JsonResponse> {
  const method = init.method ?? "GET";
  const headers = { ...init.headers };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const sleep = retry.sleep ?? realSleep;
  const attempts = retry.attempts ?? HTTP_ATTEMPTS;
  let res: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    const pause = Math.min(FIRST_PAUSE_MS * 2 ** (attempt - 1), MAX_PAUSE_MS);
    try {
      res = await fetchFn(url, {
        method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (e) {
      const code = networkCode(e);
      const retryable =
        code !== undefined && (NOT_SENT.has(code) || (method === "GET" && DROPPED.has(code)));
      if (!retryable || attempt >= attempts) {
        if (code === undefined) throw e;
        throw new ProviderError(
          provider,
          0,
          url,
          `network error ${code} after ${attempt} ${attempt === 1 ? "try" : "tries"}; rerun when the connection is back`,
        );
      }
      await sleep(pause);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= attempts) break;
    const after = Number(res.headers.get("retry-after"));
    await res.text().catch(() => "");
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_PAUSE_MS) : pause);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ProviderError(provider, res.status, url, errorDetail(body));
  return { body, headers: res.headers };
}

/** Pulls a human message out of Bitbucket (`error.message`) or GitHub (`message`) errors. */
function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; error?: { message?: unknown } };
    if (typeof b.error?.message === "string") return b.error.message;
    if (typeof b.message === "string") return b.message;
  }
  return "";
}
