import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchRecord } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { agentArgs, pluginOffSettings } from "../src/bench.ts";
import { type Io, runCli, type SpawnOptions, type SpawnResult } from "../src/cli.ts";

const QUESTION = {
  id: "url-parse-last-at",
  prompt: "Why do we split the database URL at the last '@'?",
  reference: "Passwords are not URL-encoded and may contain '@', so split at the last one.",
  must_mention: ["not URL-encoded", "last @"],
};

/** A task folder with a task file, a hidden test fixture and an empty code repo folder. */
function setup(extra: { questions?: object[]; coding?: object[]; header?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "homeostat-bench-"));
  mkdirSync(join(root, "code"));
  mkdirSync(join(root, "kb/bench/fixtures/fix-sms"), { recursive: true });
  writeFileSync(join(root, "kb/bench/fixtures/fix-sms/test_sms.py"), "def test_ok(): pass\n");
  const tasks = {
    version: 1,
    model: "claude-sonnet-5-5",
    repo: "../../code",
    questions: extra.questions ?? [QUESTION],
    coding: extra.coding ?? [],
  };
  const file = join(root, "kb/bench/tasks.yaml");
  writeFileSync(file, `${extra.header ?? ""}${JSON.stringify(tasks, null, 2)}\n`);
  return { root, file, out: join(root, "kb/bench/results") };
}

interface Call {
  command: string;
  args: string[];
  opts: SpawnOptions;
}

const claudeJson = (o: {
  result?: string;
  cost?: number;
  session?: string;
  error?: string;
  structured?: unknown;
  turns?: number;
}) =>
  JSON.stringify({
    type: "result",
    subtype: o.error ?? "success",
    is_error: o.error !== undefined,
    result: o.result ?? "",
    session_id: o.session ?? "sess-1",
    total_cost_usd: o.cost ?? 0.1,
    duration_ms: 2000,
    num_turns: o.turns ?? 3,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    ...(o.structured !== undefined ? { structured_output: o.structured } : {}),
  });

const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" });

type Handler = (args: string[], opts: SpawnOptions) => SpawnResult;

/**
 * Fakes claude, git and sh. `agent` answers agent calls (first and --resume), `judge` the judge's,
 * `tests` the hidden test command; git makes worktree folders and prints `diff`.
 */
function fakeSpawn(o: {
  agent?: Handler;
  judge?: Handler;
  tests?: Handler;
  diff?: string;
  plugins?: object[];
}) {
  const calls: Call[] = [];
  const spawn = async (command: string, args: string[], opts: SpawnOptions = {}) => {
    calls.push({ command, args, opts });
    if (command === "git") {
      const i = args.indexOf("worktree");
      if (i >= 0 && args[i + 1] === "add") mkdirSync(args[i + 3] as string, { recursive: true });
      if (args[0] === "diff") return ok(o.diff ?? "");
      return ok("");
    }
    if (command === "sh") return o.tests?.(args, opts) ?? ok("1 passed");
    if (command === "claude") {
      if (args[0] === "plugin")
        return ok(
          JSON.stringify(
            o.plugins ?? [{ id: "homeostat@homeostat", enabled: true, scope: "user" }],
          ),
        );
      if (args.includes("--system-prompt"))
        return (o.judge ?? (() => ok(claudeJson({ structured: { score: 2, reason: "right" } }))))(
          args,
          opts,
        );
      return (o.agent ?? (() => ok(claudeJson({ result: "Because passwords are not encoded." }))))(
        args,
        opts,
      );
    }
    return { code: 127, stdout: "", stderr: "not found" };
  };
  return { calls, spawn };
}

async function bench(args: string[], spawn?: Io["spawn"]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", "bench", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    ...(spawn ? { spawn } : {}),
    now: () => new Date("2026-10-20T10:00:00Z"),
  });
  return { code, stdout, stderr };
}

