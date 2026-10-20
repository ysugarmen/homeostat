import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createServer, type LearnInput, TOOLS } from "../src/server.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;

/** The starter KB; `security` lines are added under its security section. */
function kbFiles(security: string[] = []) {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if ((f.endsWith(".md") || f.endsWith(".yaml")) && f !== "README.md") {
      files[f] = readFileSync(join(starter, f), "utf8");
    }
  }
  files["homeostat.yaml"] = (files["homeostat.yaml"] ?? "").replace(
    "  allowedDomains: []\n",
    `  allowedDomains: []\n${security.map((l) => `  ${l}\n`).join("")}`,
  );
  return files;
}

interface ConnectOptions {
  /** Lines for the security section; the default turns MCP writes on. */
  security?: string[];
  member?: string;
}

async function connect(opts: ConnectOptions = {}) {
  const security = opts.security ?? ["mcpWrites: true"];
  const events: Record<string, unknown>[] = [];
  const learned: LearnInput[] = [];
  const flagged: [string, string][] = [];
  const server = createServer({
    readKb: () => kbFiles(security),
    ...(opts.member ? { member: () => opts.member } : {}),
    learn: async (input) => {
      learned.push(input);
      return "saved as a candidate on candidates/lee";
    },
    flag: async (id, reason) => {
      flagged.push([id, reason]);
      return `flagged ${id}`;
    },
    log: (e) => events.push(e),
    events: () => events,
    now: () => new Date("2026-10-14T09:00:00Z"),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  return { client, call, events, learned, flagged };
}

describe("tool list", () => {
  test("eight tools, each described in under 200 characters, with JSON schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "context",
      "search",
      "explain",
      "learn",
      "flag",
      "report",
      "docs",
      "read",
    ]);
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeLessThan(200);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(TOOLS).toHaveLength(8);
  });

  test("the server tells agents when to use it", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain("call context with the files you will touch");
    expect(client.getInstructions()).toContain("save it with learn");
  });

  test("with MCP writes off, the instructions point to the learn skill, not a hidden tool", async () => {
    const { client } = await connect({ security: [] });
    expect(client.getInstructions()).not.toContain("save it with learn");
    expect(client.getInstructions()).toContain("/homeostat:learn");
  });
});

