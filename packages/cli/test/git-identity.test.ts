import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git, gitIdentity } from "../src/git.ts";

describe("gitIdentity", () => {
  const saved = { ...process.env };
  const dirs: string[] = [];
  afterEach(() => {
    process.env = { ...saved };
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "homeostat-ident-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    return dir;
  };

  test("is who git signs commits as, even with no user.name in the config", () => {
    // A laptop that never set user.name: `git config user.name` is empty, but git still signs
    // commits, with a name and email it finds elsewhere (here, the environment).
    const dir = repo();
    process.env.GIT_CONFIG_GLOBAL = join(dir, "no-global-config");
    process.env.GIT_AUTHOR_NAME = "Ana Ruiz Soler";
    process.env.GIT_AUTHOR_EMAIL = "ana@laptop.local";
    expect(git(dir, "config", "user.name")).toBeUndefined();
    expect(gitIdentity(dir)).toEqual({ name: "Ana Ruiz Soler", email: "ana@laptop.local" });
  });

  test("is the config's name and email when they are set", () => {
    const dir = repo();
    process.env.GIT_CONFIG_GLOBAL = join(dir, "no-global-config");
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    execFileSync("git", ["-C", dir, "config", "user.name", "Lee Smith"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "lee@acme.io"]);
    expect(gitIdentity(dir)).toEqual({ name: "Lee Smith", email: "lee@acme.io" });
  });
});
