import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countTokens, lessonHash, readEvents } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const LESSON = "knowledge/frontend/use-the-shared-button-component.md";

/** A team KB on a bare origin, and Lee's clone of it. */
function team() {
  const origin = mkdtempSync(join(tmpdir(), "homeostat-sync-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = mkdtempSync(join(tmpdir(), "homeostat-sync-seed-"));
  cpSync(starter, seed, { recursive: true });
  const g = (dir: string, ...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  g(seed, "init", "-q", "-b", "main");
  g(seed, "config", "user.name", "Dana");
  g(seed, "config", "user.email", "dana@example.com");
  g(seed, "add", "-A");
  g(seed, "commit", "-qm", "kb");
  g(seed, "remote", "add", "origin", origin);
  g(seed, "push", "-q", "origin", "main");
  const lee = mkdtempSync(join(tmpdir(), "homeostat-sync-lee-"));
  execFileSync("git", ["clone", "-q", origin, lee]);
  g(lee, "config", "user.name", "Lee");
  g(lee, "config", "user.email", "lee@example.com");
  return { origin, seed, lee, g };
}

async function run(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  const background: string[][] = [];
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-16T09:00:00Z"),
    background: (a) => background.push(a),
    ...extra,
  });
  return { code, stdout, background };
}

const learnButton = (dir: string) =>
  run([
    "learn",
    "--dir",
    dir,
    "--author",
    "lee",
    "--area",
    "frontend",
    "--title",
    "Use the shared button component",
    "--rule",
    "Render buttons with <Button> from apps/web/ui, never a raw button tag.",
    "--why",
    "Raw buttons skip the focus ring and the analytics hook.",
  ]);

/** Plays the daily run: writes Lee's decisions on the state branch. */
function decide(t: ReturnType<typeof team>, decision: "merged" | "declined", reason: string) {
  const text = readFileSync(join(t.lee, ".homeostat/pending", LESSON), "utf8");
  const record = {
    member: "lee",
    decided: [
      {
        path: LESSON,
        id: "use-the-shared-button-component",
        hash: lessonHash(text),
        decision,
        reason,
        at: "2026-10-16T05:00:00Z",
      },
    ],
  };
  const work = mkdtempSync(join(tmpdir(), "homeostat-sync-state-"));
  t.g(work, "init", "-q", "-b", "homeostat/state");
  mkdirSync(join(work, "decisions"));
  writeFileSync(join(work, "decisions/lee.json"), JSON.stringify(record));
  t.g(work, "-c", "user.name=bot", "-c", "user.email=bot@example.com", "add", "-A");
  t.g(
    work,
    "-c",
    "user.name=bot",
    "-c",
    "user.email=bot@example.com",
    "commit",
    "-qm",
    "decisions",
  );
  t.g(work, "push", "-q", "--force", t.origin, "homeostat/state");
  if (decision === "merged") {
    mkdirSync(dirname(join(t.seed, LESSON)), { recursive: true });
    writeFileSync(join(t.seed, LESSON), text.replace("status: candidate", "status: accepted"));
    t.g(t.seed, "add", "-A");
    t.g(t.seed, "commit", "-qm", "daily: merge lee's lesson");
    t.g(t.seed, "push", "-q", "origin", "main");
  }
}

async function session(kb: string, sessionId: string, event = "session-start") {
  const cwd = mkdtempSync(join(tmpdir(), "homeostat-sync-code-"));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Lee"]);
  mkdirSync(join(cwd, "apps/web/src"), { recursive: true });
  writeFileSync(join(cwd, "apps/web/src/App.tsx"), "x");
  const r = await run(["hook", event], {
    env: { HOMEOSTAT_DIR: kb },
    stdin: async () =>
      JSON.stringify({
        session_id: sessionId,
        cwd,
        ...(event === "session-start" ? { source: "startup" } : {}),
      }),
  });
  return {
    ...r,
    context: r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string) : "",
  };
}

