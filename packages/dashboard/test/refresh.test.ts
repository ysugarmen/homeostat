import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { refreshCheckout } from "../src/refresh.ts";

const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    encoding: "utf8",
  }).trim();

/** An origin with main and a state branch, a teammate who pushes, and the app's checkout. */
function setup() {
  const origin = mkdtempSync(join(tmpdir(), "homeostat-refresh-origin-"));
  g(origin, "init", "-q", "--bare", "-b", "main");
  const mate = mkdtempSync(join(tmpdir(), "homeostat-refresh-mate-"));
  g(mate, "init", "-q", "-b", "main");
  writeFileSync(join(mate, "homeostat.yaml"), "version: 1\n");
  g(mate, "add", "-A");
  g(mate, "commit", "-qm", "kb");
  g(mate, "remote", "add", "origin", origin);
  g(mate, "push", "-q", "origin", "main");
  const app = mkdtempSync(join(tmpdir(), "homeostat-refresh-app-"));
  execFileSync("git", ["clone", "-q", origin, app]);
  const push = (file: string, branch = "main") => {
    if (branch !== "main") g(mate, "checkout", "-q", "-B", branch);
    writeFileSync(join(mate, file), `${file}\n`);
    g(mate, "add", "-A");
    g(mate, "commit", "-qm", file);
    g(mate, "push", "-q", "origin", branch);
    g(mate, "checkout", "-q", "main");
  };
  return { app, push };
}

describe("refreshCheckout", () => {
  test("nothing new: nothing changes", async () => {
    const { app } = setup();
    expect(await refreshCheckout(app, "main")).toEqual({ changed: false, pulled: 0, behind: 0 });
  });

  test("fast-forwards a clean checkout on the base branch", async () => {
    const { app, push } = setup();
    push("knowledge.md");
    expect(await refreshCheckout(app, "main")).toEqual({ changed: true, pulled: 1, behind: 0 });
    expect(g(app, "log", "-1", "--format=%s")).toBe("knowledge.md");
  });

  test("fetches the daily run's state branch and teammates' candidates", async () => {
    const { app, push } = setup();
    push("decisions.json", "homeostat/state");
    push("heartbeat.json", "candidates/lee");
    expect((await refreshCheckout(app, "main")).changed).toBe(true);
    expect(g(app, "show", "refs/remotes/origin/homeostat/state:decisions.json")).toBe(
      "decisions.json",
    );
    expect(g(app, "show", "refs/remotes/origin/candidates/lee:heartbeat.json")).toBe(
      "heartbeat.json",
    );
  });

  test("never touches local changes: it reports how far behind instead", async () => {
    const { app, push } = setup();
    push("knowledge.md");
    writeFileSync(join(app, "homeostat.yaml"), "version: 1\n# edited in settings\n");
    expect(await refreshCheckout(app, "main")).toEqual({
      changed: true,
      pulled: 0,
      behind: 1,
      reason: "it has local changes",
    });
    expect(g(app, "log", "-1", "--format=%s")).toBe("kb");
  });

  test("a checkout on another branch is left there", async () => {
    const { app, push } = setup();
    g(app, "checkout", "-q", "-b", "mine");
    push("knowledge.md");
    expect(await refreshCheckout(app, "main")).toMatchObject({ pulled: 0, behind: 1 });
    expect((await refreshCheckout(app, "main")).reason).toBe("it is not on main");
  });

  test("an unreachable origin is reported, not thrown", async () => {
    const { app } = setup();
    g(app, "remote", "set-url", "origin", join(tmpdir(), "no-such-origin"));
    const r = await refreshCheckout(app, "main");
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/could not fetch/);
  });
});
