import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectRepo, remoteRepo, repoFor } from "../src/repo-detect.ts";

describe("remoteRepo", () => {
  test.each([
    ["git@github.com:acme/API.git", "acme/api"],
    ["https://github.com/acme/api", "acme/api"],
    ["https://x-token-auth:secret@bitbucket.org/acme/api.git", "acme/api"],
    ["ssh://git@bitbucket.org/acme/api.git/", "acme/api"],
    ["not a url", undefined],
  ])("%s", (url, repo) => {
    expect(remoteRepo(url)).toBe(repo);
  });
});

describe("repoFor", () => {
  const config = {
    repos: {
      api: { source: "acme/api", areas: {} },
      worker: { source: "Acme/Background-Worker", areas: {} },
    },
  };
  test("the remote decides, in any case or form; else the folder's name; else none", () => {
    expect(repoFor(config, { remote: "git@github.com:acme/background-worker.git" })).toBe("worker");
    expect(repoFor(config, { remote: "git@github.com:someone/fork.git", folder: "api" })).toBe(
      "api",
    );
    expect(repoFor(config, { folder: "api-hotfix" })).toBeUndefined();
    expect(repoFor({}, { remote: "git@github.com:acme/api.git" })).toBeUndefined();
  });

  test("detectRepo reads a real checkout's origin, from any folder inside it", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "homeostat-detect-")), "renamed-clone");
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/api.git"]);
    expect(detectRepo(join(dir, "src"), config)).toBe("api");
  });
});