const records = (out: string, condition: string): BenchRecord[] =>
  readFileSync(join(out, `${condition}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const agentCalls = (calls: Call[]) =>
  calls.filter(
    (c) => c.command === "claude" && c.args[0] === "-p" && !c.args.includes("--system-prompt"),
  );
const judgeCalls = (calls: Call[]) => calls.filter((c) => c.args.includes("--system-prompt"));

describe("bench run: the plugin switch", () => {
  test("before turns the plugin off for each call; after leaves the user's setup alone", async () => {
    const before = setup();
    const b = fakeSpawn({});
    expect(
      (
        await bench(
          [
            "run",
            "--tasks",
            before.file,
            "--condition",
            "before",
            "--budget",
            "5",
            "--repeats",
            "1",
          ],
          b.spawn,
        )
      ).code,
    ).toBe(0);
    const after = setup();
    const a = fakeSpawn({});
    expect(
      (
        await bench(
          ["run", "--tasks", after.file, "--condition", "after", "--budget", "5", "--repeats", "1"],
          a.spawn,
        )
      ).code,
    ).toBe(0);

    const [bAgent] = agentCalls(b.calls);
    const [aAgent] = agentCalls(a.calls);
    expect(bAgent?.args).toEqual([
      "-p",
      QUESTION.prompt,
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5-5",
      "--allowedTools",
      "mcp__plugin_homeostat_homeostat",
      "--max-budget-usd",
      "5.00",
      "--settings",
      '{"enabledPlugins":{"homeostat@homeostat":false}}',
    ]);
    expect(bAgent?.opts.env).toEqual({ HOMEOSTAT_AGENT: "1" });
    // After: the same call without the switch.
    expect(aAgent?.args).toEqual(bAgent?.args.slice(0, -2));
    expect(aAgent?.opts.env).toBeUndefined();
    expect(aAgent?.args).not.toContain("--settings");
    // Both run in the code repo.
    expect(bAgent?.opts.cwd).toBe(join(before.root, "code"));

    // The judge: plugin always off, its own model, no tools, no settings files, no MCP.
    for (const calls of [a.calls, b.calls]) {
      const [j] = judgeCalls(calls);
      expect(j?.args).toEqual(
        expect.arrayContaining([
          "--model",
          "claude-opus-5-5",
          "--strict-mcp-config",
          "--setting-sources",
          "",
          "--no-session-persistence",
          "--settings",
          pluginOffSettings("homeostat@homeostat"),
        ]),
      );
      expect(j?.opts.env).toEqual({ HOMEOSTAT_AGENT: "1" });
      expect(j?.opts.input).toContain("<reference>");
    }
  });

  test("uses the installed plugin id, and refuses after when the plugin is disabled", async () => {
    const t = setup();
    const f = fakeSpawn({ plugins: [{ id: "homeostat@team-market", enabled: true }] });
    await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "5", "--repeats", "1"],
      f.spawn,
    );
    expect(agentCalls(f.calls)[0]?.args).toContain(pluginOffSettings("homeostat@team-market"));

    const off = fakeSpawn({ plugins: [{ id: "homeostat@homeostat", enabled: false }] });
    const r = await bench(
      ["run", "--tasks", setup().file, "--condition", "after", "--budget", "5"],
      off.spawn,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("disabled");
    expect(agentCalls(off.calls)).toEqual([]);

    const none = fakeSpawn({ plugins: [{ id: "other@x", enabled: true }] });
    const n = await bench(
      ["run", "--tasks", setup().file, "--condition", "before", "--budget", "5"],
      none.spawn,
    );
    expect(n.code).toBe(1);
    expect(n.stderr).toContain("not installed");
  });

  test("agentArgs puts the prompt right after -p so variadic flags cannot swallow it", () => {
    const args = agentArgs({
      prompt: "fix it",
      model: "m",
      condition: "after",
      pluginId: "homeostat@homeostat",
      permissionMode: "acceptEdits",
      maxBudgetUsd: 1,
      resume: "s1",
    });
    expect(args.slice(0, 4)).toEqual(["-p", "fix it", "--resume", "s1"]);
    expect(args[args.indexOf("--allowedTools") + 2]).toBe("--permission-mode");
  });
});

describe("bench run: budget, limits and resume", () => {
  const two = { questions: [QUESTION, { ...QUESTION, id: "second-question" }] };

  test("stops before a call that would pass the budget, and says what is left", async () => {
    const t = setup(two);
    const f = fakeSpawn({
      agent: () => ok(claudeJson({ result: "an answer", cost: 1.2 })),
      judge: () => ok(claudeJson({ structured: { score: 1, reason: "partly" }, cost: 0.1 })),
    });
    const r = await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "1.5", "--repeats", "1"],
      f.spawn,
    );
    expect(r.code).toBe(0);
    // Default estimates (1 + 0.3) let the first start; its real cost (1.2 + 0.1) makes the next
    // one's estimate (1.8 + 0.15) too much for the 0.2 left.
    expect(agentCalls(f.calls)).toHaveLength(1);
    expect(records(t.out, "before")).toHaveLength(1);
    expect(r.stdout).toContain("1 run done, $1.30 spent of $1.50; 1 run left");
    expect(r.stderr).toContain("budget reached");
  });

  test("passes the remaining budget to each call as --max-budget-usd", async () => {
    const t = setup();
    const f = fakeSpawn({ agent: () => ok(claudeJson({ result: "x", cost: 0.5 })) });
    await bench(
      ["run", "--tasks", t.file, "--condition", "after", "--budget", "3", "--repeats", "1"],
      f.spawn,
    );
    const max = (c: Call | undefined) => c?.args[(c?.args.indexOf("--max-budget-usd") ?? 0) + 1];
    expect(max(agentCalls(f.calls)[0])).toBe("3.00");
    expect(max(judgeCalls(f.calls)[0])).toBe("2.50");
  });

  test("stops at the first rate or usage limit and keeps what finished", async () => {
    const t = setup(two);
    let n = 0;
    const f = fakeSpawn({
      agent: () =>
        ++n === 1
          ? ok(claudeJson({ result: "an answer" }))
          : {
              code: 1,
              stdout: claudeJson({
                error: "error_during_execution",
                result: "Claude AI usage limit reached|1761400000",
              }),
              stderr: "",
            },
    });
    const r = await bench(
      ["run", "--tasks", t.file, "--condition", "after", "--budget", "50", "--repeats", "2"],
      f.spawn,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rate or usage limit");
    expect(r.stderr).toContain("after the limit resets");
    expect(agentCalls(f.calls)).toHaveLength(2);
    expect(records(t.out, "after").map((x) => x.id)).toEqual(["url-parse-last-at"]);
  });

  test("a limit in stderr with no JSON also stops the run", async () => {
    const t = setup();
    const f = fakeSpawn({
      agent: () => ({ code: 1, stdout: "", stderr: "API Error: 429 Too Many Requests" }),
    });
    const r = await bench(
      ["run", "--tasks", t.file, "--condition", "after", "--budget", "5"],
      f.spawn,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rate or usage limit");
    expect(existsSync(join(t.out, "after.jsonl"))).toBe(false);
  });

  test("a rerun skips what is done and continues", async () => {
    const t = setup(two);
    const first = fakeSpawn({});
    await bench(
      [
        "run",
        "--tasks",
        t.file,
        "--condition",
        "before",
        "--budget",
        "50",
        "--only",
        "second-question",
        "--repeats",
        "1",
      ],
      first.spawn,
    );
    expect(records(t.out, "before").map((r) => `${r.id}#${r.repeat}`)).toEqual([
      "second-question#1",
    ]);

    const second = fakeSpawn({});
    const r = await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "50", "--repeats", "2"],
      second.spawn,
    );
    expect(r.stdout).toContain("3 runs to go (1 already in");
    expect(agentCalls(second.calls)).toHaveLength(3);
    expect(
      records(t.out, "before")
        .map((r) => `${r.id}#${r.repeat}`)
        .sort(),
    ).toEqual([
      "second-question#1",
      "second-question#2",
      "url-parse-last-at#1",
      "url-parse-last-at#2",
    ]);

    const third = fakeSpawn({});
    const done = await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "50", "--repeats", "2"],
      third.spawn,
    );
    expect(done.stdout).toContain("Nothing to run");
    expect(third.calls).toEqual([]);
  });

  test("transcripts go to a separate, git-ignored folder; results hold no answer text", async () => {
    const t = setup();
    await bench(
      ["run", "--tasks", t.file, "--condition", "after", "--budget", "5", "--repeats", "1"],
      fakeSpawn({}).spawn,
    );
    const line = readFileSync(join(t.out, "after.jsonl"), "utf8");
    expect(line).not.toContain("passwords");
    expect(line).not.toContain(QUESTION.prompt);
    const [r] = records(t.out, "after");
    expect(r).toMatchObject({
      id: "url-parse-last-at",
      kind: "question",
      score: 2,
      agentCostUsd: 0.1,
      judgeCostUsd: 0.1,
      costUsd: 0.2,
      turns: 3,
      durationMs: 2000,
      tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
    });
    expect(
      readFileSync(join(t.out, "after-transcripts/url-parse-last-at-r1.md"), "utf8"),
    ).toContain("Because passwords are not encoded.");
    expect(readFileSync(join(t.out, ".gitignore"), "utf8")).toContain("*-transcripts/");
  });

  test("--dry-run prints the plan and an estimate and calls nothing", async () => {
    const t = setup({
      coding: [
        {
          id: "fix-sms",
          base: "abc1234",
          prompt: "Validate the SMS model",
          grade: {
            tests: {
              files: { "tests/test_sms.py": "fixtures/fix-sms/test_sms.py" },
              cmd: "pytest",
            },
          },
        },
      ],
    });
    const f = fakeSpawn({});
    const r = await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "20", "--dry-run"],
      f.spawn,
    );
    expect(r.code).toBe(0);
    expect(f.calls).toEqual([]);
    expect(r.stdout).toContain("4 runs to go");
    expect(r.stdout).toContain("tests, up to 3 corrections");
    // 2 × (question 1 + judge 0.3) + 2 × coding 3 = 8.60; worst adds 2 × 3 × 1.5 feedback.
    expect(r.stdout).toContain("about $8.60, at most $17.60");
    expect(r.stdout).toContain("Nothing was sent");
  });
});

