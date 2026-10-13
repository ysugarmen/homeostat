import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEntry } from "@kbx/core";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

/** The starter KB as a git repo with one commit on main. */
function kbRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kbx-branch-"));
  cpSync(join(examples, "starter-kb"), dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return { dir, git };
}

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "kbx", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-13T12:00:00Z"),
  });
  return { code, stdout, stderr };
}

const note = [
  "--source",
  "agent-handoff",
  "--title",
  "Queue consumers ack only after the write commits",
  "--rule",
  "Ack queue messages only after the database transaction commits.",
  "--why",
  "Acking first lost messages when the write failed; tried retries in the consumer, rejected as it duplicated work.",
  "--author",
  "lee",
];
const PATH = "knowledge/core/queue-consumers-ack-only-after-the-write-commits.md";

describe("kbx learn --source", () => {
  test("agent-handoff entries are candidates with the handoff base score", async () => {
    const { dir } = kbRepo();
    const { code, stdout } = await run("learn", "--dir", dir, ...note);
    expect(code).toBe(0);
    expect(stdout).toContain("(candidate, score 0)");
    const { entry } = parseEntry(readFileSync(join(dir, PATH), "utf8"));
    expect(entry?.frontmatter.source).toEqual({ type: "agent-handoff", author: "lee" });
  });

  test("pr-feedback cannot be chosen by hand; it needs a comment URL", async () => {
    const { dir } = kbRepo();
    const { code, stderr } = await run(
      "learn",
      "--dir",
      dir,
      ...note.slice(2),
      "--source",
      "pr-feedback",
    );
    expect(code).toBe(1);
    expect(stderr).toContain("--source must be manual or agent-handoff");
  });
});

describe("kbx learn --branch", () => {
  test("commits the entry to the branch without touching the working tree or index", async () => {
    const { dir, git } = kbRepo();
    const head = git("rev-parse", "HEAD");
    const { code, stdout } = await run(
      "learn",
      "--dir",
      dir,
      ...note,
      "--branch",
      "candidates/lee",
    );
    expect(code).toBe(0);
    expect(stdout).toContain(`committed ${PATH} to candidates/lee`);

    expect(existsSync(join(dir, PATH))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(head);

    expect(git("log", "-1", "--format=%s", "candidates/lee")).toBe(
      "kbx: candidate queue-consumers-ack-only-after-the-write-commits",
    );
    expect(git("rev-parse", "candidates/lee~1")).toBe(head);
    const committed = git("show", `candidates/lee:${PATH}`);
    expect(parseEntry(committed).issues).toEqual([]);
  });

  test("a second note stacks on the same branch", async () => {
    const { dir, git } = kbRepo();
    await run("learn", "--dir", dir, ...note, "--branch", "candidates/lee");
    await run("learn", "--dir", dir, ...note, "--id", "second", "--branch", "candidates/lee");
    expect(git("rev-list", "--count", "main..candidates/lee")).toBe("2");
    expect(git("ls-tree", "-r", "--name-only", "candidates/lee")).toContain(
      "knowledge/core/second.md",
    );
  });

  test("an id already on the branch is refused", async () => {
    const { dir } = kbRepo();
    await run("learn", "--dir", dir, ...note, "--branch", "candidates/lee");
    const again = await run("learn", "--dir", dir, ...note, "--branch", "candidates/lee");
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`${PATH} already exists on candidates/lee`);
  });

  test("--push without --branch is refused", async () => {
    const { dir } = kbRepo();
    const { code, stderr } = await run("learn", "--dir", dir, ...note, "--push");
    expect(code).toBe(1);
    expect(stderr).toContain("--push needs --branch");
  });

  test("--push pushes the branch to origin", async () => {
    const { dir, git } = kbRepo();
    const remote = mkdtempSync(join(tmpdir(), "kbx-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    const { code, stdout } = await run(
      "learn",
      "--dir",
      dir,
      ...note,
      "--branch",
      "candidates/lee",
      "--push",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("pushed candidates/lee to origin");
    expect(
      execFileSync("git", ["-C", remote, "branch", "--list", "candidates/lee"], {
        encoding: "utf8",
      }),
    ).toContain("candidates/lee");
  });
});
