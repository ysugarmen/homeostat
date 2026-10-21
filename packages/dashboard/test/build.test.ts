import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logEvent, readKbFiles, STATUSES, validate } from "@homeostat/core";
import { beforeAll, describe, expect, test } from "vitest";
import { buildDashboard } from "../src/build.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
let kb: string;
let out: string;
let files: string[];
const read = (file: string) => readFileSync(join(out, file), "utf8");
const html = () => files.filter((f) => f.endsWith(".html"));

beforeAll(() => {
  kb = mkdtempSync(join(tmpdir(), "homeostat-build-kb-"));
  cpSync(starter, kb, { recursive: true });
  // A laptop's event, which must not reach a shared build.
  logEvent(kb, { ts: "2026-10-14T09:05:00.000Z", type: "mcp-call", tool: "search-secret-query" });
  out = join(mkdtempSync(join(tmpdir(), "homeostat-build-out-")), "site");
  files = buildDashboard({ kbRoot: kb, out, now: new Date("2026-10-14T12:00:00Z") });
});

describe("homeostat dashboard --build", () => {
  test("writes every page as a file a static host serves at the page's path", () => {
    const ids = validate(readKbFiles(kb)).entries.map((e) => e.entry.frontmatter.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(files).toEqual(
      expect.arrayContaining([
        "index.html",
        "automation.html",
        "entries.html",
        "members.html",
        "coverage.html",
        "documents.html",
        "settings.html",
        "404.html",
        "_headers",
        ...ids.map((id) => `entries/${id}.html`),
        ...STATUSES.map((s) => `entries/status/${s}.html`),
      ]),
    );
    expect(readdirSync(out, { recursive: true }).length).toBeGreaterThan(files.length - 1);
  });

  test("every internal link leads to a page that was built", () => {
    const missing = new Set<string>();
    for (const f of html())
      for (const [, href = ""] of read(f).matchAll(/href="(\/[^"#]*)/g)) {
        const target = href === "/" ? "index.html" : `${href.slice(1)}.html`;
        if (!existsSync(join(out, target))) missing.add(`${f} -> ${href}`);
      }
    expect([...missing]).toEqual([]);
  });

  test("leaves out the pages only a laptop's event log can fill, and its events", () => {
    for (const page of ["impact.html", "desire-paths.html", "events.html"])
      expect(existsSync(join(out, page))).toBe(false);
    // The Performance page is built, without its per-machine panels.
    expect(read("performance.html")).toContain('aria-labelledby="calibration"');
    expect(read("performance.html")).not.toContain('id="session-start"');
    for (const f of html()) {
      expect(read(f)).not.toContain('href="/events"');
      expect(read(f)).not.toContain("search-secret-query");
    }
  });

  test("nothing can be submitted, and the local checkout's path is not shown", () => {
    for (const f of html()) {
      const page = read(f);
      expect(page).not.toContain('method="post"');
      expect(page).not.toContain('name="_token"');
      expect(page).not.toContain("?theme=");
      expect(page).not.toContain('role="search"');
      expect(page).not.toContain(kb);
    }
    expect(read("settings/team.html")).toContain("Read-only here");
    expect(read("_headers")).toContain("form-action 'none'");
  });

  test("names the KB repo and when it was built", () => {
    const page = read("index.html");
    expect(page).toContain("acme/team-kb");
    expect(page).toContain("built 2026-10-14 12:00 UTC");
  });

  test("a status page lists only that status, and marks its filter", () => {
    const accepted = read("entries/status/accepted.html");
    expect(accepted).toContain('<span class="chip accepted">');
    expect(accepted).not.toContain('<span class="chip candidate">');
    expect(accepted).toContain('href="/entries/status/accepted" aria-current="page"');
  });
});