describe("bench run: coding tasks", () => {
  const CODING = {
    id: "fix-sms",
    base: "abc1234",
    prompt: "Validate the SMS model",
    grade: {
      tests: {
        files: { "tests/test_sms.py": "fixtures/fix-sms/test_sms.py" },
        cmd: "uv run pytest tests/test_sms.py -q",
        timeout: 60,
      },
    },
    max_feedback: 3,
  };

  test("feeds failed test output back with --resume, counting each round as a correction", async () => {
    const t = setup({ questions: [], coding: [CODING] });
    const seenTests: boolean[] = [];
    let round = 0;
    const f = fakeSpawn({
      diff: "diff --git a/sms.py b/sms.py\n+validated\n",
      agent: (args) =>
        ok(
          claudeJson({
            result: "done",
            session: args.includes("--resume") ? "sess-1" : "sess-1",
            cost: 0.4,
          }),
        ),
      tests: (_args, opts) => {
        seenTests.push(existsSync(join(opts.cwd as string, "tests/test_sms.py")));
        round++;
        return round < 3
          ? { code: 1, stdout: `${"x".repeat(5000)}FAILED test_sms round ${round}`, stderr: "" }
          : ok("1 passed");
      },
    });
    const r = await bench(
      ["run", "--tasks", t.file, "--condition", "after", "--budget", "20", "--repeats", "1"],
      f.spawn,
    );
    expect(r.code).toBe(0);
    const agents = agentCalls(f.calls);
    expect(agents).toHaveLength(3);
    const work = agents[0]?.opts.cwd as string;
    expect(work).toMatch(/homeostat-bench-.*\/work$/);
    expect(agents[0]?.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
    for (const fb of agents.slice(1)) {
      expect(fb.args.slice(2, 4)).toEqual(["--resume", "sess-1"]);
      expect(fb.opts.cwd).toBe(work);
      // The last 2,500 characters of output, not all of it.
      expect(fb.args[1]).toContain("FAILED test_sms round");
      expect(fb.args[1]?.length).toBeLessThan(2700);
    }
    // Every grade ran in a clean copy that had the hidden test file.
    expect(seenTests).toEqual([true, true, true]);
    const gradeDirs = f.calls.filter((c) => c.command === "sh").map((c) => c.opts.cwd);
    expect(new Set(gradeDirs).size).toBe(3);
    expect(gradeDirs).not.toContain(work);
    // The diff leaves out the hidden test path and is applied to the clean copy.
    const diff = f.calls.find((c) => c.command === "git" && c.args[0] === "diff");
    expect(diff?.args).toEqual(
      expect.arrayContaining(["--cached", "abc1234", ":(exclude)tests/test_sms.py"]),
    );
    const apply = f.calls.find((c) => c.command === "git" && c.args[0] === "apply");
    expect(apply?.opts.input).toContain("+validated");
    // Worktrees come from the base and are removed.
    const adds = f.calls.filter((c) => c.args.includes("add") && c.args.includes("--detach"));
    expect(adds.every((c) => c.args.at(-1) === "abc1234")).toBe(true);
    const removes = f.calls.filter((c) => c.args.includes("remove"));
    expect(removes).toHaveLength(adds.length);

    const [rec] = records(t.out, "after");
    expect(rec).toMatchObject({
      kind: "coding",
      grade: "tests",
      outcome: "solved",
      solved: true,
      repeatedMistake: true,
      corrections: 2,
      agentCostUsd: 1.2,
      turns: 9,
    });
  });

  test("stops correcting at max_feedback and records it unsolved", async () => {
    const t = setup({ questions: [], coding: [{ ...CODING, max_feedback: 1 }] });
    const f = fakeSpawn({ tests: () => ({ code: 1, stdout: "FAILED", stderr: "" }) });
    await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "20", "--repeats", "1"],
      f.spawn,
    );
    expect(agentCalls(f.calls)).toHaveLength(2);
    expect(records(t.out, "before")[0]).toMatchObject({
      outcome: "unsolved",
      solved: false,
      corrections: 1,
    });
  });

  test("a judge-graded task asks the judge about the diff", async () => {
    const t = setup({
      questions: [],
      coding: [
        {
          id: "url-parse",
          base: "def5678",
          prompt: "Parse the URL",
          grade: { judge: { mistake: "used urlsplit", fix: "split at the last @" } },
        },
      ],
    });
    const f = fakeSpawn({
      diff: "+ host = url.rsplit('@', 1)\n",
      judge: () =>
        ok(claudeJson({ structured: { outcome: "repeated-mistake", reason: "used urlsplit" } })),
    });
    await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "20", "--repeats", "1"],
      f.spawn,
    );
    const [j] = judgeCalls(f.calls);
    expect(j?.opts.input).toContain("rsplit");
    expect(j?.opts.input).toContain("<mistake>");
    expect(records(t.out, "before")[0]).toMatchObject({
      grade: "judge",
      outcome: "repeated-mistake",
      repeatedMistake: true,
      solved: false,
      corrections: 0,
    });
  });
});

