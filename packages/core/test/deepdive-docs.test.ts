import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { deepDive } from "../src/deepdive.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;
function files() {
  const out: Record<string, string> = {
    "homeostat.yaml": readFileSync(join(starter, "homeostat.yaml"), "utf8"),
  };
  for (const f of readdirSync(join(starter, "knowledge"), { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".md"))
      out[`knowledge/${f}`] = readFileSync(join(starter, "knowledge", f), "utf8");
  }
  return out;
}

test("the deep dive notes coverage gaps and stale document sections, and edits no document (K4)", async () => {
  const kb = files();
  const doc = "knowledge/integrations/docs/partner-calls.md";
  // Move the integrations document's date back, and accept the frontend rule so that area needs one.
  kb[doc] = (kb[doc] ?? "").replace("updated=2026-09-30", "updated=2025-01-01");
  const frontend = "knowledge/frontend/use-design-tokens-for-colors.md";
  kb[frontend] = (kb[frontend] ?? "").replace(
    "status: candidate",
    "status: accepted\napprovedBy: sam",
  );
  const { changes, notes } = await deepDive({ files: kb, today: "2026-10-14" });
  expect(notes).toContain(
    "coverage gap: area frontend has 1 accepted rule but no document under knowledge/frontend/docs/",
  );
  expect(notes.some((n) => n.startsWith(`stale section: ${doc}#timeouts was last confirmed`))).toBe(
    true,
  );
  expect(notes.some((n) => n.includes("#http-client"))).toBe(false);
  expect(changes.map((c) => c.path).filter((p) => p.includes("/docs/"))).toEqual([]);
});
