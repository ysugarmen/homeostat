import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATUSES } from "@homeostat/core";
import { dashboardView, readSnapshot, renderPage } from "./server.ts";
import { SECTIONS } from "./settings.ts";
import { LOCAL_ONLY_PAGES, layout } from "./views.ts";

export interface BuildOptions {
  kbRoot: string;
  /** Output directory; emptied first. */
  out: string;
  now?: Date;
}

/**
 * Security headers for a static host that reads a `_headers` file (Cloudflare Pages, Netlify):
 * the local server's policy, with no form target at all, since nothing here can be submitted.
 */
const HEADERS = `/*
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Cache-Control: no-cache
`;

/** `/entries?status=x` filters by query string; a static host serves it at a path instead. */
const statusPath = (status: string) => `/entries/status/${status}`;
const staticLinks = (html: string) =>
  html.replace(/href="\/entries\?status=([a-z]+)"/g, (_, s: string) => `href="${statusPath(s)}"`);

/** Where a page lives: `/` is index.html, `/a/b` is a/b.html, which static hosts serve at /a/b. */
const fileFor = (path: string) => (path === "/" ? "index.html" : `${path.slice(1)}.html`);

/**
 * `homeostat dashboard --build`: the dashboard as static, read-only pages for a shared host,
 * built from the KB checkout as it is now. Pages that only a laptop's event log can fill are left
 * out. Returns the files written, relative to `out`.
 */
export function buildDashboard(opts: BuildOptions): string[] {
  const now = opts.now ?? new Date();
  const snap = readSnapshot(opts.kbRoot, now);
  if (!snap) throw new Error(`homeostat.yaml is missing or invalid in ${opts.kbRoot}`);
  const v = dashboardView(opts.kbRoot, snap);
  const repo = snap.config.sources?.kbRepo ?? opts.kbRoot.split("/").filter(Boolean).at(-1) ?? "kb";
  const shared = { repo, builtAt: now.toISOString() };

  const pages: { path: string; render: string; params?: URLSearchParams }[] = [
    ...["/", "/automation", "/entries", "/members", "/coverage", "/documents", "/settings"].map(
      (path) => ({ path, render: path }),
    ),
    ...STATUSES.map((s) => ({
      path: statusPath(s),
      render: "/entries",
      params: new URLSearchParams({ status: s }),
    })),
    ...snap.entries.map((e) => ({
      path: `/entries/${e.frontmatter.id}`,
      render: `/entries/${e.frontmatter.id}`,
    })),
    ...SECTIONS.map((s) => ({ path: `/settings/${s.id}`, render: `/settings/${s.id}` })),
    { path: "/404", render: "/404" },
  ].filter((p) => !LOCAL_ONLY_PAGES.includes(p.render));

  rmSync(opts.out, { recursive: true, force: true });
  const written: string[] = [];
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(opts.out, file)), { recursive: true });
    writeFileSync(join(opts.out, file), text);
    written.push(file);
  };
  for (const p of pages) {
    const r = renderPage(v, p.render, p.params ?? new URLSearchParams(), {});
    // The entries page highlights its filter by the path it is served at.
    const html = layout({
      title: r.title,
      path: p.render,
      kbRoot: opts.kbRoot,
      body: r.body,
      status: v.lamps,
      shared,
    });
    write(fileFor(p.path), staticLinks(html));
  }
  write("_headers", HEADERS);
  return written;
}
