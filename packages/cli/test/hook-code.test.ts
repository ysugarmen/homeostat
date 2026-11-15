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

describe("homeostat hook file: many rules fire on one edit", () => {
  test("the best two come in full, the others by title", async () => {
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
    const context = out(stdout).additionalContext;
    expect(context.match(/^## Title kinds-/gm)).toHaveLength(2);
    expect(context).toContain("The code also matches these");
    expect(context.match(/^- Title kinds-[a-d] \(kinds-[a-d]\)$/gm)).toHaveLength(2);
  });
});

describe("homeostat hook commit (PreToolUse on Bash)", () => {
  const setup = (extra = "") => {
    const kbDir = kb(
      [
        {
          id: "use-strenum",
          fm: { scope: ["**"], triggers: ["Literal["] },
          text: "Use StrEnum, not Literal, for closed sets of kinds.",
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
  });

  test("other commands, and a team that turned it off, are left alone", async () => {
    const { kbDir, cwd } = setup();
    expect((await commit(cwd, kbDir, "git status")).stdout).toBe("");
    expect((await commit(cwd, kbDir, 'echo "git commit later"')).stdout).toBe("");
    const off = setup("distribution:\n  commitCheck: false\n");
    expect((await commit(off.cwd, off.kbDir)).stdout).toBe("");
  });
});
