import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitNet, networkEnv } from "../src/git.ts";

afterEach(() => {
  delete process.env.HOMEOSTAT_GIT_TIMEOUT_MS;
});

test("a fetch from a remote that never answers gives up at the time limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-net-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("config", "protocol.ext.allow", "always");
  // A transport that connects and then says nothing, like a dropped network.
  g("remote", "add", "origin", "ext::sh -c sleep% 30");
  process.env.HOMEOSTAT_GIT_TIMEOUT_MS = "1500";
  const started = Date.now();
  expect(gitNet(dir, "fetch", "--quiet", "origin")).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("ssh gets connect and keep-alive limits unless the developer set their own command", () => {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-net-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  expect(networkEnv(dir, {}).GIT_SSH_COMMAND).toContain("ConnectTimeout=20");
  expect(networkEnv(dir, { GIT_SSH_COMMAND: "ssh -i key" }).GIT_SSH_COMMAND).toBe("ssh -i key");
  expect(networkEnv(dir, {}).GIT_TERMINAL_PROMPT).toBe("0");
});
