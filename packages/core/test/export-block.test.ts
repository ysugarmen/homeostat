import { describe, expect, test } from "vitest";
import { BLOCK_END, BLOCK_START, removeBlock, replaceBlock } from "../src/export-block.ts";

const block = `${BLOCK_START}\nrules\n${BLOCK_END}`;

describe("replaceBlock", () => {
  test("creates the file content when there is none", () => {
    expect(replaceBlock(undefined, block)).toBe(`${block}\n`);
  });

  test("appends after hand-written content, separated by a blank line", () => {
    expect(replaceBlock("# Our agents\n\nBe nice.", block)).toBe(
      `# Our agents\n\nBe nice.\n\n${block}\n`,
    );
  });

  test("replaces only the marked block, keeping text before and after", () => {
    const existing = `# Top\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\n# Bottom\n`;
    expect(replaceBlock(existing, block)).toBe(`# Top\n\n${block}\n\n# Bottom\n`);
  });

  test("is idempotent", () => {
    const once = replaceBlock("# Top\n", block);
    expect(replaceBlock(once, block)).toBe(once);
  });
});

describe("removeBlock", () => {
  test("removes the block and keeps the rest", () => {
    expect(removeBlock(`# Top\n\n${block}\n`)).toBe("# Top\n");
  });

  test("a file that was only the block becomes empty", () => {
    expect(removeBlock(`${block}\n`)).toBe("");
  });
});
