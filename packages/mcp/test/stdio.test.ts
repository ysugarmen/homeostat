import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";

const repo = new URL("../../../", import.meta.url).pathname;

// The path every client takes: plain Node starts the plugin launcher, which starts the real
// homeostat bin, which serves MCP over stdio.
test("an MCP client lists and calls tools through the plugin launcher", async () => {
  const kb = mkdtempSync(join(tmpdir(), "homeostat-mcp-"));
  cpSync(join(repo, "examples/starter-kb"), kb, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, "packages/plugin/hooks/run.mjs"), "mcp"],
    env: {
      PATH: process.env.PATH ?? "",
      HOMEOSTAT_CLI: join(repo, "packages/cli/bin/homeostat.js"),
      HOMEOSTAT_DIR: kb,
    },
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("context");
    const result = (await client.callTool({
      name: "search",
      arguments: { query: "redact logging" },
    })) as {
      content: { text: string }[];
    };
    expect(result.content[0]?.text).toContain("redact-before-logging");
  } finally {
    await client.close();
  }
}, 30_000);
