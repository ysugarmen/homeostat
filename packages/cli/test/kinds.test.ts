import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

async function run(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-14T09:00:00Z"),
    ...extra,
  });
  return { code, stdout, stderr };
}

/** Learns an entry and accepts it, as a reviewer merging its PR would. */
async function learnAccepted(kb: string, id: string, args: string[]) {
  const r = await run([
    "learn",
    "--dir",
    kb,
    "--id",
    id,
    "--author",
    "dana",
    "--area",
    "integrations",
    ...args,
  ]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const path = join(kb, `knowledge/integrations/${id}.md`);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("status: candidate", "status: accepted\napprovedBy: sam"),
  );
}

async function session(kb: string, file: string) {
  const cwd = mkdtempSync(join(tmpdir(), "homeostat-kinds-code-"));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), "x");
  const { stdout } = await run(["hook", "session-start"], {
    env: { HOMEOSTAT_DIR: kb },
    stdin: async () => JSON.stringify({ session_id: "s", cwd }),
  });
  return stdout ? (JSON.parse(stdout).hookSpecificOutput.additionalContext as string) : "";
}

describe("kinds and decisions (K2)", () => {
  test("a rejected proposal shows in search and explain, never in a session's rules", async () => {
    const kb = mkdtempSync(join(tmpdir(), "homeostat-kinds-"));
    cpSync(starter, kb, { recursive: true });
    await learnAccepted(kb, "no-graphql-gateway", [
      "--kind",
      "decision",
      "--not-adopted",
      "--title",
      "Put a GraphQL gateway in front of partner APIs",
      "--rule",
      "Route partner calls through a GraphQL gateway.",
      "--why",
      "Partners change shapes weekly and the gateway schema would lag; the shared client is enough.",
    ]);
    expect((await run(["validate", kb])).code).toBe(0);

    const found = await run(["search", "graphql gateway", "--dir", kb]);
    expect(found.stdout).toContain("considered and not adopted");
    expect(found.stdout).toContain("Why not: Partners change shapes weekly");

    const explained = await run(["explain", "no-graphql-gateway", "--dir", kb]);
    expect(explained.stdout).toContain("considered and NOT adopted");
    expect(explained.stdout).toContain("Proposal: Route partner calls");

    const context = await session(kb, "services/integrations/partner.ts");
    expect(context).toContain("outbound-http-retry-helper");
    expect(context).not.toContain("no-graphql-gateway");
    expect(context).not.toContain("GraphQL");
  });

  test("rules with kinds are grouped in the session, one line of guidance each", async () => {
    const kb = mkdtempSync(join(tmpdir(), "homeostat-kinds-"));
    cpSync(starter, kb, { recursive: true });
    await learnAccepted(kb, "move-to-v2-client", [
      "--kind",
      "migration",
      "--title",
      "Use the v2 partner client for new code",
      "--rule",
      "New partner integrations use PartnerClientV2; v1 is being removed.",
      "--why",
      "v1 blocks the event loop.",
    ]);
    const context = await session(kb, "services/integrations/partner.ts");
    expect(context).toContain("**Migrations in progress: check before touching this area");
    expect(context).toContain("**Other rules.**");
    expect(context.indexOf("Migrations in progress")).toBeLessThan(
      context.indexOf("move-to-v2-client"),
    );
  });

  test("adopted must go with kind decision", async () => {
    const kb = mkdtempSync(join(tmpdir(), "homeostat-kinds-"));
    cpSync(starter, kb, { recursive: true });
    const path = join(kb, "knowledge/core/redact-before-logging.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("status: accepted", "status: accepted\nadopted: false"),
    );
    const { code, stdout } = await run(["validate", kb]);
    expect(code).toBe(1);
    expect(stdout).toContain("adopted: only applies to kind: decision");
  });
});
