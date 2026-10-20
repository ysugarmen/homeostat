import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseEntry } from "../src/entry.ts";
import {
  foldRules,
  formatTopicFile,
  isTopicFile,
  mergeTopicFile,
  parseTopicFile,
  ruleSection,
} from "../src/topics.ts";
import { type KbFiles, validate } from "../src/validate.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;
function readKb(): KbFiles {
  const files: KbFiles = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".md") || f.endsWith(".yaml")) files[f] = readFileSync(join(starter, f), "utf8");
  }
  delete files["README.md"];
  return files;
}
const RETRY = "knowledge/integrations/outbound-http-retry-helper.md";
const REDACT = "knowledge/core/redact-before-logging.md";
const withTopics = (files: KbFiles): KbFiles => ({
  ...files,
  "homeostat.yaml": `${files["homeostat.yaml"]}\ntopics:\n  http: "Outbound HTTP calls to partners"\n  logging: "What we log and how"\n`,
});
const sectionOf = (files: KbFiles, path: string) => {
  const entry = parseEntry(files[path] ?? "").entry;
  if (!entry) throw new Error(`${path} does not parse`);
  return { id: entry.frontmatter.id, raw: ruleSection(entry) };
};

describe("topic files", () => {
  test("rules moved into topic files validate as before, and point at their file", () => {
    const files = withTopics(readKb());
    const http = formatTopicFile({ topic: "http", title: "HTTP" }, [sectionOf(files, RETRY)]);
    const logging = formatTopicFile({ topic: "logging", title: "Logging" }, [
      sectionOf(files, REDACT),
    ]);
    delete files[RETRY];
    delete files[REDACT];
    files["knowledge/integrations/http.md"] = http;
    files["knowledge/core/logging.md"] = logging;
    expect(isTopicFile(http)).toBe(true);

    const result = validate(files);
    expect(result.issues).toEqual([]);
    const retry = result.entries.find(
      (e) => e.entry.frontmatter.id === "outbound-http-retry-helper",
    );
    expect(retry).toMatchObject({
      path: RETRY,
      file: "knowledge/integrations/http.md",
      topic: "http",
    });
    // Same parsed rule as from its own file.
    expect(retry?.entry.sections).toEqual(parseEntry(readKb()[RETRY] ?? "").entry?.sections);
  });

  test("an unknown topic, topics not configured, or a broken section is reported at the file", () => {
    const files = readKb();
    const topic = formatTopicFile({ topic: "http", title: "HTTP" }, [sectionOf(files, RETRY)]);
    delete files[RETRY];
    expect(
      validate({ ...files, "knowledge/integrations/http.md": topic }).issues.map((i) => i.code),
    ).toContain("topic.unconfigured");
    const misnamed = topic.replace("topic: http", "topic: networking");
    const codes = validate(
      withTopics({ ...files, "knowledge/integrations/networking.md": misnamed }),
    ).issues.map((i) => i.code);
    expect(codes).toContain("topic.unknown");
    const broken = topic.replace("<!-- homeostat", "<!-- nothing");
    const issues = validate(
      withTopics({ ...files, "knowledge/integrations/http.md": broken }),
    ).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "topic.meta", file: "knowledge/integrations/http.md" }),
    );
  });

  test("a rule's own problems name the rule and its topic file", () => {
    const files = withTopics(readKb());
    const section = sectionOf(files, RETRY);
    section.raw = section.raw.replace("status: accepted", "status: nonsense");
    delete files[RETRY];
    const issues = validate({
      ...files,
      "knowledge/integrations/http.md": formatTopicFile({ topic: "http", title: "HTTP" }, [
        section,
      ]),
    }).issues.filter((i) => i.severity === "error");
    expect(issues[0]?.file).toBe("knowledge/integrations/http.md");
    expect(issues[0]?.message).toMatch(/^#outbound-http-retry-helper: /);
  });
});

describe("foldRules", () => {
  const files = withTopics(readKb());
  const retry = files[RETRY] ?? "";
  const config = validate(files).config;
  if (!config) throw new Error("starter config");

  test("a new rule goes to its topic file, sorted; one-rule KBs keep a file per rule", () => {
    const added = retry.replace("id: outbound-http-retry-helper", "id: a-first-rule");
    const out = foldRules(
      files,
      [{ path: "knowledge/integrations/a-first-rule.md", text: added, topic: "http" }],
      config,
    );
    const http = out["knowledge/integrations/http.md"] ?? "";
    expect(
      parseTopicFile("knowledge/integrations/http.md", http).sections.map((s) => s.id),
    ).toEqual(["a-first-rule"]);

    const both = foldRules(
      { ...files, "knowledge/integrations/http.md": http },
      [{ path: RETRY, text: retry, topic: "http" }],
      config,
    );
    expect(
      parseTopicFile(
        "x/integrations/http.md",
        both["knowledge/integrations/http.md"] ?? "",
      ).sections.map((s) => s.id),
    ).toEqual(["a-first-rule", "outbound-http-retry-helper"]);
    // The old one-rule file goes once the rule lives in its topic file.
    expect(both[RETRY]).toBeNull();

    const plain = validate(readKb()).config;
    if (!plain) throw new Error("starter config");
    const legacy = foldRules(
      readKb(),
      [{ path: "knowledge/integrations/a-first-rule.md", text: added }],
      plain,
    );
    expect(Object.keys(legacy)).toEqual(["knowledge/integrations/a-first-rule.md"]);
  });

  test("an update stays in the rule's topic file; removing the last rule deletes the file", () => {
    const http =
      foldRules(files, [{ path: RETRY, text: retry, topic: "http" }], config)[
        "knowledge/integrations/http.md"
      ] ?? "";
    const kb: KbFiles = { ...files, "knowledge/integrations/http.md": http };
    delete kb[RETRY];
    const flagged = retry.replace("status: accepted", "status: disputed");
    const updated = foldRules(kb, [{ path: RETRY, text: flagged }], config);
    expect(updated["knowledge/integrations/http.md"]).toContain("status: disputed");
    expect(Object.keys(updated)).toEqual(["knowledge/integrations/http.md"]);
    expect(
      foldRules(kb, [{ path: RETRY, text: null }], config)["knowledge/integrations/http.md"],
    ).toBeNull();
  });
});

describe("mergeTopicFile", () => {
  const files = readKb();
  const one = sectionOf(files, RETRY);
  const two = sectionOf(files, REDACT);
  const meta = { topic: "misc", title: "Misc" };
  const file = (...s: { id: string; raw: string }[]) => formatTopicFile(meta, s);

  test("sections added on both sides merge; the same section changed twice is a conflict", () => {
    const base = file(one);
    const ours = file(one, two);
    const theirs = file({ ...one, raw: one.raw.replace("status: accepted", "status: disputed") });
    const merged = mergeTopicFile("knowledge/core/misc.md", base, ours, theirs);
    expect(merged.conflicts).toEqual([]);
    const ids = parseTopicFile("knowledge/core/misc.md", merged.text ?? "").sections.map(
      (s) => s.id,
    );
    expect(ids).toEqual(["outbound-http-retry-helper", "redact-before-logging"]);
    expect(merged.text).toContain("status: disputed");

    const both = mergeTopicFile(
      "knowledge/core/misc.md",
      base,
      file({ ...one, raw: one.raw.replace("status: accepted", "status: retired") }),
      theirs,
    );
    expect(both.conflicts).toEqual(["outbound-http-retry-helper"]);
  });
});
