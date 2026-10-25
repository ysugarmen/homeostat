import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEntry, readKbFiles, validate } from "@homeostat/core";
import { replayFetch } from "@homeostat/core/testing";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;
const NOW = new Date("2026-10-13T12:00:00Z");

function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-learn-"));
  cpSync(join(examples, "starter-kb"), dir, { recursive: true });
  return dir;
}

async function run(args: string[], deps: Partial<Io> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    now: () => NOW,
    env: {},
    ...deps,
  });
  return { code, stdout, stderr };
}

/** A learned entry lands in the developer's pending area, not the tracked files. */
const entryAt = (dir: string, path: string) => {
  const { entry, issues } = parseEntry(readFileSync(join(dir, ".homeostat/pending", path), "utf8"));
  if (!entry) throw new Error(JSON.stringify(issues));
  return entry;
};

const basic = [
  "--title",
  "Validate webhook signatures before parsing the body",
  "--rule",
  "Call verifySignature() on the raw request body before JSON parsing any webhook.",
  "--why",
  "Parsing first lets a forged payload reach business logic.",
  "--author",
  "lee",
];

describe("homeostat learn with flags", () => {
  test("writes a candidate entry that keeps the KB valid", async () => {
    const dir = kb();
    const { code, stdout } = await run(["learn", "--dir", dir, ...basic]);
    expect(code).toBe(0);
    const path = "knowledge/core/validate-webhook-signatures-before-parsing-the-body.md";
    expect(stdout).toContain(
      "saved validate-webhook-signatures-before-parsing-the-body (candidate, score 2): it applies to your sessions now",
    );
    expect(existsSync(join(dir, path))).toBe(false); // the tracked files stay clean
    const entry = entryAt(dir, path);
    expect(entry.frontmatter).toMatchObject({
      id: "validate-webhook-signatures-before-parsing-the-body",
      area: "core",
      scope: ["**"],
      status: "candidate",
      score: 2,
      owner: "lee",
      source: { type: "manual", author: "lee" },
      created: "2026-10-13",
      lastConfirmed: "2026-10-13",
    });
    expect(entry.sections.rule).toMatch(/^Call verifySignature/);
    expect(validate(readKbFiles(dir)).ok).toBe(true);
  });

  test("scope defaults to the area's globs; --scope and --owner override", async () => {
    const dir = kb();
    await run(["learn", "--dir", dir, ...basic, "--area", "integrations", "--id", "a"]);
    expect(entryAt(dir, "knowledge/integrations/a.md").frontmatter.scope).toEqual([
      "services/integrations/**",
      "packages/http-client/**",
    ]);
    await run([
      "learn",
      "--dir",
      dir,
      ...basic,
      "--area",
      "integrations",
      "--id",
      "b",
      "--scope",
      "services/integrations/webhooks/**",
      "--owner",
      "dana",
      "--tag",
      "security",
    ]);
    expect(entryAt(dir, "knowledge/integrations/b.md").frontmatter).toMatchObject({
      scope: ["services/integrations/webhooks/**"],
      owner: "dana",
      tags: ["security"],
    });
  });

  test("a senior author scores higher", async () => {
    const dir = kb();
    const args = basic.map((a) => (a === "lee" ? "dana" : a));
    const { stdout } = await run(["learn", "--dir", dir, ...args]);
    expect(stdout).toContain("(candidate, score 3)");
  });

  test("--example-file adds an Example section", async () => {
    const dir = kb();
    const example = join(dir, "example.md");
    writeFileSync(example, "```ts\nverifySignature(raw)\n```\n");
    await run(["learn", "--dir", dir, ...basic, "--id", "x", "--example-file", example]);
    expect(entryAt(dir, "knowledge/core/x.md").sections.example).toBe(
      "```ts\nverifySignature(raw)\n```",
    );
  });

  test("an existing id is refused", async () => {
    const dir = kb();
    const { code, stderr } = await run([
      "learn",
      "--dir",
      dir,
      ...basic,
      "--id",
      "redact-before-logging",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("knowledge/core/redact-before-logging.md already exists");
  });

  test("validation errors in the new entry write nothing", async () => {
    const dir = kb();
    const long = Array.from({ length: 61 }, () => "word").join(" ");
    const args = ["learn", "--dir", dir, ...basic, "--id", "long", "--rule", long];
    const { code, stdout } = await run(args);
    expect(code).toBe(1);
    expect(stdout).toContain("## Rule has 61 words; max 60");
    expect(stdout).toContain("nothing written");
    expect(existsSync(join(dir, "knowledge/core/long.md"))).toBe(false);
  });

  test("an unknown area writes nothing", async () => {
    const dir = kb();
    const { code, stdout } = await run(["learn", "--dir", dir, ...basic, "--area", "payments"]);
    expect(code).toBe(1);
    expect(stdout).toContain('area "payments" is not in the config');
  });

  test("errors elsewhere in the KB do not block a new entry", async () => {
    const dir = kb();
    writeFileSync(join(dir, "knowledge/core/broken.md"), "no frontmatter");
    expect((await run(["learn", "--dir", dir, ...basic])).code).toBe(0);
  });

  test("without a terminal, missing fields are listed", async () => {
    const { code, stderr } = await run(["learn", "--dir", kb(), "--title", "Something"]);
    expect(code).toBe(1);
    expect(stderr).toContain("missing --rule, --why");
  });
});

describe("homeostat learn interactively", () => {
  test("asks for what the flags did not give", async () => {
    const dir = kb();
    const answers = [
      "Keep handlers idempotent",
      "Make every queue handler safe to run twice.",
      "Queues redeliver on timeout.",
      "",
    ];
    const asked: string[] = [];
    const ask = async (q: string) => {
      asked.push(q);
      return answers.shift() ?? "";
    };
    const { code } = await run(["learn", "--dir", dir, "--author", "lee"], { ask });
    expect(code).toBe(0);
    expect(asked).toEqual(["Title", "Rule (one paragraph)", "Why", "Area [core]"]);
    expect(entryAt(dir, "knowledge/core/keep-handlers-idempotent.md").sections.why).toBe(
      "Queues redeliver on timeout.",
    );
  });
});

describe("homeostat learn <PR comment URL>", () => {
  const ruleArgs = [
    "--rule",
    "Use withRetry() for partner calls.",
    "--why",
    "It adds the request-id header.",
  ];

  test("Bitbucket: fills the source from the comment and detects the code change", async () => {
    const dir = kb();
    const { fetch } = replayFetch("bitbucket");
    const url = "https://bitbucket.org/acme/integrations-api/pull-requests/812/_/diff#comment-33";
    const { code, stdout } = await run(
      [
        "learn",
        url,
        "--dir",
        dir,
        "--title",
        "Retry partner calls with withRetry",
        ...ruleArgs,
        "--area",
        "integrations",
      ],
      { fetch, env: { HOMEOSTAT_GIT_TOKEN: "t" } },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("> Please use `withRetry()`");
    const entry = entryAt(dir, "knowledge/integrations/retry-partner-calls-with-withretry.md");
    expect(entry.frontmatter.source).toEqual({
      type: "pr-feedback",
      url,
      author: "dana",
      changedCode: true,
    });
    expect(entry.frontmatter.score).toBe(4);
  });

  test("Bitbucket: no commit after the comment means changedCode false", async () => {
    const dir = kb();
    const { fetch } = replayFetch("bitbucket");
    const url = "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-36";
    await run(["learn", url, "--dir", dir, "--id", "lgtm", "--title", "t", ...ruleArgs], {
      fetch,
      env: { HOMEOSTAT_GIT_TOKEN: "t" },
    });
    expect(entryAt(dir, "knowledge/core/lgtm.md").frontmatter.source.changedCode).toBe(false);
  });

  test("GitHub: review comment, author mapped through the member handle", async () => {
    const dir = kb();
    // A GitHub team's KB: switch the starter's host, and its one Bitbucket entry with it.
    const config = join(dir, "homeostat.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace("host: bitbucket", "host: github"));
    rmSync(join(dir, "knowledge/integrations/outbound-http-retry-helper.md"));
    const { fetch, sent } = replayFetch("github");
    const url = "https://github.com/acme/web-app/pull/120#discussion_r9001";
    const { code } = await run(
      [
        "learn",
        url,
        "--dir",
        dir,
        "--id",
        "tokens",
        "--title",
        "Use colour tokens",
        ...ruleArgs,
        "--area",
        "frontend",
      ],
      { fetch, env: { GITHUB_TOKEN: "gh" } },
    );
    expect(code).toBe(0);
    expect(entryAt(dir, "knowledge/frontend/tokens.md").frontmatter.source).toMatchObject({
      author: "sam",
      changedCode: true,
    });
    expect(sent[0]?.headers.Authorization).toBe("Bearer gh");
  });

  test("a comment author who is not a member asks for --author", async () => {
    const dir = kb();
    const config = join(dir, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace('handle: "@dana"', 'handle: "@dana-r"'),
    );
    const { fetch } = replayFetch("bitbucket");
    const url = "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33";
    const { code, stderr } = await run(["learn", url, "--dir", dir, "--title", "t", ...ruleArgs], {
      fetch,
      env: { HOMEOSTAT_GIT_TOKEN: "t" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('no member has handle "@dana"; pass --author');
  });

  test("a missing token says which variable to set", async () => {
    const url = "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33";
    const { code, stderr } = await run(["learn", url, "--dir", kb(), ...ruleArgs]);
    expect(code).toBe(1);
    expect(stderr).toContain("set HOMEOSTAT_GIT_TOKEN");
  });

  test.each([
    ["https://github.com/acme/web-app/pull/120#issuecomment-1", "only review comments"],
    [
      "https://gitlab.com/acme/x/-/merge_requests/1#note_1",
      "not a Bitbucket or GitHub PR comment URL",
    ],
    ["https://github.com/acme/web-app/pull/120#discussion_r404", "comment 404 not found on PR 120"],
  ])("rejects %s", async (url, message) => {
    const { fetch } = replayFetch("github");
    const { code, stderr } = await run(["learn", url, "--dir", kb(), "--title", "t", ...ruleArgs], {
      fetch,
      env: { GITHUB_TOKEN: "gh" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });
});

describe("homeostat learn in a multi-repo KB", () => {
  const multi = () => {
    const dir = mkdtempSync(join(tmpdir(), "homeostat-learn-multi-"));
    cpSync(join(examples, "starter-multi-kb"), dir, { recursive: true });
    return dir;
  };

  test("--repo files the rule under that repo, --shared under knowledge/core/", async () => {
    const dir = multi();
    const id = "validate-webhook-signatures-before-parsing-the-body";
    const inRepo = await run([
      "learn",
      "--dir",
      dir,
      ...basic,
      "--repo",
      "api",
      "--area",
      "integrations",
    ]);
    expect(inRepo.code).toBe(0);
    expect(entryAt(dir, `knowledge/api/integrations/${id}.md`).frontmatter.scope).toEqual([
      "services/integrations/**",
      "packages/http-client/**",
    ]);

    const shared = await run(["learn", "--dir", multi(), ...basic, "--shared"]);
    expect(shared.code).toBe(0);
    expect(shared.stdout).toContain(`saved ${id}`);
  });

  test("with no repo to go on, or an area of another repo, it says what to pass", async () => {
    const dir = multi();
    const none = await run(["learn", "--dir", dir, ...basic]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("pass --repo <name> (one of api, web), or --shared");
    const wrong = await run([
      "learn",
      "--dir",
      dir,
      ...basic,
      "--repo",
      "web",
      "--area",
      "integrations",
    ]);
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toContain('area "integrations" is not in the areas of repo web');
    const sharedArea = await run([
      "learn",
      "--dir",
      dir,
      ...basic,
      "--shared",
      "--area",
      "integrations",
    ]);
    expect(sharedArea.stderr).toContain("a shared rule holds in every repo");
  });
});

describe("homeostat learn in a topic KB", () => {
  const topicKb = () => {
    const dir = kb();
    const config = join(dir, "homeostat.yaml");
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}\ntopics:\n  webhooks: "Incoming webhook payloads and signatures"\n  logging: "What we log and how"\n`,
    );
    return dir;
  };
  const id = "validate-webhook-signatures-before-parsing-the-body";

  test("--topic names the topic; without it, the best word match; never an unknown one", async () => {
    const dir = topicKb();
    expect((await run(["learn", "--dir", dir, ...basic, "--topic", "logging"])).code).toBe(0);
    expect(entryAt(dir, `knowledge/core/${id}.md`).frontmatter.topic).toBe("logging");

    const matched = topicKb();
    expect((await run(["learn", "--dir", matched, ...basic])).code).toBe(0);
    expect(entryAt(matched, `knowledge/core/${id}.md`).frontmatter.topic).toBe("webhooks");

    const unknown = await run(["learn", "--dir", topicKb(), ...basic, "--topic", "payments"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(
      'unknown topic "payments"; use one of: general, webhooks, logging',
    );
  });
});
