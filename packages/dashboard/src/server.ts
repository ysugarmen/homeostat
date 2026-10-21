import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_WINDOW,
  type Event,
  type MetricsReport,
  memberFromGit,
  metricsReport,
  readEvents,
  readKbFiles,
  sectionUsage,
  validate,
} from "@homeostat/core";
import {
  automationPage,
  automationView,
  decidedLessons,
  firstName,
  gitUserName,
  type Lamp,
  lamps,
  readAutomation,
} from "./automation.ts";
import {
  agentLiveness,
  contributions,
  coverage,
  desirePaths,
  health,
  impact,
  type Snapshot,
} from "./metrics.ts";
import { performancePage } from "./performance.ts";
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
/** Everything the pages are built from, read from the KB checkout at one moment. */
export function readSnapshot(kbRoot: string, now: Date): Snapshot | undefined {
  const kb = validate(readKbFiles(kbRoot));
  if (!kb.config) return undefined;
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  return {
    config: kb.config,
    entries: kb.entries.map((e) => ({
      ...e.entry,
      path: e.path,
      ...(e.file ? { file: e.file } : {}),
    })),
    docs: kb.docs,
    events: readEvents(kbRoot, { since }),
    now,
  };
}

export interface DashboardView {
  kbRoot: string;
  snap: Snapshot;
  autoState: ReturnType<typeof readAutomation>;
  auto: ReturnType<typeof automationView>;
  health: ReturnType<typeof health>;
  /** The console lamps on every page: the daily run, the review queue, sync and the KB. */
  lamps: Lamp[];
  metrics: MetricsReport;
}

export function dashboardView(kbRoot: string, snap: Snapshot): DashboardView {
  // One read of the state branch: twice the window of runs, so trends have a previous window.
  // The Automation page keeps its view of the last 30.
  const state = readAutomation(kbRoot, 2 * DEFAULT_WINDOW.runs);
  const autoState = { ...state, runs: state.runs.slice(-DEFAULT_WINDOW.runs) };
  const auto = automationView(autoState, snap.config, snap.now);
  const kbHealth = health(snap);
  const metrics = metricsReport({
    config: snap.config,
    entries: snap.entries,
    events: snap.events,
    runs: state.runs,
    decisions: state.decisions,
    heartbeats: state.heartbeats,
    member: memberFromGit(snap.config.team.members, gitUserName(kbRoot)),
    now: snap.now,
    window: DEFAULT_WINDOW,
  });
  return {
    kbRoot,
    snap,
    autoState,
    auto,
    health: kbHealth,
    metrics,
    lamps: lamps(
      auto,
      {
        stability: kbHealth.stability,
        accepted: kbHealth.byStatus.accepted,
        flagged: kbHealth.flagged.length,
        disputed: kbHealth.byStatus.disputed,
      },
      snap.now,
      agentLiveness(snap).find((a) => a.agent === "curator")?.nextRun,
    ),
  };
}

/**
 * One GET page. With a `token` the settings pages are forms; without one (the shared, static
 * build) they are read-only, and the greeting, which names the checkout's git user, is left out.
 */
