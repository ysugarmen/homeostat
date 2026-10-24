import { describe, expect, test } from "vitest";
import type { Asker } from "../src/claude.ts";
import { confidence } from "../src/confidence.ts";
import { judgeModelFor, parseConfig } from "../src/config.ts";
import {
  ClaudeDraftJudge,
  DRAFT_JUDGE_SYSTEM,
  type DraftJudge,
  draftJudgePrompt,
  type JudgeInput,
  type JudgeVerdict,
  judgeDraft,
  parseJudgeVerdict,
} from "../src/curator/judge.ts";
import type { ReviewThread } from "../src/curator/threads.ts";
import { formatEntry, parseEntry } from "../src/entry.ts";

const thread: ReviewThread = {
  repo: "acme/web-app",
  pullRequest: {
    id: 120,
    title: "Booking widget styles",
    url: "https://github.com/acme/web-app/pull/120",
    author: { id: "lee" },
    mergedAt: "2026-10-15T10:00:00Z",
    sourceBranch: "f",
    targetBranch: "main",
  },
  root: {
    id: 9001,
    body: "Use var(--color-primary) instead of the hex value; it breaks dark mode.",
    author: { id: "sam" },
    createdAt: "2026-10-15T08:00:00Z",
    url: "https://github.com/acme/web-app/pull/120#discussion_r9001",
    path: "apps/web/src/Button.css",
    line: 4,
  },
  replies: [],
  changedCode: true,
};

const input: JudgeInput = {
  thread,
  draft: {
    title: "Use colour tokens instead of hex values",
    rule: "Reference colours through var(--color-*) tokens, never hex values.",
    why: "Hex values do not change with the theme, which broke dark mode.",
    scope: ["apps/web/**"],
  },
};

const OK: JudgeVerdict = { ok: true, problems: [] };
const INVENTED: JudgeVerdict = {
  ok: false,
  problems: [{ trap: "invented-detail", evidence: '"#1a73e8" is not in the thread' }],
};
const CONTRADICTS: JudgeVerdict = {
  ok: false,
  problems: [{ trap: "contradicts-thread", evidence: "the thread asked for tokens" }],
};

/** Answers in turn; the last answer repeats. */
const judgeOf = (...answers: (JudgeVerdict | null | Error)[]) => {
  let calls = 0;
  const judge: DraftJudge = {
    judge: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  };
  return { judge, calls: () => calls };
};

describe("parseJudgeVerdict", () => {
  test("a clean pass and a failure with evidence parse as given", () => {
    expect(parseJudgeVerdict({ ok: true, problems: [] })).toEqual(OK);
    expect(parseJudgeVerdict(INVENTED)).toEqual(INVENTED);
  });

  test("an inconsistent answer fails the rule: ok with problems, or not ok without any", () => {
    expect(parseJudgeVerdict({ ok: true, problems: INVENTED.problems })).toEqual(INVENTED);
    expect(parseJudgeVerdict({ ok: false, problems: [] })).toEqual({
      ok: false,
      problems: [
        { trap: "invented-detail", evidence: "the judge failed the rule without evidence" },
      ],
    });
  });

  test("an unknown trap or a wrong shape is no answer", () => {
    expect(parseJudgeVerdict({ ok: false, problems: [{ trap: "style", evidence: "x" }] })).toBe(
      null,
    );
    expect(parseJudgeVerdict({ verdict: "fine" })).toBe(null);
    expect(parseJudgeVerdict("ok")).toBe(null);
  });
});