describe("bench run: the judge", () => {
  test("an unusable reply is asked once more", async () => {
    const t = setup();
    let n = 0;
    const f = fakeSpawn({
      judge: () =>
        ++n === 1
          ? ok(claudeJson({ result: "I think it is mostly right." }))
          : ok(
              claudeJson({ result: '```json\n{"score": 1, "reason": "misses the encoding"}\n```' }),
            ),
    });
    await bench(
      ["run", "--tasks", t.file, "--condition", "after", "--budget", "5", "--repeats", "1"],
      f.spawn,
    );
    expect(judgeCalls(f.calls)).toHaveLength(2);
    const [r] = records(t.out, "after");
    expect(r?.score).toBe(1);
    expect(r?.judgeCostUsd).toBeCloseTo(0.2);
  });

  test("two unusable replies leave the run unscored, not retried again", async () => {
    const t = setup();
    const f = fakeSpawn({
      judge: () => ok(claudeJson({ structured: { score: 7, reason: "" } })),
    });
    await bench(
      ["run", "--tasks", t.file, "--condition", "after", "--budget", "5", "--repeats", "1"],
      f.spawn,
    );
    expect(judgeCalls(f.calls)).toHaveLength(2);
    expect(records(t.out, "after")[0]).toMatchObject({ score: null, error: "judge-unusable" });
  });
});