export function renderPage(
  v: DashboardView,
  pathname: string,
  params: URLSearchParams,
  opts: { token?: string; shared?: boolean },
): { title: string; body: string; status: number } {
  const { snap, auto, autoState } = v;
  const ok = (title: string, body: string) => ({ title, body, status: 200 });
  const notFound = (text: string) => ({
    title: "Not found",
    body: messagePage("Not found", text),
    status: 404,
  });
  const week = new Date(snap.now.getTime() - 7 * 86_400_000).toISOString();
  const name = opts.token ? firstName(v.kbRoot) : undefined;
  switch (pathname) {
    case "/": {
      const recent: Event[] = snap.events.slice(-60).reverse();
      return ok(
        "Overview",
        overviewPage(v.health, agentLiveness(snap), impact(snap), recent, auto, v.lamps, {
          ...(name ? { name } : {}),
          newThisWeek: snap.entries.filter(
            (e) =>
              e.frontmatter.status === "accepted" && e.frontmatter.created >= week.slice(0, 10),
          ).length,
          decided: decidedLessons(autoState),
        }),
      );
    }
    case "/automation":
      return ok("Automation", automationPage(auto));
    case "/performance":
      return ok("Performance", performancePage(v.metrics, { shared: opts.shared === true }));
    case "/entries":
      return ok(
        "Entries",
        entriesPage(
          snap.entries,
          params.get("status"),
          params.get("q"),
          snap.config,
          params.get("repo"),
        ),
      );
    case "/members":
      return ok("Members", membersPage(contributions(snap)));
    case "/coverage":
      return ok("Coverage", coveragePage(coverage(snap)));
    case "/impact":
      return ok("Impact", impactPage(impact(snap)));
    case "/documents":
      return ok("Documents", documentsPage(sectionUsage(snap.docs ?? [], snap.events, snap.now)));
    case "/desire-paths":
      return ok("Desire paths", desirePathsPage(desirePaths(snap)));
    case "/events":
      return ok(
        "Events",
        eventsPage(snap.events.filter((e) => e.ts >= week).reverse(), params.get("type")),
      );
    case "/settings":
      return ok("Settings", settingsIndex());
  }
  const entry = /^\/entries\/([a-z0-9-]+)$/.exec(pathname);
  if (entry) {
    const found = snap.entries.find((e) => e.frontmatter.id === entry[1]);
    return found
      ? ok(found.frontmatter.title, entryPage(found, snap.config))
      : notFound(`No entry with id ${entry[1]}.`);
  }
  const settings = /^\/settings\/([a-z]+)$/.exec(pathname);
  const section = settings && SECTIONS.find((s) => s.id === settings[1]);
  if (section) return ok(section.title, settingsPage(section, snap.config, opts.token));
  return notFound("Nothing here.");
}

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
  const sameSite = (origin: string) => {
    try {
      return allowed(new URL(origin).host);
    } catch {
      return false;
    }
  };
  const allowed = (hostPort: string | undefined) => {
    try {
      return Boolean(hostPort) && allowedNames.has(new URL(`http://${hostPort}`).hostname);
    } catch {
      return false;
    }
  };

  const snapshot = () => readSnapshot(opts.kbRoot, now());

  const send = (res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      // same-origin, not no-referrer: under no-referrer Chrome sends "Origin: null" on this
      // page's own form posts, which the write check below must refuse.
      "referrer-policy": "same-origin",
    });
    res.end(html);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding and cross-site protection: only our own Host, and our own Origin on writes.
    if (!allowed(req.headers.host)) return send(res, 421, "Misdirected request");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    // ?theme= picks a theme and a cookie keeps it; dark is the default.
    const asked = url.searchParams.get("theme");
    const kept = /(?:^|;\s*)theme=(light|dark)/.exec(req.headers.cookie ?? "")?.[1];
    const t = asked === "light" || asked === "dark" ? asked : kept;
    const theme = t === "light" || t === "dark" ? { theme: t as "light" | "dark" } : {};
    if (asked === "light" || asked === "dark") {
      res.setHeader("set-cookie", `theme=${asked}; Path=/; SameSite=Strict; Max-Age=31536000`);
    }
    let lampsNow: Lamp[] = [];
    const page = (title: string, body: string, status = 200) =>
      send(
        res,
        status,
        layout({
          title,
          path: url.pathname,
          kbRoot: opts.kbRoot,
          body,
          status: lampsNow,
          ...theme,
        }),
      );

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
    const v = dashboardView(opts.kbRoot, snap);
    lampsNow = v.lamps;

    if (req.method === "POST") {
      // Our own pages send their origin; "null" or anything unreadable is refused, never parsed blind.
      const origin = req.headers.origin;
      if (origin && !sameSite(origin)) return send(res, 403, "Cross-origin request refused");
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
    const r = renderPage(v, url.pathname, url.searchParams, { token });
    return page(r.title, r.body, r.status);
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
