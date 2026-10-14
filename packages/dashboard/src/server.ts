import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  CONFIG_FILE,
  type Event,
  readEvents,
  readKbFiles,
  sectionUsage,
  validate,
} from "@homeostat/core";
import {
  agentLiveness,
  contributions,
  coverage,
  desirePaths,
  health,
  impact,
  type Snapshot,
} from "./metrics.ts";
import { applySection, SECTIONS } from "./settings.ts";
import {
  coveragePage,
  desirePathsPage,
  documentsPage,
  entriesPage,
  entryPage,
  eventsPage,
  impactPage,
  layout,
  membersPage,
  messagePage,
  overviewPage,
  settingsIndex,
  settingsPage,
} from "./views.ts";

export interface DashboardOptions {
  kbRoot: string;
  port?: number;
  /** Interface to bind; loopback by default so the dashboard is never on the network. */
  host?: string;
  now?: () => Date;
}

const MAX_BODY = 256 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const sameToken = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The local dashboard: setup forms and metrics, rendered on the server from the KB checkout and
 * its event log on every request, so it is always live. Binds to loopback and rejects requests
 * whose Host or Origin is not this server, so other web pages cannot drive its forms.
 */
export function startDashboard(opts: DashboardOptions): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  const token = randomBytes(24).toString("hex");
  const now = opts.now ?? (() => new Date());
  // DNS-rebinding protection keys on the hostname: a browser only sends one of these when it
  // really is talking to this machine. Any port, so a container's port mapping still works.
  const allowedNames = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(host === "0.0.0.0" ? [] : [host]),
  ]);
  const allowed = (hostPort: string | undefined) => {
    try {
      return Boolean(hostPort) && allowedNames.has(new URL(`http://${hostPort}`).hostname);
    } catch {
      return false;
    }
  };

  const snapshot = (): Snapshot | undefined => {
    const kb = validate(readKbFiles(opts.kbRoot));
    if (!kb.config) return undefined;
    const since = new Date(now().getTime() - 90 * 86_400_000).toISOString();
    return {
      config: kb.config,
      entries: kb.entries.map((e) => e.entry),
      docs: kb.docs,
      events: readEvents(opts.kbRoot, { since }),
      now: now(),
    };
  };

  const send = (res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(html);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding and cross-site protection: only our own Host, and our own Origin on writes.
    if (!allowed(req.headers.host)) return send(res, 421, "Misdirected request");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const t = url.searchParams.get("theme");
    const theme = t === "light" || t === "dark" ? { theme: t as "light" | "dark" } : {};
    const page = (title: string, body: string, status = 200) =>
      send(res, status, layout({ title, path: url.pathname, kbRoot: opts.kbRoot, body, ...theme }));

    const snap = snapshot();
    if (!snap) {
      return page(
        "No knowledge base",
        messagePage(
          "No knowledge base",
          `${CONFIG_FILE} is missing or invalid in ${opts.kbRoot}. Run homeostat validate there.`,
        ),
        500,
      );
    }

    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && !allowed(new URL(origin).host))
        return send(res, 403, "Cross-origin request refused");
      const m = /^\/settings\/([a-z]+)$/.exec(url.pathname);
      const section = m && SECTIONS.find((s) => s.id === m[1]);
      if (!section)
        return page("Not found", messagePage("Not found", "No such settings section."), 404);
      let form: URLSearchParams;
      try {
        form = new URLSearchParams(await readBody(req));
      } catch {
        return send(res, 413, "Too large");
      }
      if (!sameToken(form.get("_token") ?? "", token))
        return send(res, 403, "Stale form: reload the page and try again");
      const path = join(opts.kbRoot, CONFIG_FILE);
      const result = applySection(readFileSync(path, "utf8"), section.id, form);
      if (!result.text)
        return page(
          section.title,
          settingsPage(section, snap.config, token, { issues: result.issues }),
          422,
        );
      writeFileSync(path, result.text);
      const fresh = snapshot();
      return page(
        section.title,
        settingsPage(section, fresh?.config ?? snap.config, token, { saved: true }),
      );
    }

    if (req.method !== "GET") return send(res, 405, "Method not allowed");
    const week = new Date(snap.now.getTime() - 7 * 86_400_000).toISOString();
    switch (url.pathname) {
      case "/": {
        const recent: Event[] = snap.events.slice(-12).reverse();
        return page(
          "Overview",
          overviewPage(health(snap), agentLiveness(snap), impact(snap), recent),
        );
      }
      case "/entries":
        return page("Entries", entriesPage(snap.entries, url.searchParams.get("status")));
      case "/members":
        return page("Members", membersPage(contributions(snap)));
      case "/coverage":
        return page("Coverage", coveragePage(coverage(snap)));
      case "/impact":
        return page("Impact", impactPage(impact(snap)));
      case "/documents":
        return page(
          "Documents",
          documentsPage(sectionUsage(snap.docs ?? [], snap.events, snap.now)),
        );
      case "/desire-paths":
        return page("Desire paths", desirePathsPage(desirePaths(snap)));
      case "/events":
        return page("Events", eventsPage(snap.events.filter((e) => e.ts >= week).reverse()));
      case "/settings":
        return page("Settings", settingsIndex());
    }
    const entry = /^\/entries\/([a-z0-9-]+)$/.exec(url.pathname);
    if (entry) {
      const found = snap.entries.find((e) => e.frontmatter.id === entry[1]);
      return found
        ? page(found.frontmatter.title, entryPage(found, snap.config))
        : page("Not found", messagePage("Not found", `No entry with id ${entry[1]}.`), 404);
    }
    const settings = /^\/settings\/([a-z]+)$/.exec(url.pathname);
    const section = settings && SECTIONS.find((s) => s.id === settings[1]);
    if (section) return page(section.title, settingsPage(section, snap.config, token));
    return page("Not found", messagePage("Not found", "Nothing here."), 404);
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      send(res, 500, `Dashboard error: ${String((e as Error).message).replace(/</g, "&lt;")}`);
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 4747, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 4747);
      resolve({
        server,
        url: `http://${host === "127.0.0.1" || host === "0.0.0.0" ? "localhost" : host}:${port}`,
      });
    });
  });
}
