import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const bin = new URL("../bin/homeostat.js", import.meta.url).pathname;
const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

// vitest compiles TypeScript itself, so only running the real bin under Node proves that every
// module loads with Node's type stripping (no enums, parameter properties or namespaces).
test("the homeostat binary runs under plain Node", () => {
  const out = execFileSync(process.execPath, [bin, "validate", starter], { encoding: "utf8" });
  expect(out).toContain("3 entries, no problems");
});

test("piping into a reader that closes early is not a crash", () => {
  const out = execFileSync(
    "sh",
    ["-c", `"${process.execPath}" "${bin}" --help | head -1; echo "status=$?"`],
    {
      encoding: "utf8",
    },
  );
  expect(out).toContain("Usage: homeostat");
  expect(out).not.toContain("EPIPE");
});

test("the CLI installs as both homeostat and the short alias homeo", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.bin).toEqual({ homeostat: "./bin/homeostat.js", homeo: "./bin/homeostat.js" });
});
