import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countTokens, type Frontmatter, formatEntry, readEvents } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const AREA = ["services/billing/**"];

/** A KB with a billing area whose rules are all scoped to the whole area, as the curator does. */
function kb(rules: { id: string; fm?: Partial<Frontmatter>; text?: string }[], extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-kb-"));
  writeFileSync(
    join(dir, "homeostat.yaml"),
    `version: 1
team:
  members:
    - { id: ana, handle: "@ana", role: senior, areas: [billing] }
areas:
  billing: [${AREA.map((g) => `"${g}"`).join(", ")}]
${extra}`,
  );
  for (const { id, fm, text } of rules) {
    const body = `## Rule\n${text ?? `Rule ${id}.`}\n\n## Why\nBecause ${id}.`;
    const front: Frontmatter = {
      id,
      title: `Title ${id}`,
      area: "billing",
      scope: AREA,
      status: "accepted",
      score: 3,
      owner: "ana",
      source: { type: "pr-feedback", author: "ana" },
      created: "2026-10-01",
      lastConfirmed: "2026-10-01",
      tokens: countTokens(body),
      ...fm,
    };
    const path = join(dir, "knowledge", "billing", `${id}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, formatEntry(front, body));
  }
  return dir;
}

function codeRepo(files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-code-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "ana@acme.test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Ana"]);
  for (const path of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "x = 1\n");
  }
  return dir;
}

async function hook(event: string, input: object, env: Record<string, string>) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env,
    stdin: async () => JSON.stringify(input),
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
  const code = await runCli(["node", "homeostat", "hook", event], io);
  return { code, stdout, stderr };
}
const out = (stdout: string) => JSON.parse(stdout).hookSpecificOutput;
/** The file hook with a given clock (a shell command's edits are those after the last one). */
async function runHook(kbDir: string, input: object, now: string) {
  let stdout = "";
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: () => {},
    color: false,
    env: { HOMEOSTAT_DIR: kbDir },
    stdin: async () => JSON.stringify(input),
    now: () => new Date(now),
  };
  await runCli(["node", "homeostat", "hook", "file"], io);
  return { stdout };
}
const learnedAt = (path: string) => ({
  source: { type: "pr-feedback" as const, author: "ana", path },
});

describe("homeostat hook file: where rules were learned", () => {
  test("a file's own rules come first, the rest of them by title; the area's only after", async () => {
    const here = "services/billing/invoices/totals.py";
    // More rules learned on this file than fit: the first in full, the others listed by title.
    const own = Array.from({ length: 12 }, (_, i) => ({
      id: `learned-here-${i}`,
      fm: learnedAt(here),
      text: `Rule ${i}: ${"keep invoice totals exact and documented ".repeat(4)}`,
    }));
    const kbDir = kb([{ id: "area-only", fm: { score: 9 } }, ...own]);
    const cwd = codeRepo([here]);
    const { stdout } = await hook(
      "file",
      { session_id: "o1", cwd, tool_name: "Read", tool_input: { file_path: join(cwd, here) } },
      { HOMEOSTAT_DIR: kbDir },
    );
    const context = out(stdout).additionalContext;
    expect(context).toContain("## Title learned-here-0 (learned-here-0)");
    expect(context).toContain("Also learned on or near this file");
    expect(context).toMatch(/- Title learned-here-\d+ \(learned-here-\d+\)/);
    // The area-wide rule, scored highest, does not crowd out the file's own.
    expect(context).not.toContain("(area-only)");
  });
});

describe("homeostat hook file: rules triggered by the code written", () => {
  test("an edit containing a trigger brings the rule once, wherever the file is", async () => {
    const kbDir = kb([
      {
        id: "use-strenum",
        fm: { scope: ["**"], triggers: ["Literal["] },
        text: "Use StrEnum, not Literal, for closed sets of kinds.",
      },
    ]);
    const cwd = codeRepo(["services/shipping/kinds.py"]);
    const env = { HOMEOSTAT_DIR: kbDir };
    const edit = (session: string, new_string: string) =>
      hook(
        "file",
        {
          session_id: session,
          cwd,
          tool_name: "Edit",
          tool_input: { file_path: join(cwd, "services/shipping/kinds.py"), new_string },
        },
        env,
      );
    const first = await edit("c1", 'Kind = Literal["parcel", "pallet"]');
    expect(out(first.stdout).additionalContext).toContain(
      "# Team rules about the code you just wrote (homeostat)",
    );
    expect(out(first.stdout).additionalContext).toContain("(use-strenum)");
    // Again in the same session: already said.
    expect((await edit("c1", 'Size = Literal["s", "m"]')).stdout).toBe("");
    // Code without the trigger: nothing.
    expect((await edit("c2", "Kind = str")).stdout).toBe("");
    const sources = readEvents(kbDir, { since: "2026-01-01" })
      .filter((e) => e.type === "injection")
      .map((e) => e.source);
    expect(sources).toContain("code");
  });
});

describe("homeostat hook file: a located finding the agent must answer", () => {
  test("the best match points at the line, as feedback; near-duplicates on one line count once", async () => {
    // In a team trial an agent got this rule in full a second after writing urlsplit(raw), and
    // carried on: the script still parsed the URL the forbidden way.
    const rule = (id: string) => ({
      id,
      fm: { scope: ["**"], triggers: ["urlsplit("] },
      // It names DB_URL, which the code holds: a strong match, so a finding.
      text: "Parse `DB_URL` by its last @, not with urlsplit.",
    });
    const kbDir = kb([rule("parse-db-url-by-last-at"), rule("parse-db-url-by-last-at-2")]);
    const cwd = codeRepo(["tools/probe.py"]);
    // The fragment also sits in the docstring and a comment, which are not code.
    const content =
      '"""Usage: never urlsplit(DB_URL) here."""\nimport os\nfrom urllib.parse import urlsplit\n# urlsplit( is wrong\nparts = urlsplit(os.environ["DB_URL"])\n';
    writeFileSync(join(cwd, "tools/probe.py"), content);
    const { stdout } = await hook(
      "file",
      {
        session_id: "u1",
        cwd,
        tool_name: "Write",
        tool_input: { file_path: join(cwd, "tools/probe.py"), content },
      },
      { HOMEOSTAT_DIR: kbDir },
    );
    const reply = JSON.parse(stdout);
    expect(reply.decision).toBe("block");
    // The developer sees one line; the agent gets the finding in full as context.
    expect(reply.reason).toBe(
      "Homeostat: check probe.py:5 against team rule parse-db-url-by-last-at (details in context): fix it, or say in one line why it does not apply.",
    );
    const context = reply.hookSpecificOutput.additionalContext;
    // The call, not the import, the docstring or the comment: the trigger is "urlsplit(".
    expect(context).toContain('tools/probe.py:5: `parts = urlsplit(os.environ["DB_URL"])`');
    // One finding: the near-duplicate rule on the same line is only listed by title.
    expect(context.match(/^- tools\/probe\.py:/gm)).toHaveLength(1);
    expect(context).toContain("fix the code, or say in one line why the rule does not apply");
    // The agent fixes it; the next hook (any file) sees the fragment gone and counts it fixed.
    writeFileSync(
      join(cwd, "tools/probe.py"),
      "import os\nparts = parse_db_url(os.environ['DB_URL'])\n",
    );
    await hook(
      "file",
      {
        session_id: "u1",
        cwd,
        tool_name: "Read",
        tool_input: { file_path: join(cwd, "tools/probe.py") },
      },
      { HOMEOSTAT_DIR: kbDir },
    );
    const settled = readEvents(kbDir, { since: "2026-01-01" }).filter(
      (e) => e.type === "finding-settled",
    );
    expect(settled).toEqual([
      expect.objectContaining({ id: "parse-db-url-by-last-at", outcome: "fixed" }),
    ]);
  });

  test("a finding the agent answers in its reply, without a fix, counts as answered", async () => {
    // Agents often say why a rule does not apply; that was counted the same as ignoring it.
    const kbDir = kb([
      {
        id: "parse-db-url-by-last-at",
        fm: { scope: ["**"], triggers: ["urlsplit("] },
        text: "Parse `DB_URL` by its last @, not with urlsplit.",
      },
    ]);
    const cwd = codeRepo(["tools/probe.py"]);
    const content = "import os\nparts = urlsplit(os.environ['DB_URL'])\n";
    writeFileSync(join(cwd, "tools/probe.py"), content);
    const stop = (last_assistant_message: string) =>
      hook(
        "stop",
        { session_id: "a1", cwd, last_assistant_message, transcript_path: "/nonexistent" },
        { HOMEOSTAT_DIR: kbDir, HOMEOSTAT_NO_SYNC: "1" },
      );
    await stop("Starting on the probe.");
    const { stdout } = await hook(
      "file",
      {
        session_id: "a1",
        cwd,
        tool_name: "Write",
        tool_input: { file_path: join(cwd, "tools/probe.py"), content },
      },
      { HOMEOSTAT_DIR: kbDir },
    );
    expect(JSON.parse(stdout).decision).toBe("block");
    await stop("That rule is about prod scripts; this throwaway probe keeps urlsplit.");
    const settled = readEvents(kbDir, { since: "2026-01-01" }).filter(
      (e) => e.type === "finding-settled",
    );
    expect(settled).toEqual([
      expect.objectContaining({ id: "parse-db-url-by-last-at", outcome: "answered" }),
    ]);
  });
});

describe("homeostat hook file: many rules fire on one edit", () => {
  test("a match that names nothing else in the file is listed by title, never raised", async () => {
    const kbDir = kb(
      ["a", "b", "c", "d"].map((x) => ({
        id: `kinds-${x}`,
        fm: { scope: ["**"], triggers: ["Literal["] },
        text: `Rule ${x} about closed sets of kinds.`,
      })),
    );
    const cwd = codeRepo(["services/shipping/kinds.py"]);
    const { stdout } = await hook(
      "file",
      {
        session_id: "m1",
        cwd,
        tool_name: "Write",
        tool_input: {
          file_path: join(cwd, "services/shipping/kinds.py"),
          content: 'K = Literal["a"]',
        },
      },
      { HOMEOSTAT_DIR: kbDir },
    );
    const reply = JSON.parse(stdout);
    expect(reply.decision).toBeUndefined();
    const context = reply.hookSpecificOutput.additionalContext;
    expect(context).toContain("The code also matches these");
    expect(context.match(/^- Title kinds-[a-d] \(kinds-[a-d]\)$/gm)).toHaveLength(4);
  });
});

describe("homeostat hook file: shell commands (agents read and edit with Bash too)", () => {
  const setup = () => {
    const kbDir = kb([
      {
        id: "use-strenum",
        fm: { scope: ["**"], triggers: ["Literal["] },
        // Names `Kind`, which the edited code holds: a strong match.
        text: "Use StrEnum, not Literal, for closed sets like `Kind`.",
      },
      { id: "learned-here", fm: learnedAt("services/billing/totals.py") },
    ]);
    // A folder with a space, as many are.
    const parent = mkdtempSync(join(tmpdir(), "homeostat work-"));
    const cwd = join(parent, "my repo");
    mkdirSync(cwd);
    execFileSync("git", ["-C", cwd, "init", "-q"]);
    execFileSync("git", ["-C", cwd, "config", "user.email", "ana@acme.test"]);
    execFileSync("git", ["-C", cwd, "config", "user.name", "Ana"]);
    mkdirSync(join(cwd, "services/billing"), { recursive: true });
    writeFileSync(join(cwd, "services/billing/totals.py"), "x = 1\n");
    execFileSync("git", ["-C", cwd, "add", "."]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "init"]);
    return { kbDir, cwd, parent };
  };
  const bash = (kbDir: string, cwd: string, session: string, command: string, now: string) =>
    runHook(kbDir, { session_id: session, cwd, tool_name: "Bash", tool_input: { command } }, now);

  test("a file a command changed brings its rules and its code's triggered rules", async () => {
    const { kbDir, cwd, parent } = setup();
    // The edit happens (by a heredoc, sed, a script), then the hook runs after the command.
    writeFileSync(join(cwd, "services/billing/totals.py"), 'x = 1\nKind = Literal["a", "b"]\n');
    const { stdout } = await bash(
      kbDir,
      parent,
      "s1",
      `cd "${cwd}" && python3 - <<'EOF'\nopen("services/billing/totals.py","a").write("...")\nEOF`,
      new Date(Date.now() + 1000).toISOString(),
    );
    const reply = JSON.parse(stdout);
    const context = reply.hookSpecificOutput.additionalContext;
    expect(context).toContain("# Team rules about services/billing/totals.py (homeostat)");
    expect(context).toContain("(learned-here)");
    // The code's best match comes back as a located finding the agent must answer.
    expect(reply.decision).toBe("block");
    expect(reply.reason).toContain("check totals.py:2 against team rule use-strenum");
    expect(context).toContain('services/billing/totals.py:2: `Kind = Literal["a", "b"]`');
  });

  test("a file a command only names (cat, grep) brings nothing, and no-file commands are cheap", async () => {
    const { kbDir, cwd } = setup();
    const later = new Date(Date.now() + 60_000).toISOString();
    // The first command in a session counts as since a minute ago; the file was written before.
    await bash(kbDir, cwd, "s2", "git status", later);
    expect((await bash(kbDir, cwd, "s2", "cat services/billing/totals.py", later)).stdout).toBe("");
    expect((await bash(kbDir, cwd, "s2", "ls -la", later)).stdout).toBe("");
  });

  test("a reviewer's checkout writes nothing: a fresh but unchanged file brings no findings", async () => {
    // In a team trial the main reviewer's agent, which only reads PRs and comments, got 20
    // findings in an hour: every file a checkout touched was read whole as code it had written.
    const { kbDir, cwd } = setup();
    writeFileSync(join(cwd, "services/billing/totals.py"), 'Kind = Literal["a", "b"]\n');
    execFileSync("git", ["-C", cwd, "commit", "-qam", "the PR author's code"]);
    // Checked out again: a new modification time, the same content as the commit.
    writeFileSync(join(cwd, "services/billing/totals.py"), 'Kind = Literal["a", "b"]\n');
    const { stdout } = await bash(
      kbDir,
      cwd,
      "r1",
      "git diff main -- services/billing/totals.py",
      new Date(Date.now() + 1000).toISOString(),
    );
    expect(stdout).toBe("");
  });
});

describe("homeostat hook file: findings only in code", () => {
  test("a rule's pattern quoted in review notes is listed, never raised as a finding", async () => {
    const kbDir = kb([
      {
        id: "use-strenum",
        fm: { scope: ["**"], triggers: ["Literal["] },
        text: "Use StrEnum, not Literal, for closed sets of kinds.",
      },
    ]);
    const cwd = codeRepo(["notes/review.md"]);
    const content = 'The PR adds `Kind = Literal["a", "b"]`; suggest StrEnum.\n';
    writeFileSync(join(cwd, "notes/review.md"), content);
    const { stdout } = await hook(
      "file",
      {
        session_id: "n1",
        cwd,
        tool_name: "Write",
        tool_input: { file_path: join(cwd, "notes/review.md"), content },
      },
      { HOMEOSTAT_DIR: kbDir },
    );
    const reply = JSON.parse(stdout);
    expect(reply.decision).toBeUndefined();
    expect(reply.hookSpecificOutput.additionalContext).toContain("(use-strenum)");
  });
});

describe("homeostat hook commit (PreToolUse on Bash)", () => {
  const setup = (extra = "") => {
    const kbDir = kb(
      [
        {
          id: "use-strenum",
          fm: { scope: ["**"], triggers: ["Literal["] },
          // Names `Kind`, which the committed code holds: a strong match.
          text: "Use StrEnum, not Literal, for closed sets like `Kind`.",
        },
        { id: "learned-here", fm: learnedAt("services/billing/totals.py") },
      ],
      extra,
    );
    const cwd = codeRepo(["services/billing/totals.py"]);
    execFileSync("git", ["-C", cwd, "add", "."]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "init"]);
    writeFileSync(join(cwd, "services/billing/totals.py"), 'Kind = Literal["a", "b"]\n');
    execFileSync("git", ["-C", cwd, "add", "."]);
    return { kbDir, cwd };
  };
  const commit = (cwd: string, kbDir: string, command = 'git commit -m "Add kinds"') =>
    hook(
      "commit",
      { session_id: "k1", cwd, tool_name: "Bash", tool_input: { command } },
      { HOMEOSTAT_DIR: kbDir },
    );

  test("holds the first commit of a diff with its rules; the same diff then goes through", async () => {
    const { kbDir, cwd } = setup();
    const first = await commit(cwd, kbDir);
    const decision = out(first.stdout);
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toContain("(use-strenum)");
    expect(decision.permissionDecisionReason).toContain("Title learned-here (learned-here)");
    expect((await commit(cwd, kbDir)).stdout).toBe("");
    // The retry carried the same diff: logged as a commit that went through unchanged.
    const after = readEvents(kbDir, { since: "2026-01-01" }).filter(
      (e) => e.type === "commit-after-hold",
    );
    expect(after).toEqual([expect.objectContaining({ changed: false })]);
  });

  test("a held commit the agent changed before retrying is counted as changed", async () => {
    const { kbDir, cwd } = setup();
    expect(out((await commit(cwd, kbDir)).stdout).permissionDecision).toBe("deny");
    writeFileSync(join(cwd, "services/billing/totals.py"), "class Kind(StrEnum):\n    A = 'a'\n");
    execFileSync("git", ["-C", cwd, "add", "."]);
    await commit(cwd, kbDir);
    const after = readEvents(kbDir, { since: "2026-01-01" }).filter(
      (e) => e.type === "commit-after-hold",
    );
    expect(after).toEqual([expect.objectContaining({ changed: true })]);
  });

  test("an agent's real commit: cd into a worktree, stage and commit in one command", async () => {
    // In a team trial every agent commit looked like this, and none was ever checked: the hook
    // looked at the session's folder, and nothing was staged yet when it ran.
    const kbDir = kb([
      {
        id: "use-strenum",
        fm: { scope: ["**"], triggers: ["Literal["] },
        text: "Use StrEnum, not Literal, for closed sets like `Kind`.",
      },
    ]);
    const parent = mkdtempSync(join(tmpdir(), "homeostat work-"));
    const tree = join(parent, "my worktree");
    mkdirSync(join(tree, "services"), { recursive: true });
    execFileSync("git", ["-C", tree, "init", "-q"]);
    execFileSync("git", ["-C", tree, "config", "user.email", "ana@acme.test"]);
    execFileSync("git", ["-C", tree, "config", "user.name", "Ana"]);
    writeFileSync(join(tree, "services/app.py"), "x = 1\n");
    execFileSync("git", ["-C", tree, "add", "."]);
    execFileSync("git", ["-C", tree, "commit", "-qm", "init"]);
    // Not staged: a change to a tracked file, and a new file.
    writeFileSync(join(tree, "services/kinds.py"), 'Kind = Literal["a", "b"]\n');
    const command = `cd "${tree}" && git add -A services && git commit -q -F - <<'EOF'\nAdd kinds\nEOF`;
    const run = () =>
      hook(
        "commit",
        { session_id: "w1", cwd: parent, tool_name: "Bash", tool_input: { command } },
        { HOMEOSTAT_DIR: kbDir },
      );
    const first = out((await run()).stdout);
    expect(first.permissionDecision).toBe("deny");
    expect(first.permissionDecisionReason).toContain("(use-strenum)");
    expect((await run()).stdout).toBe("");
  });

  test("nothing specific, no hold: an area's rules alone do not stop a commit", async () => {
    // In a team trial, holds listing every rule near the changed files were waved through
    // 39 times in 41.
    const kbDir = kb([
      { id: "area-rule-a", fm: { score: 9 } },
      { id: "area-rule-b", fm: { score: 8 } },
      { id: "learned-nearby", fm: learnedAt("services/billing/other.py") },
      // A pattern match that names nothing else in the file: a title at most, not a hold.
      {
        id: "weak-match",
        fm: { scope: ["**"], triggers: ["Literal["] },
        text: "Use StrEnum, not Literal, for closed sets of kinds.",
      },
    ]);
    const cwd = codeRepo(["services/billing/totals.py"]);
    execFileSync("git", ["-C", cwd, "add", "."]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "init"]);
    writeFileSync(join(cwd, "services/billing/totals.py"), 'Kind = Literal["a", "b"]\n');
    execFileSync("git", ["-C", cwd, "add", "."]);
    expect((await commit(cwd, kbDir)).stdout).toBe("");
  });

  test("other commands, and a team that turned it off, are left alone", async () => {
    const { kbDir, cwd } = setup();
    expect((await commit(cwd, kbDir, "git status")).stdout).toBe("");
    expect((await commit(cwd, kbDir, 'echo "git commit later"')).stdout).toBe("");
    const off = setup("distribution:\n  commitCheck: false\n");
    expect((await commit(off.cwd, off.kbDir)).stdout).toBe("");
  });
});