describe("bench run: the task file", () => {
  test("names every problem and runs nothing", async () => {
    const t = setup({
      questions: [QUESTION, { ...QUESTION, reference: "" }],
      coding: [
        { id: "a", base: "not-a-sha", prompt: "x", grade: {} },
        {
          id: "b",
          base: "abc1234",
          prompt: "x",
          grade: { judge: { mistake: "m", fix: "f" }, tests: { files: { a: "b" }, cmd: "c" } },
        },
      ],
    });
    const f = fakeSpawn({});
    const r = await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "5"],
      f.spawn,
    );
    expect(r.code).toBe(1);
    expect(f.calls).toEqual([]);
    expect(r.stderr).toContain("questions.1.reference");
    expect(r.stderr).toContain('duplicate id "url-parse-last-at"');
    expect(r.stderr).toContain("coding.0.base: must be a commit sha");
    expect(r.stderr).toContain("grade needs exactly one of tests or judge");
  });

  test("missing hidden test files, unknown --only ids and bad flags are refused", async () => {
    const t = setup({
      coding: [
        {
          id: "c",
          base: "abc1234",
          prompt: "x",
          grade: { tests: { files: { "t.py": "fixtures/none.py" }, cmd: "pytest" } },
        },
      ],
    });
    const f = fakeSpawn({});
    const missing = await bench(
      ["run", "--tasks", t.file, "--condition", "before", "--budget", "5"],
      f.spawn,
    );
    expect(missing.stderr).toContain("c: fixtures/none.py");
    const ok2 = setup();
    const only = await bench(
      ["run", "--tasks", ok2.file, "--condition", "before", "--budget", "5", "--only", "nope"],
      f.spawn,
    );
    expect(only.stderr).toContain('no task "nope"');
    const cond = await bench(
      ["run", "--tasks", ok2.file, "--condition", "during", "--budget", "5"],
      f.spawn,
    );
    expect(cond.stderr).toContain("--condition must be before or after");
    const budget = await bench(
      ["run", "--tasks", ok2.file, "--condition", "before", "--budget", "0"],
      f.spawn,
    );
    expect(budget.stderr).toContain("--budget must be a positive amount");
    const none = await bench(["run", "--tasks", ok2.file, "--condition", "before"], f.spawn);
    expect(none.code).not.toBe(0);
    expect(f.calls).toEqual([]);
  });
});

