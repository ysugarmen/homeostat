import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkKb,
  cloneKb,
  cloneTarget,
  gitPath,
  readPrefs,
  setupPage,
  windowTitle,
  writePrefs,
} from "../src/kb.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `homeostat-desktop-${name}-`));

function starterCheckout() {
  const dir = tmp("kb");
  cpSync(starter, dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  return dir;
}

describe("checkKb", () => {
  test("a git checkout with a valid homeostat.yaml opens, named after its KB repo", () => {
    expect(checkKb(starterCheckout())).toMatchObject({
      ok: true,
      name: "acme/team-kb",
      base: "main",
    });
  });

  test("anything else says why", () => {
    expect(checkKb(tmp("empty"))).toMatchObject({ ok: false, error: /has no homeostat.yaml/ });
    const notGit = tmp("plain");
    cpSync(starter, notGit, { recursive: true });
    expect(checkKb(notGit)).toMatchObject({ ok: false, error: /not a git checkout/ });
    const broken = starterCheckout();
    writeFileSync(join(broken, "homeostat.yaml"), "version: [\n");
    expect(checkKb(broken)).toMatchObject({ ok: false, error: /is invalid/ });
  });
});

describe("cloning", () => {
  test("takes https, ssh and scp-style URLs and names the folder after the repo", () => {
    for (const url of [
      "https://bitbucket.org/acme/team-kb.git",
      "git@bitbucket.org:acme/team-kb.git",
      "ssh://git@github.com/acme/team-kb",
    ])
      expect(cloneTarget(url, "/x")).toEqual({ dir: "/x/team-kb" });
  });

  test("refuses anything git could read as an option, or a local path", () => {
    for (const url of ["--upload-pack=touch /tmp/pwned", "/etc", "file:///etc", "http://x/y", ""])
      expect(cloneTarget(url, "/x")).toHaveProperty("error");
  });

  test("never clones over an existing folder", () => {
    const parent = tmp("parent");
    mkdirSync(join(parent, "team-kb"));
    expect(cloneTarget("https://example.com/acme/team-kb.git", parent)).toEqual({
      error: `${join(parent, "team-kb")} already exists; open it instead`,
    });
  });

  test("a failed clone is reported, not thrown", async () => {
    const r = await cloneKb("https://127.0.0.1:9/acme/none.git", tmp("parent"));
    expect(r).toHaveProperty("error");
  });
});

describe("prefs, title and setup page", () => {
  test("prefs round-trip, and a missing or broken file is empty", () => {
    const file = join(tmp("prefs"), "sub", "prefs.json");
    expect(readPrefs(file)).toEqual({});
    writePrefs(file, { kbDir: "/kb", live: true });
    expect(readPrefs(file)).toEqual({ kbDir: "/kb", live: true });
    writeFileSync(file, "{");
    expect(readPrefs(file)).toEqual({});
  });

  test("the title says how current the view is", () => {
    const at = new Date(2026, 9, 18, 9, 5);
    const base = { changed: false, pulled: 0, behind: 0 };
    expect(windowTitle("acme/team-kb", base, at)).toBe("Homeostat · acme/team-kb · updated 09:05");
    expect(
      windowTitle("acme/team-kb", { ...base, behind: 2, reason: "it has local changes" }, at),
    ).toBe("Homeostat · acme/team-kb · 2 commits behind (it has local changes)");
    expect(windowTitle("acme/team-kb", { ...base, error: "x" }, at)).toContain("offline");
  });

  test("Finder-launched apps find Homebrew's git", () => {
    expect(gitPath({ PATH: "/usr/bin:/bin" })).toBe(
      "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
    );
  });

  test("the setup page escapes the error it shows and loads nothing external", () => {
    const page = setupPage('<img src=x onerror="alert(1)">');
    expect(page).not.toContain("<img");
    expect(page).toContain("default-src 'none'");
    expect(page).not.toMatch(/https?:\/\//);
  });
});
