import { expect, test } from "vitest";
import { VERSION } from "../src/index.ts";

test("core package loads", () => {
  expect(VERSION).toBe("0.0.0");
});
