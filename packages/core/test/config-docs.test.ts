import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { configSchema } from "../src/config.ts";

/** Leaf keys of the config schema, as dotted paths (records count as one key). */
function leafKeys(schema: unknown, prefix: string[] = []): string[] {
  const def = (
    schema as { def?: { type?: string; shape?: Record<string, unknown>; innerType?: unknown } }
  ).def;
  if (!def) return [prefix.join(".")];
  if (def.type === "default" || def.type === "prefault" || def.type === "optional") {
    return leafKeys(def.innerType, prefix);
  }
  if (def.type === "object" && def.shape) {
    return Object.entries(def.shape).flatMap(([k, v]) => leafKeys(v, [...prefix, k]));
  }
  return [prefix.join(".")];
}

test("docs/guide/config.md documents every config key", () => {
  const doc = readFileSync(new URL("../../../docs/guide/config.md", import.meta.url), "utf8");
  const missing = leafKeys(configSchema).filter((k) => !doc.includes(`| \`${k}\``));
  expect(missing).toEqual([]);
});