function rec(over: Partial<BenchRecord>): BenchRecord {
  return {
    v: 1,
    condition: "before",
    id: "q1",
    kind: "question",
    repeat: 1,
    at: "2026-10-18T09:00:00Z",
    model: "claude-sonnet-5-5",
    judgeModel: "claude-opus-5-5",
    score: 0,
    agentCostUsd: 1,
    judgeCostUsd: 0.1,
    costUsd: 1.1,
    durationMs: 10_000,
    turns: 4,
    tokens: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
    ...over,
  };
}

function results(before: BenchRecord[], after: BenchRecord[]) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-bench-results-"));
  const write = (name: string, rs: BenchRecord[]) =>
    writeFileSync(join(dir, `${name}.jsonl`), rs.map((r) => JSON.stringify(r)).join("\n"));
  write("before", before);
  write(
    "after",
    after.map((r) => ({ ...r, condition: "after" as const })),
  );
  return dir;
}

const BEFORE = [
  rec({ id: "secret-question-one", score: 0, repeat: 1 }),
  rec({ id: "secret-question-one", score: 2, repeat: 2 }),
  rec({ id: "secret-question-two", score: 0 }),
  rec({
    id: "secret-coding",
    kind: "coding",
    score: undefined,
    grade: "tests",
    outcome: "unsolved",
    solved: false,
    repeatedMistake: true,
    corrections: 3,
    agentCostUsd: 4,
  }),
];
const AFTER = [
  rec({ id: "secret-question-one", score: 2, repeat: 1, at: "2026-10-19T09:00:00Z" }),
  rec({ id: "secret-question-one", score: 2, repeat: 2 }),
  rec({ id: "secret-question-two", score: 1 }),
  rec({
    id: "secret-coding",
    kind: "coding",
    score: undefined,
    grade: "tests",
    outcome: "solved",
    solved: true,
    repeatedMistake: false,
    corrections: 0,
    agentCostUsd: 2,
  }),
];

