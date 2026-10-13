import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { touchedPaths } from "../src/touched.ts";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kbx-touched-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  const write = (path: string, text = "x") => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message);
  };
  git("init", "-q", "-b", "main");
  return { dir, git, write, commit };
}

test("uncommitted changes come first, then the branch, then recent history", () => {
  const { dir, git, write, commit } = repo();
  write("docs/readme.md");
  commit("init");
  git("checkout", "-qb", "feature");
  write("services/api/handler.ts");
  commit("feature work");
  write("apps/web/Button.tsx");
  write("services/api/handler.ts", "changed");

  const paths = touchedPaths(dir);
  expect(paths.slice(0, 2).sort()).toEqual(["apps/web/Button.tsx", "services/api/handler.ts"]);
  expect(paths).toContain("docs/readme.md");
  expect(new Set(paths).size).toBe(paths.length);
});

test("renames report the new path", () => {
  const { dir, git, write, commit } = repo();
  write("old/name.ts");
  commit("init");
  git("mv", "old", "new");
  expect(touchedPaths(dir)[0]).toBe("new/name.ts");
});

test("outside a git repo there is nothing to report", () => {
  expect(touchedPaths(mkdtempSync(join(tmpdir(), "kbx-nogit-")))).toEqual([]);
});
