import { describe, expect, test } from "vitest";
import { areaChart, info, rings, rows, stackedColumns } from "../src/charts.ts";

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

describe("stackedColumns", () => {
  test("parts keep their own colour inline, markers sit at fractional positions, lines break at gaps", () => {
    const svg = stackedColumns(
      [
        {
          label: "60",
          parts: [
            { name: "a", value: 2, color: "red" },
            { name: "b", value: 0, color: "blue" },
            { name: "c", value: 1, color: "green" },
          ],
        },
        { label: "70", parts: [{ name: "a", value: 0, color: "red" }] },
      ],
      {
        title: "t",
        markers: [{ at: 0.5, label: "half" }],
        lines: [{ name: "n", values: [3, undefined], color: "pink" }],
      },
    );
    expect(svg.match(/class="part"/g)).toHaveLength(2);
    expect(svg).toContain('style="fill:red"');
    expect(svg).toContain('style="fill:green"');
    expect(svg).not.toContain("blue");
    expect(svg).toContain("<title>60: 2 a, 0 b, 1 c</title>");
    expect(svg).toContain('class="marker"');
    expect(svg).toContain(">half</text>");
    expect(svg.match(/<polyline/g)).toHaveLength(1);
    expect(svg).toContain('style="stroke:pink"');
  });

  test("with no data only the baseline is drawn", () => {
    const svg = stackedColumns([], { title: "t" });
    expect(svg).toContain('class="base"');
    expect(svg).not.toContain('class="m"');
  });
});

describe("info", () => {
  test("an (i) a keyboard can reach, whose text stays in the page for screen readers", () => {
    const html = info("Lessons the daily run could not decide.");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="tooltip">Lessons the daily run could not decide.</span>');
  });
});

describe("areaChart and rings", () => {
  test("the area chart marks and labels the last point; each point has a hover title", () => {
    const svg = areaChart(
      [
        { label: "16 Oct", value: 2 },
        { label: "17 Oct", value: 6, title: "17 Oct: 6 sessions" },
      ],
      { title: "Sessions", id: "t" },
    );
    expect(svg).toContain('class="callout"');
    expect(svg).toContain('<text x="8" y="28" class="cv">6</text>');
    expect(svg).toContain("<title>17 Oct: 6 sessions</title>");
  });

  test("with a unit, the callout names what it counts", () => {
    // From the demo: a bare 13 under "Rules in force" read as 13 rules.
    const svg = areaChart([{ label: "18 Oct", value: 13 }], {
      title: "S",
      id: "u",
      unit: "sessions",
    });
    expect(svg).toContain('class="cv">13 <tspan class="cu">sessions</tspan></text>');
  });

  test("rings draw one arc per segment, the largest the longest", () => {
    const svg = rings(
      [
        { label: "Merged", value: 3, color: "green" },
        { label: "Declined", value: 0, color: "red" },
      ],
      "Decisions",
    );
    expect(svg.match(/class="ring"/g)).toHaveLength(2);
    expect(svg).toContain("<title>Merged: 3</title>");
  });
});