describe("bench report", () => {
  test("prints each measure per condition with the change and the spread", async () => {
    const out = results(BEFORE, AFTER);
    const r = await bench(["report", "--out", out]);
    expect(r.code).toBe(0);
    const line = (label: string) => r.stdout.split("\n").find((l) => l.startsWith(label)) ?? "";
    // Questions right: before task means 0.5 and 0 → mean 25%; after 1 and 0 → 50%.
    expect(line("Questions: right")).toMatch(/25\.0%.*50\.0%.*\+25\.0pp/);
    // Spread: question one ranged 0–1 before (right or not), 0 after.
    expect(line("Questions: right")).toMatch(/100\.0%\/0\.0%/);
    expect(line("Coding: corrections per task")).toMatch(/3\.00.*0\.00.*-3\.00/);
    expect(line("Coding: solved")).toMatch(/0\.0%.*100\.0%/);
    // Cost per task, over task means: before 1, 1, 4; after 1, 1, 2.
    expect(line("Cost per task")).toMatch(/\$1\.000\s+\$2\.000\s+\$1\.000\s+\$1\.333\s+-\$0\.667/);
    expect(r.stdout).toContain(
      "4 runs before, 4 runs after; 2 questions, 1 coding task; repeats 2/2",
    );
    expect(r.stdout).toContain("2026-10-18 to 2026-10-19");
  });

  test("--json is aggregate-only: no ids, prompts, answers or repo names", async () => {
    const out = results(BEFORE, AFTER);
    const r = await bench(["report", "--out", out, "--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({
      schema: "homeostat-bench/1",
      models: ["claude-sonnet-5-5"],
      judgeModels: ["claude-opus-5-5"],
      repeats: { before: 2, after: 2 },
      dates: { first: "2026-10-18", last: "2026-10-19" },
      tasks: { questions: 2, coding: 1, codingTests: 1, codingJudge: 0 },
      runs: { before: 4, after: 4 },
    });
    const accuracy = json.measures.find((m: { name: string }) => m.name === "question_accuracy");
    expect(accuracy.before.mean).toBeCloseTo(0.25);
    expect(accuracy.after.mean).toBeCloseTo(0.5);
    expect(accuracy.delta).toBeCloseTo(0.25);
    expect(accuracy.ci95).toHaveLength(2);
    expect(r.stdout).not.toMatch(/secret|sess-|code\b|prompt|reference/i);

    const file = join(out, "public.json");
    const w = await bench(["report", "--out", out, "--json", file]);
    expect(w.stdout).toContain("wrote");
    expect(JSON.parse(readFileSync(file, "utf8")).schema).toBe("homeostat-bench/1");
  });

  test("finds results next to the task file, and says when there are none", async () => {
    const t = setup();
    const none = await bench(["report", "--tasks", t.file]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no results");
  });
});