describe("tools", () => {
  test("search finds rules by topic", async () => {
    const { call } = await connect();
    const r = await call("search", { query: "retry partner http calls" });
    expect(r.isError).toBe(false);
    expect(r.text.split("\n")[0]).toContain("outbound-http-retry-helper");
  });

  test("search says plainly when nothing matches", async () => {
    const { call } = await connect();
    expect((await call("search", { query: "kubernetes" })).text).toContain(
      'No accepted rules match "kubernetes"',
    );
  });

  test("context returns the rules for the files, like the session-start hook, and logs it", async () => {
    const { call, events } = await connect();
    const r = await call("context", { paths: ["services/integrations/partner.ts"] });
    expect(r.text).toContain("(outbound-http-retry-helper)");
    expect(r.text).toContain("(redact-before-logging)");
    expect(events).toContainEqual(expect.objectContaining({ type: "injection", source: "mcp" }));
  });

  test("explain gives the source, score breakdown and owner", async () => {
    const { call } = await connect();
    const r = await call("explain", { id: "outbound-http-retry-helper" });
    expect(r.text).toContain(
      "score 4 (+3 review comment led to a code change, +1 author dana is senior)",
    );
    expect(r.text).toContain("owner dana");
    expect(r.text).toContain(
      "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33",
    );
  });

  test("explain on a wrong id suggests the closest", async () => {
    const { call } = await connect();
    const r = await call("explain", { id: "retry-helper" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Closest: outbound-http-retry-helper");
  });

  test("learn and flag go to the host", async () => {
    const { call, learned, flagged } = await connect();
    expect((await call("learn", { title: "T", rule: "R", why: "W", scope: "web/**" })).text).toBe(
      "saved as a candidate on candidates/lee",
    );
    expect(learned).toEqual([{ title: "T", rule: "R", why: "W", scope: ["web/**"] }]);
    await call("flag", { id: "redact-before-logging", reason: "redact() was renamed" });
    expect(flagged).toEqual([["redact-before-logging", "redact() was renamed"]]);
  });

  test("flag refuses an unknown id", async () => {
    const { call, flagged } = await connect();
    expect((await call("flag", { id: "nope", reason: "r" })).isError).toBe(true);
    expect(flagged).toEqual([]);
  });

  test("report summarises the KB", async () => {
    const { call } = await connect();
    const r = await call("report", { days: 30 });
    expect(r.text).toContain("Entries: 3 (");
    expect(r.text).toContain("Possible duplicates: 0");
  });
});

describe("desire paths (3.2)", () => {
  test("common guesses resolve to the real tool and are logged", async () => {
    const { call, events } = await connect();
    for (const name of ["get_rules", "homeostat_search", "remember", "kb.explain", "Search"]) {
      expect(
        (
          await call(name, {
            query: "retry",
            paths: ["x.ts"],
            id: "redact-before-logging",
            title: "T",
            rule: "R",
            why: "W",
          })
        ).isError,
        name,
      ).toBe(false);
    }
    expect(events.filter((e) => e.type === "mcp-alias").map((e) => e.name)).toEqual([
      "get_rules",
      "homeostat_search",
      "remember",
      "kb.explain",
      "Search",
    ]);
  });

  test("argument spellings agents use are accepted", async () => {
    const { call } = await connect();
    expect((await call("search", { q: "retry" })).isError).toBe(false);
    expect((await call("explain", { entry_id: "redact-before-logging" })).isError).toBe(false);
    expect((await call("context", { file: "services/integrations/x.ts" })).text).toContain(
      "outbound-http-retry-helper",
    );
  });

  test("an unknown tool is logged and answered with the real tools and the closest one", async () => {
    const { call, events } = await connect();
    const r = await call("serch", { query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      'Unknown tool "serch". Tools: context, search, explain, learn, flag, report, docs, read. Did you mean search?',
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "mcp-unknown-tool", name: "serch", args: ["query"] }),
    );
  });

  test("a hidden list tool answers the commonest unlisted guess", async () => {
    const { call } = await connect();
    expect((await call("list_rules")).text).toContain("- outbound-http-retry-helper:");
  });

  test("bad arguments get a clear message", async () => {
    const { call } = await connect();
    const r = await call("search", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invalid arguments for search: query:");
  });
});

describe("security (T7)", () => {
  test("learn and flag are hidden and refused unless security.mcpWrites is on", async () => {
    const { client, call, learned } = await connect({ security: [] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "context",
      "search",
      "explain",
      "report",
      "docs",
      "read",
    ]);
    const r = await call("learn", { title: "t", rule: "r", why: "w" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Saving through MCP is off");
    expect(learned).toEqual([]);
  });

  test("writes are capped per session", async () => {
    const { call, learned } = await connect({ security: ["mcpWrites: true", "mcpWriteLimit: 2"] });
    const args = { title: "Use tokens", rule: "Use tokens.", why: "Dark mode." };
    expect((await call("learn", args)).isError).toBe(false);
    expect((await call("learn", args)).isError).toBe(false);
    const third = await call("learn", args);
    expect(third.isError).toBe(true);
    expect(third.text).toContain("used its 2 MCP writes");
    expect(learned).toHaveLength(2);
  });

  test("a team-only area reaches its own members' sessions and nobody else's", async () => {
    const security = ["teamOnlyAreas: [integrations]"];
    const files = ["services/integrations/partner.ts"];
    const outsider = await connect({ security, member: "lee" });
    expect((await outsider.call("context", { paths: files })).text).not.toContain(
      "outbound-http-retry-helper",
    );
    expect((await outsider.call("explain", { id: "outbound-http-retry-helper" })).isError).toBe(
      true,
    );
    const member = await connect({ security, member: "dana" });
    expect((await member.call("context", { paths: files })).text).toContain(
      "outbound-http-retry-helper",
    );
  });
});

describe("documents (K6)", () => {
  test("docs lists documents and their sections, by area or file", async () => {
    const { call } = await connect();
    const all = await call("docs");
    expect(all.text).toContain("- integrations/partner-calls: Partner API calls");
    expect(all.text).toContain("http-client (The shared HTTP client)");
    expect((await call("docs", { path: "apps/web/App.tsx" })).text).toContain(
      "No team documents match",
    );
  });

  test("read returns one section with its source, and logs the read", async () => {
    const { call, events } = await connect();
    const r = await call("read", { doc: "integrations/partner-calls", section: "timeouts" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("## Timeouts {#timeouts}");
    expect(r.text).toContain("(source: manual, 2026-09-30)");
    expect(r.text).not.toContain("withRetry");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "doc-read",
        doc: "integrations/partner-calls",
        section: "timeouts",
      }),
    );
    // A KB path works too, and a whole document comes back without a section.
    const whole = await call("read_doc", {
      document: "knowledge/integrations/docs/partner-calls.md",
    });
    expect(whole.text).toContain("withRetry");
    expect(whole.text).toContain("Partner calls time out");
  });

  test("unknown documents and sections list what exists", async () => {
    const { call } = await connect();
    expect((await call("read", { doc: "core/nope" })).text).toContain(
      "Documents: integrations/partner-calls",
    );
    expect(
      (await call("read", { doc: "integrations/partner-calls", section: "x" })).text,
    ).toContain("Sections: http-client, timeouts");
  });

  test("a team-only area's documents are hidden from other members", async () => {
    const { call } = await connect({ security: ["teamOnlyAreas: [integrations]"], member: "lee" });
    expect((await call("docs")).text).toContain("No team documents match");
  });
});

describe("a multi-repo KB", () => {
  test("context records which repo the session's folder is", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const checkout = mkdtempSync(join(tmpdir(), "homeostat-mcp-checkout-"));
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/api.git",
    ]);
    const events: Record<string, unknown>[] = [];
    const server = createServer({
      readKb: () => ({
        "homeostat.yaml":
          'version: 1\nteam:\n  members:\n    - { id: dana, handle: "@dana", role: senior, areas: [core] }\nrepos:\n  api:\n    source: acme/api\n',
      }),
      learn: async () => "",
      flag: async () => "",
      log: (e) => events.push(e),
      checkout: () => checkout,
      now: () => new Date("2026-10-14T09:00:00Z"),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    await client.callTool({ name: "context", arguments: { paths: ["services/app.py"] } });
    expect(events.find((e) => e.type === "injection")?.repo).toBe("api");
  });
});
