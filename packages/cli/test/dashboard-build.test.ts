import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

test("homeostat dashboard --build writes the shared copy and serves nothing", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "homeostat-dash-build-")), "site");
  let stdout = "";
  const code = await runCli(["node", "homeostat", "dashboard", "--dir", starter, "--build", out], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
  });
  expect(code).toBe(0);
  expect(stdout).toMatch(/^built \d+ files into /);
  expect(existsSync(join(out, "index.html"))).toBe(true);
});
