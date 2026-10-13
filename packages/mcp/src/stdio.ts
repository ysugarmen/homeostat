import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type McpDeps } from "./server.ts";

/** Serves the Homeostat tools over stdio until the client disconnects. */
export async function serveStdio(deps: McpDeps, version?: string): Promise<void> {
  const server = createServer(deps, version);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
}
