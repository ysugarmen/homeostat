import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const repo = new URL("../../../", import.meta.url).pathname;
const plugin = join(repo, "packages/plugin");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const skills = readdirSync(join(plugin, "skills"));
const skill = (name: string) => readFileSync(join(plugin, "skills", name, "SKILL.md"), "utf8");

async function help(command: string) {
  let out = "";
  await runCli(["node", "kbx", command, "--help"], {
    stdout: (s) => (out += s),
    stderr: (s) => (out += s),
    color: false,
  });
  return out;
}

// `claude plugin validate --strict` is the full check; this guards the repo-specific wiring.
describe("Claude Code plugin", () => {
  test("the marketplace points at the plugin, with matching names", () => {
    const marketplace = json(join(repo, ".claude-plugin/marketplace.json"));
    const manifest = json(join(plugin, ".claude-plugin/plugin.json"));
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: manifest.name, source: "./packages/plugin" }),
    ]);
    expect(
      existsSync(join(repo, marketplace.plugins[0].source, ".claude-plugin/plugin.json")),
    ).toBe(true);
  });

  test("the plugin version matches the CLI it drives", () => {
    const manifest = json(join(plugin, ".claude-plugin/plugin.json"));
    expect(manifest.version).toBe(json(join(repo, "packages/cli/package.json")).version);
  });

  test.each(skills)("skill %s has a name matching its folder and a description", (name) => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill(name))?.[1] ?? "";
    expect(frontmatter).toMatch(new RegExp(`^name: ${name}$`, "m"));
    expect(frontmatter).toMatch(/^description: .{20,}$/m);
  });

  test.each([
    ["learn", "learn"],
    ["validate", "review"],
  ])("every kbx %s flag the %s skill uses exists", async (command, name) => {
    const used = new Set(
      [...skill(name).matchAll(new RegExp(`kbx(?:@0)? ${command}[^\\n\`)]*`, "g"))].flatMap((m) =>
        [...m[0].matchAll(/--[a-z][a-z-]*/g)].map((f) => f[0]),
      ),
    );
    expect(used.size).toBeGreaterThan(0);
    const options = await help(command);
    for (const flag of used)
      expect(options, `${flag} is not a kbx ${command} option`).toContain(flag);
  });
});
