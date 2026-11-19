import { describe, expect, test } from "vitest";
import { type ReviewThread, THREAD_TOKENS, trimThread } from "../src/curator/threads.ts";

const comment = (id: number, body: string) => ({
  id,
  author: { id: "ana" },
  body,
  path: "a.py",
  line: 1,
  url: `u${id}`,
  createdAt: "2026-11-18T10:00:00Z",
});
const thread = (root: string, replies: string[] = []): ReviewThread =>
  ({
    repo: "acme/app",
    pullRequest: { id: 1, title: "t", author: { id: "lee" }, url: "p", mergedAt: "2026-11-18" },
    root: comment(1, root),
    replies: replies.map((b, i) => comment(10 + i, b)),
    changedCode: true,
  }) as unknown as ReviewThread;
const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const tokens = (s: string) => Math.ceil(s.length / 4);

describe("trimThread", () => {
  test("a thread within the budget is untouched", () => {
    const t = thread(words(200), [words(50)]);
    const out = trimThread(t);
    expect(out.trimmed).toBe(false);
    expect(out.thread).toBe(t);
  });

  test("a long opening comment is cut at a paragraph, with a marker, keeping most of the budget", () => {
    // An AI reviewer's comment: many paragraphs, thousands of tokens.
    const paras = Array.from({ length: 40 }, (_, i) => `Point ${i}. ${words(60, `p${i}w`)}`);
    const t = thread(paras.join("\n\n"), [words(100, "reply")]);
    const out = trimThread(t);
    expect(out.trimmed).toBe(true);
    expect(tokens(out.thread.root.body)).toBeLessThanOrEqual(THREAD_TOKENS);
    expect(out.thread.root.body).toContain("Point 0.");
    expect(out.thread.root.body).toMatch(
      /\n\n\[… \d+ more words cut: the thread is longer than a lesson needs\]$/,
    );
    // Cut between paragraphs, not mid-sentence.
    expect(out.thread.root.body.split("[… ")[0]?.trimEnd().endsWith("]")).toBe(false);
    expect(out.thread.root.body.split("\n\n[… ")[0]?.split("\n\n").at(-1)).toMatch(/^Point \d+\. /);
    // Replies keep a small share; a short reply survives whole.
    expect(out.thread.replies[0]?.body).toBe(words(100, "reply"));
    const total =
      tokens(out.thread.root.body) + out.thread.replies.reduce((n, r) => n + tokens(r.body), 0);
    expect(total).toBeLessThanOrEqual(THREAD_TOKENS + 40);
  });

  test("long replies share a fifth of the budget; a later one is cut to a marker", () => {
    const t = thread(words(100), [words(2000, "a"), words(2000, "b")]);
    const out = trimThread(t);
    expect(out.trimmed).toBe(true);
    expect(out.thread.root.body).toBe(words(100));
    expect(tokens(out.thread.replies[0]?.body ?? "")).toBeLessThanOrEqual(THREAD_TOKENS * 0.2 + 40);
    expect(out.thread.replies[1]?.body).toBe("[… reply cut]");
  });
});