describe("judgeDraft: majority on the failing side", () => {
  test("a pass costs one call", async () => {
    const j = judgeOf(OK);
    const out = await judgeDraft(j.judge, input);
    expect(out).toMatchObject({ verdict: OK, calls: 1, contradicts: false });
    expect(j.calls()).toBe(1);
  });

  test("a failure is re-asked twice and kept when the majority agrees", async () => {
    const j = judgeOf(INVENTED, INVENTED, OK);
    const out = await judgeDraft(j.judge, input);
    expect(j.calls()).toBe(3);
    expect(out?.verdict).toEqual(INVENTED);
    expect(out?.tally).toBe("2/3 failed");
  });

  test("a failure that flips on re-asking is not kept", async () => {
    const out = await judgeDraft(judgeOf(INVENTED, OK, OK).judge, input);
    expect(out?.verdict).toEqual(OK);
    expect(out?.tally).toBe("1/3 failed");
  });

  test("re-asks that give no answer or throw do not count either way", async () => {
    const out = await judgeDraft(judgeOf(INVENTED, null, new Error("timeout")).judge, input);
    expect(out?.verdict.ok).toBe(false);
    expect(out?.tally).toBe("1/1 failed");
  });

  test("contradiction needs a majority naming it, not just the first answer", async () => {
    expect(
      (await judgeDraft(judgeOf(CONTRADICTS, INVENTED, INVENTED).judge, input))?.contradicts,
    ).toBe(false);
    const both = await judgeDraft(judgeOf(CONTRADICTS, CONTRADICTS, OK).judge, input);
    expect(both?.contradicts).toBe(true);
    expect(both?.verdict.problems.map((p) => p.trap)).toEqual(["contradicts-thread"]);
  });

  test("a trap a majority named is listed even when the first answer missed it", async () => {
    const out = await judgeDraft(judgeOf(INVENTED, CONTRADICTS, CONTRADICTS).judge, input);
    expect(out?.verdict.problems.map((p) => p.trap)).toEqual([
      "invented-detail",
      "contradicts-thread",
    ]);
  });

  test("no usable first answer is null: the caller cannot vouch for the draft", async () => {
    expect(await judgeDraft(judgeOf(null).judge, input)).toBe(null);
  });
});

describe("the judge's prompt", () => {
  test("names every trap and sends the thread, the draft and its scope", async () => {
    for (const trap of ["invented-detail", "wider-scope", "overgeneralised", "contradicts-thread"])
      expect(DRAFT_JUDGE_SYSTEM).toContain(trap);
    const seen: string[] = [];
    const ask: Asker = async (system, user) => {
      seen.push(system, user);
      return { ok: true, problems: [] } as never;
    };
    const out = await new ClaudeDraftJudge(ask).judge({
      ...input,
      updates: { title: "Old", rule: "Use tokens.", why: "Theme." },
    });
    expect(out).toEqual(OK);
    expect(seen[1]).toContain("Use var(--color-primary) instead of the hex value");
    expect(seen[1]).toContain("apps/web/src/Button.css:4");
    expect(seen[1]).toContain("Applies to: apps/web/**");
    expect(seen[1]).toContain("<existing-rule>");
    expect(draftJudgePrompt(input)).not.toContain("<existing-rule>");
  });
});

describe("the judge in the confidence decision", () => {
  const yaml = `version: 1
team:
  members:
    - { id: sam, role: senior, areas: [frontend] }
areas:
  frontend: ["apps/web/**"]
`;
  const config = () => {
    const c = parseConfig(yaml).config;
    if (!c) throw new Error("config");
    return c;
  };
  const entry = parseEntry(
    formatEntry(
      {
        id: "use-colour-tokens",
        title: "Use colour tokens instead of hex values",
        area: "frontend",
        scope: ["apps/web/**"],
        status: "accepted",
        score: 3,
        owner: "sam",
        source: { type: "pr-feedback", url: thread.root.url, author: "sam", changedCode: true },
        created: "2026-10-15",
        lastConfirmed: "2026-10-15",
        tokens: 30,
      },
      "## Rule\nReference colours through `var(--color-*)` tokens.\n\n## Why\nDark mode.",
    ),
  ).entry;
  if (!entry) throw new Error("entry");

  test("a kept failure costs the configured penalty and goes to a person", () => {
    const clean = confidence({ entry, config: config(), originator: "sam" });
    expect(clean.decision).toBe("merged");
    const judged = confidence({
      entry,
      config: config(),
      originator: "sam",
      judged: { problems: ["invented-detail: x"], contradicts: false },
    });
    expect(judged.score).toBe(clean.score - 30);
    expect(judged.decision).toBe("review");
    expect(judged.reason).toContain("invented-detail: x");
  });

  test("a rule that contradicts its own thread is declined", () => {
    const c = confidence({
      entry,
      config: config(),
      originator: "sam",
      judged: { problems: ["contradicts-thread: y"], contradicts: true },
    });
    expect(c.decision).toBe("declined");
  });

  test("the judge defaults to a different model from the drafter", () => {
    expect(judgeModelFor(config())).toBe("claude-sonnet-5-5");
    const sonnet = parseConfig(`${yaml}agents:\n  curator: { model: claude-sonnet-5-5 }\n`).config;
    expect(sonnet && judgeModelFor(sonnet)).toBe("claude-opus-5-5");
    const set = parseConfig(`${yaml}agents:\n  curator: { judgeModel: claude-haiku-4-5 }\n`).config;
    expect(set && judgeModelFor(set)).toBe("claude-haiku-4-5");
  });
});
