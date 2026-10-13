export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly url: string,
    detail: string,
  ) {
    super(`${provider} API ${status} for ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "ProviderError";
  }
}

export interface JsonResponse {
  body: unknown;
  headers: Headers;
}

/** Sends a JSON request and throws a `ProviderError` on any non-2xx status. */
export async function requestJson(
  provider: string,
  fetchFn: typeof fetch,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: unknown },
): Promise<JsonResponse> {
  const headers = { ...init.headers };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchFn(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
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
