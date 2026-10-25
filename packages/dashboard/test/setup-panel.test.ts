import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKbFiles, readSetupRecord, setupRows, writeSetupRecord } from "@homeostat/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDashboard } from "../src/build.ts";
import { dashboardView, readSnapshot, renderPage } from "../src/server.ts";
import { setupPanel } from "../src/setup-panel.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const now = new Date("2026-10-25T12:00:00Z");
let kb: string;

/** The dashboard must never reach the network: any fetch fails the test. */
const fetchSpy = vi.fn(() => {
  throw new Error("the dashboard made a network call");
});

beforeEach(() => {
  kb = mkdtempSync(join(tmpdir(), "homeostat-setup-panel-"));
  cpSync(starter, kb, { recursive: true });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchSpy).not.toHaveBeenCalled();
});

const overview = (shared = false) => {
  const snap = readSnapshot(kb, now);
  if (!snap) throw new Error("starter KB is invalid");
  return renderPage(dashboardView(kb, snap), "/", new URLSearchParams(), {
    ...(shared ? { shared: true } : { token: "t" }),
  }).body;
};

describe("the Setup card", () => {
  test("shows done, missing and optional rows with a completion bar and the fixing command", () => {
    const rows = setupRows(kb, readKbFiles(kb), {});
    const html = setupPanel(rows);
    expect(html).toMatch(/\d+\/\d+ required · \d+\/\d+ optional/);
    expect(html).toContain('role="progressbar"');
    // A remote step with no record yet says how to check it.
    expect(html).toContain("not checked yet: run <code>homeostat setup --check</code>");
    // Optional rows carry what you lose as a tooltip.
    expect(html).toMatch(/optional<span class="info"[^]*?Without it the KB starts empty/);
    for (const r of rows.filter((r) => r.state === "missing"))
      expect(html).toContain(`homeostat setup --step ${r.name}`);
  });

  test("remote rows show the last recorded check and its date", () => {
    writeSetupRecord(
      kb,
      {
        token: { state: "done", reason: "HOMEOSTAT_GIT_TOKEN is stored" },
        model: { state: "missing", reason: "ANTHROPIC_API_KEY is not stored" },
      },
      new Date("2026-10-20T08:00:00Z"),
    );
    const html = setupPanel(setupRows(kb, readKbFiles(kb), readSetupRecord(kb)));
    expect(html).toContain("HOMEOSTAT_GIT_TOKEN is stored · checked 20 Oct");
    expect(html).toContain("homeostat setup --step model");
  });

  test("the overview carries it, and this laptop's join state", () => {
    writeSetupRecord(kb, { join: { state: "done", reason: "ok" } }, now);
    const html = overview();
    expect(html).toContain('id="setup"');
    expect(html).toContain("This laptop: plugin installed, kb_dir set");
  });

  test("an unfinished setup leads the overview; a finished one follows the rest", () => {
    const first = overview();
    expect(first.indexOf('id="setup"')).toBeLessThan(first.indexOf('id="kb"'));
    const rows = setupRows(kb, readKbFiles(kb), {}).map((r) => ({ ...r, state: "done" as const }));
    const required = rows.filter((r) => r.required).length;
    expect(setupPanel(rows)).toContain(`${required}/${required} required`);
    expect(setupPanel(rows)).toContain('aria-valuenow="' + required + '"');
  });

  test("a shared build shows only what the files show, and says so", () => {
    writeSetupRecord(kb, { token: { state: "done", reason: "SECRET-NAME-ONLY stored" } }, now);
    const out = join(mkdtempSync(join(tmpdir(), "homeostat-setup-panel-out-")), "site");
    buildDashboard({ kbRoot: kb, out, now });
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('id="setup"');
    expect(html).toContain("this shared view leaves them out");
    expect(html).not.toContain("SECRET-NAME-ONLY");
    expect(html).not.toContain("not checked yet");
    expect(html).not.toContain("This laptop");
  });
});
