import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { homeostatTool, readLinesFrom, summarizeTurns } from "../src/turn-usage.ts";

const at = (lines: string[]) => {
  let offset = 0;
  return lines.map((text) => {
    const l = { text, offset };
    offset += Buffer.byteLength(text) + 1;
    return l;
  });
};
const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({ type: "user", message: { content }, ...extra });
const assistant = (content: unknown[], extra: object = {}) =>
  JSON.stringify({ type: "assistant", message: { content }, ...extra });

describe("homeostatTool", () => {
  test("names the tool of any MCP server named after homeostat", () => {
    expect(homeostatTool("mcp__plugin_homeostat_homeostat__search")).toBe("search");
    expect(homeostatTool("mcp__homeostat__read")).toBe("read");
    expect(homeostatTool("mcp__claude_ai_Notion__search")).toBeUndefined();
    expect(homeostatTool("Bash")).toBeUndefined();
  });
});

describe("summarizeTurns", () => {
  test("a turn opens at a prompt; tool results, meta, sidechain and compaction lines do not", () => {
    const turns = summarizeTurns(
      at([
        assistant([{ type: "text", text: "> From Homeostat (before-any-turn)" }]),
        user("first"),
        assistant([{ type: "tool_use", name: "mcp__homeostat__context", input: {} }]),
        user([{ type: "tool_result", content: "x" }]),
        user("<command>", { isMeta: true }),
        user("summary", { isCompactSummary: true }),
        assistant([{ type: "tool_use", name: "mcp__homeostat__search" }], { isSidechain: true }),
        user([{ type: "text", text: "second" }, { type: "image" }]),
        assistant([{ type: "thinking", thinking: "> From Homeostat (not-a-reply)" }]),
        assistant([{ type: "text", text: "> From Homeostat (a-rule)" }]),
      ]),
    );
    expect(turns.map((t) => [t.turn, t.calls, t.retrieved, t.credits])).toEqual([
      [1, ["context"], true, []],
      [2, [], false, ["a-rule"]],
    ]);
  });

  test("numbers from firstTurn when reading from the middle of a file", () => {
    const turns = summarizeTurns(at([user("again"), user("next")]), 7);
    expect(turns.map((t) => t.turn)).toEqual([7, 8]);
  });

  test("learn and flag are calls, not retrieval", () => {
    const [t] = summarizeTurns(
      at([user("x"), assistant([{ type: "tool_use", name: "mcp__homeostat__learn" }])]),
    );
    expect(t?.calls).toEqual(["learn"]);
    expect(t?.retrieved).toBe(false);
  });
});

describe("readLinesFrom", () => {
  test("reads from a byte offset with each line's offset, and from the start after a rewrite", () => {
    const path = join(mkdtempSync(join(tmpdir(), "homeostat-lines-")), "t.jsonl");
    writeFileSync(path, "ab\nç\ncd");
    const all = readLinesFrom(path, 0);
    expect(all.lines).toEqual([
      { text: "ab", offset: 0 },
      { text: "ç", offset: 3 },
      { text: "cd", offset: 6 },
    ]);
    expect(readLinesFrom(path, 6).lines).toEqual([{ text: "cd", offset: 6 }]);
    expect(readLinesFrom(path, 100)).toMatchObject({ from: 0 });
    expect(readLinesFrom(join(path, "missing"), 0).lines).toEqual([]);
  });
});
