import { describe, expect, test } from "vitest";
import { rows } from "../src/charts.ts";

describe("rows", () => {
  test("a label too long for its column is shortened, and kept whole in the tooltip", () => {
    const id = "parse-partner-responses-with-zod-before-using-them-everywhere";
    const svg = rows([{ label: id, value: 5 }], { title: "t", labelWidth: 220 });
    expect(svg).toContain(">parse-partner-responses-wit…</text>");
    expect(svg).toContain(`<title>${id}: 5</title>`);
  });

  test("a label that fits is left alone", () => {
    expect(rows([{ label: "web", value: 1 }], { title: "t" })).toContain(">web</text>");
  });
});
