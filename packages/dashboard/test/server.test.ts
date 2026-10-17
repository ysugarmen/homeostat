import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logEvent, parseConfig } from "@homeostat/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startDashboard } from "../src/server.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
let kb: string;
let url: string;
let close: () => void;

beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), "homeostat-dash-"));
  cpSync(starter, kb, { recursive: true });
  const now = new Date("2026-10-14T12:00:00Z");
  logEvent(kb, {
    ts: "2026-10-14T09:00:00.000Z",
    type: "injection",
    session: "s1",
    tokens: 120,
    entries: [{ id: "redact-before-logging" }],
  });
  logEvent(kb, { ts: "2026-10-14T09:05:00.000Z", type: "mcp-call", tool: "search" });
  logEvent(kb, {
    ts: "2026-10-14T09:06:00.000Z",
    type: "mcp-alias",
    name: "get_rules",
    resolved: "context",
  });
  logEvent(kb, {
    ts: "2026-10-14T06:00:00.000Z",
    type: "agent-run",
    agent: "curator",
    ok: true,
    summary: "1 drafted, 0 skipped",
  });
  logEvent(kb, {
    ts: "2026-10-14T09:10:00.000Z",
    type: "doc-read",
    doc: "integrations/partner-calls",
    section: "http-client",
  });
  const started = await startDashboard({ kbRoot: kb, port: 0, now: () => now });
  url = started.url;
  close = () => started.server.close();
});
afterAll(() => close());

const get = async (path: string) => {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, html: await res.text(), headers: res.headers };
};

/** The form token from a settings page. */
const tokenOf = (html: string) => /name="_token" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";

describe("theme", () => {
  test("dark by default; ?theme=light switches and a cookie keeps it", async () => {
    const plain = await fetch(`${url}/`);
    expect(await plain.text()).toContain('<html lang="en">');
    const light = await fetch(`${url}/?theme=light`);
    expect(light.headers.get("set-cookie")).toContain("theme=light");
    const later = await fetch(`${url}/entries`, { headers: { cookie: "theme=light" } });
    expect(await later.text()).toContain('<html lang="en" data-theme="light">');
  });
});

describe("pages render from the KB and the event log (4.3)", () => {
  test.each([
    [
      "/",
      [
        'class="units-row"',
        'class="gauge off"',
        "Review queue",
        "Developer sync",
        "No daily run on record in this clone yet",
        "The daily run is scheduled daily at 06:00 UTC",
      ],
    ],
    ["/entries", ["Use the shared retry helper for outbound HTTP calls", "candidate"]],
    [
      "/entries/outbound-http-retry-helper",
      [
        '<span class="d pos">+3</span>review comment led to a code change',
        '<dt>Owner</dt><dd><span class="mono">dana</span>',
        "Use the shared retry helper for outbound HTTP calls",
        '<span class="label">Rule</span>',
      ],
    ],
    ["/members", ["not a ranking", "dana", "lee", "sam"]],
    ["/coverage", ["Accepted rules by area", "No accepted rules yet for:", "frontend"]],
    ["/impact", ["Injections per day", "redact-before-logging", "search"]],
    ["/desire-paths", ["get_rules", "context"]],
    ["/events", ["mcp-alias", "guessed &quot;get_rules&quot; → context"]],
    ["/settings", ["Team and members", "Agent schedules", "Notifications"]],
  ])("%s", async (path, expected) => {
    const { status, html } = await get(path);
    expect(status).toBe(200);
    for (const text of expected) expect(html).toContain(text);
  });

  test("pages are locked down: no external resources, no caching", async () => {
    const { headers, html } = await get("/");
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(html).not.toMatch(/<(script|link)\b/);
  });

  test("unknown pages are 404", async () => {
    expect((await get("/nope")).status).toBe(404);
    expect((await get("/entries/nope")).status).toBe(404);
  });
});

