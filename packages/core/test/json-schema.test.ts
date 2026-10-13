import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { entryJsonSchema } from "../src/json-schema.ts";

test("committed schema/entry.schema.json is up to date (run `pnpm gen:schema`)", () => {
  const committed = readFileSync(new URL("../schema/entry.schema.json", import.meta.url), "utf8");
  expect(JSON.parse(committed)).toEqual(entryJsonSchema());
});
