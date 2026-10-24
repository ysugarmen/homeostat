import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-tu-"));
  cpSync(starter, dir, { recursive: true });
  return dir;
}

// Transcript lines in the shape Claude Code writes them: one line per content block.
const prompt = (text: string, at: string) =>
  JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: text } });
const tool = (name: string) =>
  JSON.stringify({
    type: "assistant",
    message: { id: "m", content: [{ type: "tool_use", id: "t", name, input: { query: "x" } }] },
  });
const result = () =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t", content: "hits" }] },
  });
const reply = (text: string) =>
  JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text }] } });
const SEARCH = "mcp__plugin_homeostat_homeostat__search";

async function stop(dir: string, transcript: string, extra: object = {}) {
  let stderr = "";
  const io: Io = {
    stdout: () => {},
    stderr: (s) => (stderr += s),
    color: false,
    env: { HOMEOSTAT_DIR: dir },
    stdin: async () =>
      JSON.stringify({ session_id: "s1", cwd: dir, transcript_path: transcript, ...extra }),
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
  const code = await runCli(["node", "homeostat", "hook", "stop"], io);
  return { code, stderr, events: readEvents(dir, { types: ["turn-usage"] }) };
}

describe("turn usage from the Stop hook", () => {
  test("one event per turn: Homeostat calls, retrieval, and credited ids that exist", async () => {
    const dir = kb();
    const path = join(mkdtempSync(join(tmpdir(), "homeostat-tr-")), "t.jsonl");
    writeFileSync(
      path,
      `${[
        prompt("the partner call returns 500, fix it", "2026-10-13T10:00:00Z"),
        tool(SEARCH),
        result(),
        tool("Read"),
        reply(
          "> From Homeostat (outbound-http-retry-helper, integrations/partner-calls#timeouts, made-up-rule)\nUse withRetry().",
        ),
        prompt("thanks", "2026-10-13T10:05:00Z"),
        reply("Done."),
      ].join("\n")}\n`,
    );
    const { code, events } = await stop(dir, path);
    expect(code).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ts: "2026-10-13T10:00:00Z",
      session: "s1",
      turn: 1,
      calls: ["search"],
      retrieved: true,
      credited: true,
      credits: ["outbound-http-retry-helper", "integrations/partner-calls#timeouts"],
      otherCredits: 1,
    });
    expect(events[1]).toMatchObject({ turn: 2, calls: [], retrieved: false, credited: false });
    // Ids and counts only: nothing the user or the agent wrote.
    const stored = JSON.stringify(events);
    for (const text of ["partner call returns", "withRetry", "thanks", "Done.", "made-up-rule"]) {
      expect(stored).not.toContain(text);
    }
  });

  test("the previous turn is read again once its reply is flushed, and still counts once", async () => {
    const dir = kb();
    const path = join(mkdtempSync(join(tmpdir(), "homeostat-tr-")), "t.jsonl");
    // Stop fires before the final reply reaches the file.
    writeFileSync(
      path,
      `${[prompt("why do we retry", "2026-10-13T10:00:00Z"), tool(SEARCH)].join("\n")}\n`,
    );
    let r = await stop(dir, path);
    expect(r.events).toEqual([expect.objectContaining({ turn: 1, credited: false })]);
    // The reply lands, the next turn runs, and its Stop re-reads turn 1.
    appendFileSync(
      path,
      `${[
        reply("> From Homeostat (outbound-http-retry-helper)\nBecause partners flake."),
        prompt("ok commit", "2026-10-13T10:10:00Z"),
      ].join("\n")}\n`,
    );
    r = await stop(dir, path);
    expect(r.events.map((e) => [e.turn, e.credited])).toEqual([
      [1, true],
      [2, false],
    ]);
    // A third Stop with nothing new changes nothing.
    r = await stop(dir, path);
    expect(r.events).toHaveLength(2);
  });

  test("the current turn's credit is taken from last_assistant_message when the file lags", async () => {
    const dir = kb();
    const path = join(mkdtempSync(join(tmpdir(), "homeostat-tr-")), "t.jsonl");
    writeFileSync(path, `${prompt("add a test", "2026-10-13T10:00:00Z")}\n${tool(SEARCH)}\n`);
    const r = await stop(dir, path, {
      last_assistant_message: "> From Homeostat (integrations/partner-calls#timeouts)\nDone.",
    });
    expect(r.events[0]).toMatchObject({
      credited: true,
      credits: ["integrations/partner-calls#timeouts"],
    });
  });

  test("HOMEOSTAT_NO_TURN_USAGE turns it off", async () => {
    const dir = kb();
    const path = join(mkdtempSync(join(tmpdir(), "homeostat-tr-")), "t.jsonl");
    writeFileSync(path, `${prompt("hi", "2026-10-13T10:00:00Z")}\n`);
    let events: unknown[] = [];
    await runCli(["node", "homeostat", "hook", "stop"], {
      stdout: () => {},
      stderr: () => {},
      color: false,
      env: { HOMEOSTAT_DIR: dir, HOMEOSTAT_NO_TURN_USAGE: "1" },
      stdin: async () => JSON.stringify({ session_id: "s1", cwd: dir, transcript_path: path }),
    });
    events = readEvents(dir, { types: ["turn-usage"] });
    expect(events).toEqual([]);
  });

  test("a missing or broken transcript never fails the hook", async () => {
    const dir = kb();
    expect((await stop(dir, join(dir, "nope.jsonl"))).code).toBe(0);
    const path = join(mkdtempSync(join(tmpdir(), "homeostat-tr-")), "t.jsonl");
    writeFileSync(path, "not json\n{\n");
    const r = await stop(dir, path);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.events).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("not json\n{\n");
  });
});
