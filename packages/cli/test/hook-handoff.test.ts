import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

function kb(minEdits = 2) {
  const dir = mkdtempSync(join(tmpdir(), "kbx-hkb-"));
  cpSync(join(examples, "starter-kb"), dir, { recursive: true });
  const config = join(dir, "kbx.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "agents:\n",
      `agents:\n  handoff: { enabled: true, minEdits: ${minEdits} }\n`,
    ),
  );
  return dir;
}

/** A code repo whose git user is the member "lee". */
function codeRepo(name = "Lee") {
  const dir = mkdtempSync(join(tmpdir(), "kbx-hcode-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.name", name]);
  return dir;
}

/** A transcript with `edits` file-changing tool uses and some reads. */
function transcript(edits: number) {
  const path = join(mkdtempSync(join(tmpdir(), "kbx-tr-")), "t.jsonl");
  const line = (name: string) =>
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", name, input: {} },
        ],
      },
    });
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "fix the queue" } }),
    line("Read"),
    line("Bash"),
    ...Array.from({ length: edits }, (_, i) =>
      line(["Edit", "Write", "MultiEdit"][i % 3] ?? "Edit"),
    ),
    "not json at all",
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

async function hook(event: string, input: object, kbDir: string) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: { KBX_DIR: kbDir },
    stdin: async () => JSON.stringify(input),
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
  const code = await runCli(["node", "kbx", "hook", event], io);
  return { code, stdout, stderr };
}

describe("kbx hook stop", () => {
  test("after enough edits it asks once for a handoff note, with the exact command", async () => {
    const kbDir = kb();
    const input = { session_id: "s1", cwd: codeRepo(), transcript_path: transcript(2) };
    const first = await hook("stop", input, kbDir);
    expect(first.code).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("No handoff note.");
    expect(out.reason).toContain(
      `learn --dir "${kbDir}" --source agent-handoff --branch candidates/lee --author lee`,
    );
    expect(out.reason).toContain("Areas: core, integrations, frontend");
    expect(out.reason).not.toContain("--push");

    const second = await hook("stop", input, kbDir);
    expect(second.stdout).toBe("");
  });

  test("adds --push when the KB checkout has an origin", async () => {
    const kbDir = kb();
    execFileSync("git", ["-C", kbDir, "init", "-q"]);
    execFileSync("git", ["-C", kbDir, "remote", "add", "origin", "git@example.com:acme/kb.git"]);
    const input = { session_id: "s1", cwd: codeRepo(), transcript_path: transcript(3) };
    expect(JSON.parse((await hook("stop", input, kbDir)).stdout).reason).toContain(
      "--branch candidates/lee --push",
    );
  });

  test("below the edit threshold it lets the session stop", async () => {
    const input = { session_id: "s2", cwd: codeRepo(), transcript_path: transcript(1) };
    expect((await hook("stop", input, kb())).stdout).toBe("");
  });

  test("after a compaction it asks even below the threshold", async () => {
    const kbDir = kb();
    const input = { session_id: "s3", cwd: codeRepo(), transcript_path: transcript(0) };
    expect((await hook("pre-compact", { ...input, trigger: "auto" }, kbDir)).stdout).toBe("");
    expect(JSON.parse((await hook("stop", input, kbDir)).stdout).decision).toBe("block");
  });

  test("sessions are tracked separately", async () => {
    const kbDir = kb();
    const cwd = codeRepo();
    await hook("stop", { session_id: "a", cwd, transcript_path: transcript(2) }, kbDir);
    const other = await hook(
      "stop",
      { session_id: "b", cwd, transcript_path: transcript(2) },
      kbDir,
    );
    expect(JSON.parse(other.stdout).decision).toBe("block");
  });

  test("a git user who is not a member is never asked", async () => {
    const input = {
      session_id: "s4",
      cwd: codeRepo("Somebody Else"),
      transcript_path: transcript(9),
    };
    const { code, stdout } = await hook("stop", input, kb());
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("disabled in kbx.yaml means never asked", async () => {
    const kbDir = kb();
    const config = join(kbDir, "kbx.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace("enabled: true, minEdits", "enabled: false, minEdits"),
    );
    const input = { session_id: "s5", cwd: codeRepo(), transcript_path: transcript(9) };
    expect((await hook("stop", input, kbDir)).stdout).toBe("");
  });

  test("a missing transcript is treated as no edits", async () => {
    const input = { session_id: "s6", cwd: codeRepo(), transcript_path: "/nope/t.jsonl" };
    const { code, stdout } = await hook("stop", input, kb());
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("asking is logged", async () => {
    const kbDir = kb();
    await hook(
      "stop",
      { session_id: "s7", cwd: codeRepo(), transcript_path: transcript(2) },
      kbDir,
    );
    const events = readFileSync(join(kbDir, ".kbx/events.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(events.at(-1) ?? "")).toMatchObject({
      type: "handoff-requested",
      session: "s7",
      member: "lee",
      edits: 2,
    });
  });
});
