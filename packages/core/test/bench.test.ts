import { describe, expect, test } from "vitest";
import {
  bootstrapDiff,
  isLimitError,
  median,
  parseBenchResults,
  parseBenchTasks,
  parseClaudeRun,
  questionVerdictSchema,
  readVerdict,
} from "../src/bench.ts";

describe("bench task file", () => {
  test("fills defaults", () => {
    const { tasks, issues } = parseBenchTasks(`version: 1
model: claude-sonnet-5-5
repo: ../app
coding:
  - id: fix-a
    base: abc1234
    prompt: Fix a
    grade:
      tests: { files: { "t/test_a.py": "fixtures/fix-a/test_a.py" }, cmd: "pytest t" }
`);
    expect(issues).toEqual([]);
    expect(tasks?.questions).toEqual([]);
    expect(tasks?.coding[0]?.max_feedback).toBe(3);
    expect(tasks?.coding[0]?.grade.tests?.timeout).toBe(300);
  });

  test("rejects an empty file, unknown keys, a wrong version and a prompt that reads as a flag", () => {
    expect(parseBenchTasks("version: 1\nmodel: m\nrepo: r\n").issues[0]?.message).toContain(
      "at least one question or coding task",
    );
    const bad = parseBenchTasks(`version: 2
model: m
repo: r
extra: 1
questions:
  - { id: q, prompt: "--help", reference: r }
`).issues.map((i) => i.message);
    expect(bad.join("\n")).toMatch(/version/);
    expect(bad.join("\n")).toMatch(/extra/);
    expect(bad.join("\n")).toContain("must not start with '-'");
    expect(parseBenchTasks("a: [").issues[0]?.message).toContain("not valid YAML");
  });
});

describe("claude output", () => {
  test("reads cost, time, turns, tokens and the session", () => {
    const run = parseClaudeRun(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "hi",
        session_id: "s",
        total_cost_usd: 0.25,
        duration_ms: 1200,
        num_turns: 2,
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    );
    expect(run).toMatchObject({
      isError: false,
      costUsd: 0.25,
      durationMs: 1200,
      turns: 2,
      sessionId: "s",
      tokens: { input: 5, output: 6, cacheRead: 0, cacheCreation: 0 },
    });
    expect(parseClaudeRun("not json")).toBeNull();
  });

  test("a limit is read from failures, not from answers about rate limits", () => {
    const answer = parseClaudeRun(
      JSON.stringify({ subtype: "success", result: "We hit a rate limit in prod, so we retry." }),
    );
    expect(answer?.isError).toBe(false);
    const limited = parseClaudeRun(
      JSON.stringify({ subtype: "success", is_error: true, result: "You've hit your limit" }),
    );
    expect(isLimitError(limited, "", "")).toBe(true);
    expect(isLimitError(null, "", "Error: 429 Too Many Requests")).toBe(true);
    expect(isLimitError(null, "", "ENOENT")).toBe(false);
  });

  test("a verdict comes from structured output or fenced JSON", () => {
    expect(readVerdict(questionVerdictSchema, { score: 2, reason: "r" }, "")).toEqual({
      score: 2,
      reason: "r",
    });
    expect(
      readVerdict(questionVerdictSchema, undefined, '```json\n{"score":0,"reason":"x"}\n```'),
    ).toEqual({ score: 0, reason: "x" });
    expect(readVerdict(questionVerdictSchema, { score: 3, reason: "r" }, "nope")).toBeNull();
  });
});

describe("bench statistics", () => {
  test("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  test("the bootstrap interval holds the mean difference and repeats exactly", () => {
    const pairs = [
      [0, 1],
      [0, 0],
      [1, 1],
      [0, 1],
      [0.5, 1],
    ] as const;
    const ci = bootstrapDiff(pairs);
    expect(ci).not.toBeNull();
    const [lo, hi] = ci as [number, number];
    expect(lo).toBeLessThanOrEqual(0.5);
    expect(hi).toBeGreaterThanOrEqual(0.5);
    expect(hi).toBeLessThanOrEqual(1);
    expect(bootstrapDiff(pairs)).toEqual(ci);
    expect(bootstrapDiff([[0, 1]])).toBeNull();
  });

  test("results lines that do not parse are skipped and counted", () => {
    const { records, skipped } = parseBenchResults('{"v":1}\nnot json\n\n');
    expect(records).toEqual([]);
    expect(skipped).toBe(2);
  });
});