describe("settings forms write homeostat.yaml (4.2)", () => {
  async function post(
    path: string,
    form: Record<string, string | string[]>,
    headers: Record<string, string> = {},
  ) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    });
    return { status: res.status, html: await res.text() };
  }

  test("a valid change is saved and shows on the next load", async () => {
    const token = tokenOf((await get("/settings/distribution")).html);
    const { status, html } = await post("/settings/distribution", {
      _token: token,
      "distribution.exports": ["claude", "cursor"],
      "distribution.tokenBudget": "1500",
    });
    expect(status).toBe(200);
    expect(html).toContain("Saved to homeostat.yaml");
    const config = parseConfig(readFileSync(join(kb, "homeostat.yaml"), "utf8")).config;
    expect(config?.distribution).toEqual({
      exports: ["claude", "cursor"],
      tokenBudget: 1500,
      docTokenBudget: 1000,
    });
    expect((await get("/settings/distribution")).html).toContain('value="1500"');
  });

  test("an invalid change is refused with the reason and nothing is written", async () => {
    const before = readFileSync(join(kb, "homeostat.yaml"), "utf8");
    const token = tokenOf((await get("/settings/notifications")).html);
    const { status, html } = await post("/settings/notifications", {
      _token: token,
      "notifications.slackWebhookEnv": "https://hooks.slack.com/oops",
      "notifications.digestDay": "monday",
    });
    expect(status).toBe(422);
    expect(html).toContain("must be an environment variable name");
    expect(readFileSync(join(kb, "homeostat.yaml"), "utf8")).toBe(before);
  });

  test("a post without the page's token is refused", async () => {
    expect((await post("/settings/scoring", { "scoring.autoMergeThreshold": "1" })).status).toBe(
      403,
    );
  });

  test("a post from another origin is refused", async () => {
    const token = tokenOf((await get("/settings/scoring")).html);
    const res = await post(
      "/settings/scoring",
      { _token: token },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });

  test("a browser's own form post, which carries the page's origin, is saved", async () => {
    const page = await get("/settings/distribution");
    // A browser sends the page's origin only when the referrer policy allows it.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const res = await post(
      "/settings/distribution",
      {
        _token: tokenOf(page.html),
        "distribution.exports": ["claude"],
        "distribution.tokenBudget": "1800",
      },
      { origin: new URL(url).origin },
    );
    expect(res.status).toBe(200);
    expect(res.html).toContain("Saved to homeostat.yaml");
  });

  test("an unreadable or null origin is refused, not crashed on", async () => {
    const token = tokenOf((await get("/settings/scoring")).html);
    for (const origin of ["null", "not a url"]) {
      const res = await post("/settings/scoring", { _token: token }, { origin });
      expect(res.status).toBe(403);
      expect(res.html).toContain("Cross-origin request refused");
    }
  });

  test("a request for another Host (DNS rebinding) is refused", async () => {
    const port = new URL(url).port;
    const status = await new Promise<number>((resolve) => {
      request(
        { host: "127.0.0.1", port, path: "/", headers: { host: `attacker.example:${port}` } },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      ).end();
    });
    expect(status).toBe(421);
  });
});

test("loopback names on any port are accepted (a container's port mapping)", async () => {
  const port = new URL(url).port;
  const status = await new Promise<number>((resolve) => {
    request({ host: "127.0.0.1", port, path: "/", headers: { host: "localhost:9999" } }, (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    }).end();
  });
  expect(status).toBe(200);
});

describe("documents page (K7)", () => {
  test("shows section usage from the event log", async () => {
    const { status, html } = await get("/documents");
    expect(status).toBe(200);
    expect(html).toContain("integrations/partner-calls#http-client");
    expect(html).toMatch(
      /http-client<\/span><br>The shared HTTP client<\/td><td class="num">1<\/td>/,
    );
    expect(html).toContain("integrations/partner-calls#timeouts");
  });
});