describe("homeostat sync (automation, step 2)", () => {
  test("a new lesson is sent at once, in the background, and sync puts it on candidates/<member>", async () => {
    const t = team();
    const learned = await learnButton(t.lee);
    expect(learned.background).toEqual([["sync", "--dir", t.lee, "--quiet", "--push-only"]]);
    const synced = await run(["sync", "--dir", t.lee]);
    expect(synced.stdout).toContain("sent 1 pending lesson(s) to candidates/lee");
    const onOrigin = t.g(t.origin, "ls-tree", "-r", "--name-only", "candidates/lee");
    expect(onOrigin).toContain(LESSON);
    const heartbeat = JSON.parse(
      t.g(t.origin, "show", "candidates/lee:.homeostat-sync/heartbeat.json"),
    );
    expect(heartbeat).toMatchObject({ member: "lee", pending: 1, behind: 0 });
    // Usage counts are not shared unless the member opts in; the sync itself is timed.
    expect(heartbeat.usage).toBeUndefined();
    const syncs = readEvents(t.lee, { types: ["sync-run"] });
    expect(syncs.at(-1)).toMatchObject({ ok: true });
    expect(syncs.at(-1)?.ms).toBeGreaterThanOrEqual(0);
    // Nothing changed: a second sync pushes nothing, and says so.
    const again = (await run(["sync", "--dir", t.lee])).stdout;
    expect(again).not.toContain("sent");
    expect(again).toContain("up to date: 1 pending lesson(s) already on candidates/lee");
  });

  test("after the daily run merges a lesson, sync pulls it, clears it, and the next session says so", async () => {
    const t = team();
    await learnButton(t.lee);
    await run(["sync", "--dir", t.lee]);
    decide(t, "merged", "confidence 78");
    const synced = await run(["sync", "--dir", t.lee]);
    expect(synced.stdout).toContain("pulled 1 commit");
    // The pull moved the clone, so the heartbeat reports the new commit, though nothing is pending.
    const heartbeat = JSON.parse(
      t.g(t.origin, "show", "candidates/lee:.homeostat-sync/heartbeat.json"),
    );
    expect(heartbeat).toMatchObject({ kbCommit: t.g(t.lee, "rev-parse", "HEAD"), pending: 0 });
    expect(synced.stdout).toContain("use-the-shared-button-component: merged into the team KB");
    expect(existsSync(join(t.lee, ".homeostat/pending", LESSON))).toBe(false);
    expect(existsSync(join(t.lee, LESSON))).toBe(true);
    const s = await session(t.lee, "s1");
    expect(s.context).toContain("# Homeostat updates");
    expect(s.context).toContain("merged into the team KB");
    expect(s.context).toContain("use-the-shared-button-component");
    // Shown once.
    expect((await session(t.lee, "s2")).context).not.toContain("# Homeostat updates");
  });

  test("a declined lesson is cleared with its reason", async () => {
    const t = team();
    await learnButton(t.lee);
    await run(["sync", "--dir", t.lee]);
    decide(t, "declined", "duplicate of use-design-tokens-for-colors");
    const synced = await run(["sync", "--dir", t.lee]);
    expect(synced.stdout).toContain("declined (duplicate of use-design-tokens-for-colors)");
    expect(existsSync(join(t.lee, ".homeostat/pending", LESSON))).toBe(false);
  });

  test("a session that runs for days gets only the new rule on the next message, then nothing", async () => {
    const t = team();
    const start = await session(t.lee, "long");
    expect(start.context).not.toContain("use-the-shared-button-component");
    expect(start.background).toEqual([["sync", "--dir", t.lee, "--quiet"]]);
    // Meanwhile a teammate's lesson is merged and Lee's clone pulls it.
    const dana = mkdtempSync(join(tmpdir(), "homeostat-sync-dana-"));
    execFileSync("git", ["clone", "-q", t.origin, dana]);
    mkdirSync(dirname(join(dana, LESSON)), { recursive: true });
    const text = readFileSync(
      join(t.seed, "knowledge/frontend/use-design-tokens-for-colors.md"),
      "utf8",
    )
      .replace(/id: .*/, "id: use-the-shared-button-component")
      .replace("status: candidate", "status: accepted")
      .replace(/title: .*/, "title: Use the shared button component");
    writeFileSync(join(dana, LESSON), text);
    t.g(dana, "-c", "user.name=Dana", "-c", "user.email=d@example.com", "add", "-A");
    t.g(dana, "-c", "user.name=Dana", "-c", "user.email=d@example.com", "commit", "-qm", "rule");
    t.g(dana, "push", "-q", "origin", "main");
    await run(["sync", "--dir", t.lee]);
    const next = await session(t.lee, "long", "prompt");
    expect(next.context).toContain("# Team knowledge updated (homeostat)");
    expect(next.context).toContain("use-the-shared-button-component");
    expect(next.context).not.toContain("redact-before-logging"); // already given at start
    // Later messages get only the one-line reminder, never the rules again.
    const quiet = await session(t.lee, "long", "prompt");
    expect(quiet.context).not.toContain("Team knowledge updated");
    expect(quiet.context).toContain("From Homeostat");
    expect(countTokens(quiet.context)).toBeLessThan(80);
    // The start was timed; the prompt-time update is not a session start, so it carries no time.
    const injections = readEvents(t.lee, { types: ["injection"] });
    expect(injections.find((e) => e.source === "startup")?.ms).toBeGreaterThanOrEqual(0);
    const update = injections.find((e) => e.source === "update");
    expect(update).toBeDefined();
    expect(update?.ms).toBeUndefined();
  });

  test("a member who opts in shares seven days of counts in the heartbeat, and nothing named", async () => {
    const t = team();
    await learnButton(t.lee);
    await session(t.lee, "u1");
    await run(["sync", "--dir", t.lee], { env: { HOMEOSTAT_SHARE_USAGE: "1" } });
    const heartbeat = JSON.parse(
      t.g(t.origin, "show", "candidates/lee:.homeostat-sync/heartbeat.json"),
    );
    expect(Object.keys(heartbeat.usage)).toHaveLength(7);
    const today = Object.values(heartbeat.usage).at(-1) as Record<string, number>;
    expect(today.sessions).toBe(1);
    expect(today.injections).toBeGreaterThanOrEqual(1);
    expect(Object.keys(today).sort()).toEqual([
      "docReads",
      "injections",
      "mcpCalls",
      "rules",
      "sessions",
    ]);
    expect(JSON.stringify(heartbeat.usage)).not.toContain("u1");
    // The same through the config, so the choice is visible in the KB.
    const t2 = team();
    const config = join(t2.lee, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace("    - id: lee\n", "    - id: lee\n      usage: true\n"),
    );
    await learnButton(t2.lee);
    await run(["sync", "--dir", t2.lee]);
    expect(
      JSON.parse(t2.g(t2.origin, "show", "candidates/lee:.homeostat-sync/heartbeat.json")).usage,
    ).toBeDefined();
  });

  test("a sync whose origin is gone is logged as failed at the fetch", async () => {
    const t = team();
    await run(["sync", "--dir", t.lee]);
    rmSync(t.origin, { recursive: true, force: true });
    await run(["sync", "--dir", t.lee]);
    expect(readEvents(t.lee, { types: ["sync-run"] }).at(-1)).toMatchObject({
      ok: false,
      step: "fetch",
    });
  });

  test("HOMEOSTAT_NO_SYNC=1 starts no background sync", async () => {
    const t = team();
    const r = await run(
      [
        "learn",
        "--dir",
        t.lee,
        "--author",
        "lee",
        "--area",
        "frontend",
        "--title",
        "Use the shared button component",
        "--rule",
        "Render buttons with <Button> from apps/web/ui, never a raw button tag.",
        "--why",
        "Raw buttons skip the focus ring and the analytics hook.",
      ],
      { env: { HOMEOSTAT_NO_SYNC: "1" } },
    );
    expect(r.code).toBe(0);
    expect(r.background).toEqual([]);
  });

  test("local edits to tracked files block the pull safely, with a notice", async () => {
    const t = team();
    writeFileSync(
      join(t.seed, "knowledge/core/new.md"),
      readFileSync(join(t.seed, "knowledge/core/redact-before-logging.md"), "utf8").replace(
        "id: redact-before-logging",
        "id: new",
      ),
    );
    t.g(t.seed, "add", "-A");
    t.g(t.seed, "commit", "-qm", "new");
    t.g(t.seed, "push", "-q", "origin", "main");
    writeFileSync(
      join(t.lee, "homeostat.yaml"),
      `${readFileSync(join(t.lee, "homeostat.yaml"), "utf8")}\n# local edit\n`,
    );
    const synced = await run(["sync", "--dir", t.lee]);
    expect(synced.stdout).toContain(
      "your KB clone is 1 commit behind: tracked files have local changes",
    );
    expect(existsSync(join(t.lee, "knowledge/core/new.md"))).toBe(false);
  });
});
