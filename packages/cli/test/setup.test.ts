import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HostSetup,
  type PipelineSchedule,
  ProviderError,
  parseConfig,
  readSetupRecord,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type HostAuth, type Io, runCli, type SpawnResult } from "../src/cli.ts";
import { cleanSecret } from "../src/setup/context.ts";

const TOKEN = "bbtok-0123456789abcdef";
const GH_TOKEN = "ghp_0123456789abcdefABCD";
const API_KEY = "sk-ant-api03-test-0123456789";
const OAUTH = "sk-ant-oat01-test0123456789abcdefghijklmnopqrstuvwxyz";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xyzSECRETxyz";
const SECRETS = [TOKEN, GH_TOKEN, API_KEY, OAUTH, WEBHOOK];

/** A KB checkout whose origin is on the host, pushing to a local bare repo instead. */
function kbRepo(host: "bitbucket" | "github") {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-setup-"));
  const bare = mkdtempSync(join(tmpdir(), "homeostat-setup-remote-"));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
  run(bare, "init", "-q", "--bare", "-b", "main");
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.name", "Ada Lovelace");
  run(dir, "config", "user.email", "ada@acme.example");
  const remote = `git@${host === "bitbucket" ? "bitbucket.org" : "github.com"}:acme/team-kb.git`;
  run(dir, "remote", "add", "origin", remote);
  run(dir, "config", `url.${bare}.pushInsteadOf`, remote);
  return { dir, git: (...args: string[]) => run(dir, ...args).toString() };
}

interface HostState {
  variables: Map<string, { value: string; secured: boolean }>;
  schedules: PipelineSchedule[];
  refuseWrites: boolean;
  /** The token may not read pipeline variables or schedules (not a repo admin). */
  refuseReads?: boolean;
  /**
   * Bitbucket's lists lag behind a write: what was written in this run is not listed yet. The
   * writes land in `variables` and `schedules`, but the lists leave them out.
   */
  lag?: boolean;
  written: Set<string>;
  members: { id: string; name?: string }[];
}

const forbidden = (): never => {
  throw new ProviderError("Bitbucket", 403, "https://api.example/vars", "forbidden");
};

function fakeHost(kind: "bitbucket" | "github", state: HostState) {
  const good = kind === "bitbucket" ? TOKEN : GH_TOKEN;
  return (_host: "bitbucket" | "github", auth: HostAuth): HostSetup => {
    const check = () => {
      if (auth.token !== good) throw new ProviderError(kind, 401, "https://api.example/x", "");
    };
    const listed = (key: string) => !state.lag || !state.written.has(key);
    const common = {
      kind,
      listMembers: async () => (check(), state.members),
      getRepository: async () => (check(), { fullName: "acme/team-kb", defaultBranch: "main" }),
      probePullRequests: async () => check(),
      topLevelFolders: async () => (check(), ["services", "apps", ".github", "docs"]),
    };
    if (kind === "github")
      return { ...common, actionsEnabled: async () => (check(), true) } as HostSetup;
    return {
      ...common,
      listVariables: async () => (
        check(),
        state.refuseReads && forbidden(),
        [...state.variables]
          .filter(([key]) => listed(key))
          .map(([key, v], i) => ({ uuid: `{${i}}`, key, secured: v.secured }))
      ),
      setVariable: async (_r, key, value, secured) => {
        check();
        if (state.refuseWrites)
          throw new ProviderError("Bitbucket", 403, "https://api.example/vars", "forbidden");
        state.variables.set(key, { value, secured });
        state.written.add(key);
      },
      listSchedules: async () => (
        check(), state.refuseReads && forbidden(), state.schedules.filter((s) => listed(s.pipeline))
      ),
      createSchedule: async (_r, s) => {
        check();
        state.schedules.push({ uuid: `{s${state.schedules.length}}`, ...s, enabled: true });
        state.written.add(s.pipeline);
      },
      enableSchedule: async (_r, uuid) => {
        check();
        for (const s of state.schedules) if (s.uuid === uuid) s.enabled = true;
      },
    } as HostSetup;
  };
}

const newState = (): HostState => ({
  variables: new Map(),
  schedules: [],
  refuseWrites: false,
  written: new Set(),
  members: [
    { id: "dana", name: "Dana Reyes" },
    { id: "ada", name: "Ada Lovelace" },
    { id: "lee", name: "Lee Park" },
  ],
});

/** Anthropic's models call and the Slack webhook; anything else is refused (no network). */
const fakeFetch = (posts: string[]) =>
  (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.anthropic.com/v1/models")) {
      const key = (init.headers as Record<string, string>)["x-api-key"];
      return new Response("{}", { status: key === API_KEY ? 200 : 401 });
    }
    if (url === WEBHOOK) {
      posts.push(String(init.body));
      return new Response("ok", { status: 200 });
    }
    throw new Error(`no network in tests: ${url}`);
  }) as typeof fetch;

interface GhState {
  installed: boolean;
  secrets: Map<string, string>;
}

/** `gh` and `claude` as fakes; every call is recorded, and the environment `claude` got. */
function fakeSpawn(
  gh: GhState,
  calls: string[],
  envs: Record<string, string | undefined>[],
  claude: Record<string, SpawnResult> = {},
) {
  return async (
    cmd: string,
    args: string[],
    opts: { input?: string; env?: Record<string, string | undefined> } = {},
  ) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (cmd === "gh") {
      if (!gh.installed) return { code: 127, stdout: "", stderr: "not found" };
      if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "secret" && args[1] === "set") {
        gh.secrets.set(args[2] as string, opts.input ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "secret" && args[1] === "list")
        return {
          code: 0,
          stdout: JSON.stringify([...gh.secrets.keys()].map((name) => ({ name }))),
          stderr: "",
        };
    }
    if (cmd === "claude") {
      envs.push(opts.env ?? {});
      const r = claude[args.join(" ")] ?? claude[args.slice(0, 3).join(" ")];
      return r ?? { code: 0, stdout: "", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: "" };
  };
}

/** Answers matched by question, in order; an unexpected question fails the test. */
function script(answers: [RegExp, string][], asked: string[]) {
  const queue = [...answers];
  return async (question: string) => {
    asked.push(question);
    const i = queue.findIndex(([re]) => re.test(question));
    if (i < 0) throw new Error(`unexpected question: ${question}`);
    const [, answer] = queue.splice(i, 1)[0] as [RegExp, string];
    return answer;
  };
}

function harness(opts: {
  host: "bitbucket" | "github";
  state?: HostState;
  gh?: GhState;
  answers?: [RegExp, string][];
  secrets?: [RegExp, string][];
  env?: Record<string, string>;
  terminal?: boolean;
  claude?: Record<string, SpawnResult>;
}) {
  const out = {
    stdout: "",
    stderr: "",
    asked: [] as string[],
    calls: [] as string[],
    envs: [] as Record<string, string | undefined>[],
    posts: [] as string[],
  };
  const state = opts.state ?? newState();
  const gh = opts.gh ?? { installed: true, secrets: new Map() };
  const terminal = opts.terminal ?? true;
  const io: Io = {
    stdout: (s) => (out.stdout += s),
    stderr: (s) => (out.stderr += s),
    color: false,
    env: opts.env ?? {},
    fetch: fakeFetch(out.posts),
    spawn: fakeSpawn(gh, out.calls, out.envs, opts.claude),
    hostSetup: fakeHost(opts.host, state),
    ...(terminal
      ? {
          ask: script(opts.answers ?? [], out.asked),
          secret: script(opts.secrets ?? [], out.asked),
        }
      : {}),
  };
  return { io, out, state, gh };
}

const setup = (io: Io, dir: string, ...args: string[]) =>
  runCli(["node", "homeostat", "setup", "--dir", dir, ...args], io);

const config = (dir: string) => readFileSync(join(dir, "homeostat.yaml"), "utf8");

function expectNoSecret(out: { stdout: string; stderr: string; asked?: string[] }) {
  for (const s of SECRETS) {
    expect(out.stdout).not.toContain(s);
    expect(out.stderr).not.toContain(s);
    for (const q of out.asked ?? []) expect(q).not.toContain(s);
  }
}

const BITBUCKET_ANSWERS: [RegExp, string][] = [
  // A required step defaults to yes: an empty answer sets it up.
  [/Set up Git-host token for CI now\?/, ""],
  [/Email of the Atlassian account that created this token/, "bot@acme.example"],
  // A browser URL, as copied from the address bar.
  [/Code repos to learn from/, "https://bitbucket.org/acme/integrations-api/src/main/, acme/web"],
  [/Set up Areas per repo now\?/, "y"],
  [/Areas for integrations-api/, ""],
  [/Areas for web/, "-"],
  [/Which number is you/, "2"],
  [/Who else joins/, "1"],
  [/Role for Dana Reyes/, "senior"],
  [/Areas Dana Reyes .*owns/, "integrations-api/services"],
  [/Set up Reviewers now\?/, "y"],
  [/Reviewers, comma-separated/, ""],
  [/Number \(1-4\)/, ""],
  [/Set up Slack now\?/, "y"],
  [/Did the test message arrive/, "y"],
  [/Slack member ID of ada-lovelace/, "U0123ABCD"],
  [/Slack member ID of dana-reyes/, ""],
  [/Set up CODEOWNERS and branch protection now\?/, "y"],
  [/Set up First base now\?/, "n"],
  [/Set up Teammates now\?/, "y"],
];
const BITBUCKET_SECRETS: [RegExp, string][] = [
  [/Paste the Bitbucket token/, `  ${TOKEN}\n`],
  [/Paste the API key/, API_KEY],
  [/Paste the webhook URL/, WEBHOOK],
];

/** A full Bitbucket setup, as the fresh-run test does it. */
async function bitbucketDone(state?: HostState) {
  const repo = kbRepo("bitbucket");
  const h = harness({
    host: "bitbucket",
    answers: BITBUCKET_ANSWERS,
    secrets: BITBUCKET_SECRETS,
    ...(state ? { state } : {}),
  });
  const code = await setup(h.io, repo.dir);
  return { repo, h, code };
}

const envFor = { HOMEOSTAT_GIT_TOKEN: TOKEN, HOMEOSTAT_GIT_EMAIL: "bot@acme.example" };

describe("homeostat setup on Bitbucket", () => {
  test("a fresh run walks every step, verifies and stores each secret", async () => {
    const { repo, h, code } = await bitbucketDone();
    expect(h.out.stderr).toBe("");
    expect(code).toBe(0);
    const c = parseConfig(config(repo.dir)).config;
    expect(c?.sources).toMatchObject({ host: "bitbucket", kbRepo: "acme/team-kb" });
    expect(c?.repos?.["integrations-api"]).toEqual({
      source: "acme/integrations-api",
      areas: { services: ["services/**"], apps: ["apps/**"] },
    });
    expect(c?.repos?.web?.source).toBe("acme/web");
    expect(c?.team.members).toEqual([
      expect.objectContaining({
        id: "ada-lovelace",
        handle: "@ada",
        role: "senior",
        slack: "U0123ABCD",
      }),
      expect.objectContaining({
        id: "dana-reyes",
        handle: "@dana",
        role: "senior",
        areas: ["integrations-api/services"],
      }),
    ]);
    expect(c?.team.reviewers).toEqual(["ada-lovelace", "dana-reyes"]);
    expect(c?.notifications.slackWebhookEnv).toBe("HOMEOSTAT_SLACK_WEBHOOK");
    // The config keeps init's comments: it was edited, not regenerated.
    expect(config(repo.dir)).toContain("# homeostat knowledge base config.");
    // Secrets: trimmed, verified, stored as secured variables under the new names; never printed.
    expect(h.state.variables.get("HOMEOSTAT_GIT_TOKEN")).toEqual({ value: TOKEN, secured: true });
    expect(h.state.variables.get("HOMEOSTAT_GIT_EMAIL")).toEqual({
      value: "bot@acme.example",
      secured: false,
    });
    expect(h.state.variables.has("HOMEOSTAT_BITBUCKET_TOKEN")).toBe(false);
    expect(h.state.variables.get("ANTHROPIC_API_KEY")?.value).toBe(API_KEY);
    expect(h.state.variables.get("HOMEOSTAT_SLACK_WEBHOOK")?.value).toBe(WEBHOOK);
    expect(h.out.posts).toHaveLength(1);
    expect(h.state.schedules.map((s) => [s.pipeline, s.cron])).toEqual([
      ["homeostat-curator", "0 0 6 * * ? *"],
      ["homeostat-deep-dive", "0 0 7 ? * MON *"],
      ["homeostat-digest", "0 0 8 ? * MON *"],
    ]);
    expect(existsSync(join(repo.dir, ".bitbucket/CODEOWNERS"))).toBe(true);
    expect(repo.git("log", "--oneline", "origin/main")).toContain("homeostat: setup");
    expect(h.out.stdout).toContain("setup --join");
    expect(h.out.stdout).toContain("Every required step is done.");
    expectNoSecret(h.out);
    // The record for the dashboard holds states, never a value.
    const record = readFileSync(join(repo.dir, ".homeostat/setup.json"), "utf8");
    for (const s of SECRETS) expect(record).not.toContain(s);
    expect(readSetupRecord(repo.dir).token?.state).toBe("done");
  });

  test("required steps default to yes, optional ones to no", async () => {
    const { h } = await bitbucketDone();
    const token = h.out.asked.find((q) => /Set up Git-host token for CI now/.test(q));
    expect(token).toMatch(/\[Y\/n\]$/);
    const optional = h.out.asked.filter((q) => /Set up .* now\?/.test(q) && q !== token);
    expect(optional.length).toBeGreaterThan(0);
    for (const q of optional) expect(q).toMatch(/\[y\/N\]$/);
  });

  test("every prompt is one question with an example or a default; hidden ones say so", async () => {
    const { h } = await bitbucketDone();
    for (const q of h.out.asked) {
      expect(q.split("\n")).toHaveLength(1);
      if (/^ *Paste /.test(q)) expect(q).toContain("nothing shows while you paste");
      else expect(q).toMatch(/\(example: |\[[^\]]*\]$/);
    }
    // The token help is two lines, scopes included, and links the guide.
    expect(h.out.stdout).toContain("your own account works");
    expect(h.out.stdout).toContain("read:pullrequest:bitbucket");
    expect(h.out.stdout).toContain("docs/guide/setup.md#git-host-token");
    expect(h.out.stdout).not.toContain("bot account");
  });

  test("optional steps say they are optional and what you lose without them", async () => {
    const { h } = await bitbucketDone();
    expect(h.out.stdout).toMatch(
      /○ +4\. Areas per repo \(optional\) · Without areas every rule applies/,
    );
    expect(h.out.asked.some((q) => /Set up First base now/.test(q))).toBe(true);
  });

  test("what was stored or scheduled in this run counts, though the host's lists lag", async () => {
    const state = newState();
    state.lag = true;
    const { repo, h, code } = await bitbucketDone(state);
    expect(code).toBe(0);
    // Right after each write, and in the final checklist.
    expect(h.out.stdout).toMatch(
      /✓ +2\. Git-host token for CI · HOMEOSTAT_GIT_TOKEN stored just now/,
    );
    expect(h.out.stdout).toMatch(
      /✓ +7\. Model credential · api: ANTHROPIC_API_KEY stored just now/,
    );
    expect(h.out.stdout).toMatch(
      /✓ +8\. Slack \(optional\) · HOMEOSTAT_SLACK_WEBHOOK stored just now/,
    );
    expect(h.out.stdout).toMatch(/✓ +11\. Schedules · 3 schedules set just now/);
    const final = h.out.stdout.slice(h.out.stdout.lastIndexOf("✓  1. KB repo and host"));
    expect(final).not.toContain("✗");
    expect(final).toMatch(/✓ +7\. Model credential · api: ANTHROPIC_API_KEY stored just now/);
    expect(h.out.stdout).toContain("Every required step is done.");
    const record = readSetupRecord(repo.dir);
    for (const step of ["token", "model", "slack", "schedules"])
      expect(record[step]?.state).toBe("done");
    expect(record.model?.reason).toBe("api: ANTHROPIC_API_KEY stored");
    expectNoSecret(h.out);
  });

  test("a re-run where everything is done asks nothing", async () => {
    const { repo } = await bitbucketDone();
    // A first base, so the one optional step left is done too.
    mkdirSync(join(repo.dir, "knowledge/core/docs"), { recursive: true });
    writeFileSync(
      join(repo.dir, "knowledge/core/docs/overview.md"),
      '---\ntitle: Overview\narea: core\nowner: ada-lovelace\nscope: ["**"]\nupdated: 2026-10-20\n---\nHow the services fit together.\n\n## Services {#services}\nThe API calls the worker through the queue.\n',
    );
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "docs");
    repo.git("push", "-q");
    const state = newState();
    for (const k of ["HOMEOSTAT_GIT_TOKEN", "ANTHROPIC_API_KEY", "HOMEOSTAT_SLACK_WEBHOOK"])
      state.variables.set(k, { value: "x", secured: true });
    // The schedules exactly as Bitbucket lists them: seconds first, `?`, and MON for 1.
    state.schedules = [
      ["homeostat-curator", "0 0 6 * * ? *"],
      ["homeostat-deep-dive", "0 0 7 ? * MON *"],
      ["homeostat-digest", "0 0 8 ? * MON *"],
    ].map(([pipeline, cron], i) => ({
      uuid: `{${i}}`,
      pipeline: pipeline as string,
      branch: "main",
      cron: cron as string,
      enabled: true,
    }));
    const h = harness({ host: "bitbucket", state, env: envFor });
    expect(await setup(h.io, repo.dir)).toBe(0);
    expect(h.out.asked).toEqual([]);
    expect(h.out.stdout).not.toContain("✗");
    expect(h.out.stdout).toMatch(/✓ +11\. Schedules · 3 schedules/);
  });

  test("a re-run repairs the one broken step and asks only for it", async () => {
    const { repo, h: first } = await bitbucketDone();
    const state = first.state;
    state.variables.delete("ANTHROPIC_API_KEY");
    const h = harness({
      host: "bitbucket",
      state,
      env: envFor,
      answers: [
        [/Number \(1-4\)/, ""],
        [/Set up First base now/, "n"],
      ],
      secrets: [[/Paste the API key/, API_KEY]],
    });
    expect(await setup(h.io, repo.dir)).toBe(0);
    expect(h.out.stdout).toMatch(/✗ +7\. Model credential · ANTHROPIC_API_KEY is not stored/);
    expect(state.variables.get("ANTHROPIC_API_KEY")?.value).toBe(API_KEY);
    expect(h.out.asked).toHaveLength(3);
    expectNoSecret(h.out);
  });

  test("a second run without a token trusts the record and asks for none of it", async () => {
    const { repo, h: first } = await bitbucketDone();
    const h = harness({
      host: "bitbucket",
      state: first.state,
      answers: [[/Set up First base now/, "n"]],
    });
    expect(await setup(h.io, repo.dir)).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(h.out.stdout).toMatch(
      new RegExp(`✓ +2\\. Git-host token for CI · stored earlier \\(checked ${today}\\)`),
    );
    expect(h.out.stdout).toMatch(/✓ +7\. Model credential · stored earlier/);
    expect(h.out.stdout).toMatch(/✓ +11\. Schedules · scheduled earlier/);
    expect(h.out.asked).toEqual([expect.stringMatching(/Set up First base now/)]);
    // The record keeps the real check's date: a recalled result is never written back.
    expect(readSetupRecord(repo.dir).token?.reason).toBe("HOMEOSTAT_GIT_TOKEN stored");

    // Picking the step by name redoes it.
    const again = harness({
      host: "bitbucket",
      state: first.state,
      answers: [[/Email of the Atlassian account/, "bot@acme.example"]],
      secrets: [[/Paste the Bitbucket token/, TOKEN]],
    });
    expect(await setup(again.io, repo.dir, "--step", "token")).toBe(0);
    expect(again.out.asked.some((q) => /Paste the Bitbucket token/.test(q))).toBe(true);
    expectNoSecret(again.out);
  });

  test("a refused write asks once for an admin token, then prints where to paste the value", async () => {
    const repo = kbRepo("bitbucket");
    const state = newState();
    state.refuseWrites = true;
    const h = harness({
      host: "bitbucket",
      state,
      answers: [[/Email of the Atlassian account/, ""]],
      secrets: [
        [/Paste the Bitbucket token/, TOKEN],
        [/Paste a token with admin on the KB repo.*empty to skip/, ""],
      ],
    });
    expect(await setup(h.io, repo.dir, "--step", "host")).toBe(0);
    expect(await setup(h.io, repo.dir, "--step", "token")).toBe(1);
    expect(h.out.stdout).toContain("403: this token cannot do that; it needs admin on the KB repo");
    expect(h.out.stdout).toContain(
      "https://bitbucket.org/acme/team-kb/admin/pipelines/repository-variables",
    );
    expect(h.out.stdout).toContain("name HOMEOSTAT_GIT_TOKEN");
    expectNoSecret(h.out);
  });

  test("a pasted-twice token is refused, and a wrong one is not stored", async () => {
    const repo = kbRepo("bitbucket");
    const h = harness({
      host: "bitbucket",
      answers: [[/Email of the Atlassian account/, ""]],
      secrets: [
        [/Paste the Bitbucket token/, `${TOKEN}${TOKEN}`],
        [/Paste the Bitbucket token/, "wrong-token-value"],
      ],
    });
    await setup(h.io, repo.dir, "--step", "host");
    expect(await setup(h.io, repo.dir, "--step", "token")).toBe(1);
    expect(h.out.stdout).toContain("looks pasted twice");
    expect(h.out.stdout).toContain("401");
    expect(h.state.variables.size).toBe(0);
    expectNoSecret(h.out);
    expect(h.out.stdout).not.toContain("wrong-token-value");
  });

  test("an https origin on bitbucket.org gets one line on API-token passwords", async () => {
    const repo = kbRepo("bitbucket");
    repo.git("remote", "set-url", "origin", "https://bitbucket.org/acme/team-kb.git");
    const h = harness({ host: "bitbucket" });
    expect(await setup(h.io, repo.dir, "--step", "host")).toBe(0);
    expect(h.out.stdout).toContain("username x-bitbucket-api-token-auth");
    expect(h.out.stdout).toContain("setup.md#clone-over-https");
  });
});

describe("homeostat setup variable names", () => {
  test("--check accepts the old names, says they work, and renames nothing", async () => {
    const { repo, h: first } = await bitbucketDone();
    const state = first.state;
    for (const [from, to] of [
      ["HOMEOSTAT_GIT_TOKEN", "HOMEOSTAT_BITBUCKET_TOKEN"],
      ["HOMEOSTAT_GIT_EMAIL", "HOMEOSTAT_BITBUCKET_EMAIL"],
    ] as const) {
      state.variables.set(to, state.variables.get(from) as { value: string; secured: boolean });
      state.variables.delete(from);
    }
    const h = harness({
      host: "bitbucket",
      state,
      env: { HOMEOSTAT_BITBUCKET_TOKEN: TOKEN, HOMEOSTAT_BITBUCKET_EMAIL: "bot@acme.example" },
    });
    expect(await setup(h.io, repo.dir, "--check")).toBe(0);
    expect(h.out.stdout).toMatch(
      /✓ +2\. Git-host token for CI · HOMEOSTAT_BITBUCKET_TOKEN is stored: works; consider renaming to HOMEOSTAT_GIT_TOKEN/,
    );
    expect([...state.variables.keys()]).not.toContain("HOMEOSTAT_GIT_TOKEN");
    expect([...state.variables.keys()]).toContain("HOMEOSTAT_BITBUCKET_TOKEN");
    expectNoSecret(h.out);
  });
});

describe("homeostat setup model runtimes", () => {
  const CLAUDE_P =
    "-p Reply OK --max-turns 1 --model haiku --output-format json --tools  --strict-mcp-config --setting-sources  --no-session-persistence";

  async function claudeCode(claude: Record<string, SpawnResult>) {
    const { repo, h: first } = await bitbucketDone();
    const h = harness({
      host: "bitbucket",
      state: first.state,
      env: envFor,
      answers: [
        [/Already done/, "y"],
        [/Number \(1-4\)/, "2"],
      ],
      secrets: [[/Paste the token/, OAUTH]],
      claude,
    });
    const code = await setup(h.io, repo.dir, "--step", "model");
    return { repo, h, code };
  }

  test("the runtime is a numbered menu, with the current one as the default", async () => {
    const { h } = await claudeCode({
      [CLAUDE_P]: { code: 0, stdout: '{"is_error":false}', stderr: "" },
    });
    expect(h.out.stdout).toContain("How should the agents reach Claude?");
    expect(h.out.stdout).toContain("1) Claude Console API key");
    expect(h.out.stdout).toContain("2) Claude Code login");
    expect(h.out.stdout).toContain("3) AWS Bedrock");
    expect(h.out.stdout).toContain("4) Google Vertex");
    expect(h.out.asked).toContain("  Number (1-4) [1]");
    expect(h.out.stdout).toContain("In another terminal run  claude setup-token");
  });

  test("a Claude Code token is tried with claude -p before it is stored, then the CI installs Claude Code", async () => {
    const { repo, h, code } = await claudeCode({
      [CLAUDE_P]: { code: 0, stdout: '{"is_error":false,"result":"OK"}', stderr: "" },
    });
    expect(code).toBe(0);
    expect(h.out.calls).toContain(`claude ${CLAUDE_P}`);
    // The token reached claude through its environment only, alone.
    expect(h.out.envs[0]).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    });
    expect(h.out.calls.join("\n")).not.toContain(OAUTH);
    expect(h.out.stdout).toContain("the token works");
    expect(h.state.variables.get("CLAUDE_CODE_OAUTH_TOKEN")?.value).toBe(OAUTH);
    expect(parseConfig(config(repo.dir)).config?.agents.runtime).toBe("claude-code");
    // The CI file was edited by setup, for the commit step to commit.
    const pipeline = readFileSync(join(repo.dir, "bitbucket-pipelines.yml"), "utf8");
    expect(pipeline).toMatch(/^ {12}- npm install -g .*@anthropic-ai\/claude-code$/m);
    expect(h.out.stdout).toContain("bitbucket-pipelines.yml now installs Claude Code");
    expect(h.out.stdout).not.toContain("uncomment");
    expectNoSecret(h.out);

    // The commit step sees the edit, in agreeing numbers.
    const check = harness({ host: "bitbucket", state: h.state, env: envFor });
    await setup(check.io, repo.dir, "--check");
    expect(check.out.stdout).toMatch(/✗ +10\. Commit and push · 2 files not committed/);
  });

  test("a refused Claude Code token is not stored", async () => {
    const { h } = await claudeCode({
      [CLAUDE_P]: {
        code: 1,
        stdout: '{"is_error":true,"result":"Invalid API key · Please run /login"}',
        stderr: "",
      },
    });
    expect(h.out.stdout).toContain("Claude Code refused the token: Invalid API key");
    expect(h.state.variables.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    expectNoSecret(h.out);
  });

  test("without Claude Code installed, the token's shape is checked, and it says so", async () => {
    const { h } = await claudeCode({ [CLAUDE_P]: { code: 127, stdout: "", stderr: "" } });
    expect(h.out.stdout).toContain(
      "the token has the right shape (Claude Code is not installed here, so it was not tried)",
    );
    expect(h.state.variables.get("CLAUDE_CODE_OAUTH_TOKEN")?.value).toBe(OAUTH);
    expectNoSecret(h.out);
  });
});

describe("homeostat setup on GitHub", () => {
  const answers: [RegExp, string][] = [
    [/Set up Git-host token for CI now/, "y"],
    [/Code repos to learn from/, "https://github.com/acme/web-app/tree/main"],
    [/Set up Areas per repo now/, "n"],
    [/Which number is you/, "ada"],
    [/Who else joins/, ""],
    [/Set up Reviewers now/, "n"],
    [/Number \(1-4\)/, "api"],
    [/Set up Slack now/, "n"],
    [/Set up CODEOWNERS and branch protection now/, "n"],
    [/Set up First base now/, "n"],
    [/Set up Teammates now/, "n"],
  ];
  const secrets: [RegExp, string][] = [
    [/Paste the GitHub token/, GH_TOKEN],
    [/Paste the API key/, API_KEY],
  ];

  test("a fresh run stores secrets with gh, the value on stdin", async () => {
    const repo = kbRepo("github");
    const h = harness({ host: "github", answers, secrets });
    expect(await setup(h.io, repo.dir)).toBe(0);
    const c = parseConfig(config(repo.dir)).config;
    expect(c?.sources).toMatchObject({
      host: "github",
      kbRepo: "acme/team-kb",
      repos: ["acme/web-app"],
    });
    expect(c?.team.members[0]).toMatchObject({ id: "ada-lovelace", handle: "@ada" });
    expect(h.gh.secrets.get("HOMEOSTAT_GIT_TOKEN")).toBe(GH_TOKEN);
    expect(h.gh.secrets.get("ANTHROPIC_API_KEY")).toBe(API_KEY);
    expect(h.out.calls).toContain("gh secret set ANTHROPIC_API_KEY -R acme/team-kb");
    expect(h.out.calls.join("\n")).not.toContain(API_KEY);
    expect(existsSync(join(repo.dir, ".github/workflows/homeostat-curator.yml"))).toBe(true);
    expect(h.out.stdout).toMatch(/✓ +11\. Schedules/);
    // One member: "1 member", not "1 members".
    expect(h.out.stdout).toMatch(/✓ +5\. Team · 1 member\n/);
    expectNoSecret(h.out);
  });

  test("without gh it prints the exact command, and nothing is stored", async () => {
    const repo = kbRepo("github");
    const h = harness({
      host: "github",
      gh: { installed: false, secrets: new Map() },
      secrets: [[/Paste the GitHub token/, GH_TOKEN]],
    });
    await setup(h.io, repo.dir, "--step", "host");
    expect(await setup(h.io, repo.dir, "--step", "token")).toBe(1);
    expect(h.out.stdout).toContain("gh secret set HOMEOSTAT_GIT_TOKEN -R acme/team-kb");
    expect(h.out.stdout).toContain("https://github.com/acme/team-kb/settings/secrets/actions");
    expectNoSecret(h.out);
  });
});

describe("homeostat setup without a terminal, --check and --join", () => {
  test("without a terminal it asks nothing, writes nothing and says what supplies each value", async () => {
    const repo = kbRepo("bitbucket");
    const h = harness({ host: "bitbucket", terminal: false });
    expect(await setup(h.io, repo.dir)).toBe(1);
    expect(existsSync(join(repo.dir, "homeostat.yaml"))).toBe(false);
    expect(h.out.stdout).toContain("No terminal, so nothing was asked");
    expect(h.out.stdout).toContain("repos: --repo owner/name");
    expect(h.out.stdout).toContain("token: HOMEOSTAT_GIT_TOKEN");
  });

  test("--check says which required steps it could not check, and why, without failing", async () => {
    const { repo, h: first } = await bitbucketDone();
    // No record: nothing to fall back on.
    rmSync(join(repo.dir, ".homeostat/setup.json"));
    first.state.refuseReads = true;
    const h = harness({ host: "bitbucket", state: first.state, env: envFor });
    expect(await setup(h.io, repo.dir, "--check")).toBe(0);
    expect(h.out.stdout).toMatch(/\? +2\. Git-host token for CI · .*403, needs repo admin to read/);
    expect(h.out.stdout).toMatch(/\? +11\. Schedules · 403, needs repo admin to read/);
    expect(h.out.stdout).toContain("No required step is missing, but 3 could not be checked");
    expect(h.out.stdout).not.toContain("Every required step is done");
    expect(h.out.stdout.match(/admin:pipeline:bitbucket/g)).toHaveLength(1);
    expectNoSecret(h.out);
  });

  test("--check exits 1 while a required step is missing, 0 once all are done", async () => {
    const fresh = kbRepo("bitbucket");
    const a = harness({ host: "bitbucket" });
    expect(await setup(a.io, fresh.dir, "--check")).toBe(1);
    expect(a.out.asked).toEqual([]);
    expect(a.out.stdout).toMatch(/✗ +1\. KB repo and host · no homeostat.yaml yet/);

    const { repo, h: first } = await bitbucketDone();
    const b = harness({ host: "bitbucket", state: first.state, env: envFor });
    expect(await setup(b.io, repo.dir, "--check")).toBe(0);
    expect(b.out.asked).toEqual([]);
    expect(b.out.stdout).toMatch(/✓ +2\. Git-host token for CI · HOMEOSTAT_GIT_TOKEN is stored/);
    expectNoSecret(b.out);
  });

  test("--step runs one step", async () => {
    const repo = kbRepo("bitbucket");
    const h = harness({ host: "bitbucket" });
    expect(await setup(h.io, repo.dir, "--step", "host")).toBe(0);
    expect(existsSync(join(repo.dir, "homeostat.yaml"))).toBe(true);
    expect(await setup(h.io, repo.dir, "--step", "nope")).toBe(1);
    expect(h.out.stderr).toContain('unknown step "nope"');
  });

  test("--join installs the plugin, sets kb_dir and checks the member", async () => {
    const repo = kbRepo("bitbucket");
    const h = harness({
      host: "bitbucket",
      terminal: false,
      claude: {
        "plugin list --json": { code: 0, stdout: "[]", stderr: "" },
        "plugin configure homeostat@homeostat --json": {
          code: 0,
          stdout: '{"inputs":{}}',
          stderr: "",
        },
      },
    });
    await runCli(["node", "homeostat", "init", repo.dir], { ...h.io, stdout: () => {} });
    expect(await setup(h.io, repo.dir, "--join")).toBe(0);
    expect(h.out.calls).toEqual([
      "claude --version",
      "claude plugin list --json",
      "claude plugin marketplace add ysugarmen/homeostat",
      "claude plugin install homeostat@homeostat",
      "claude plugin configure homeostat@homeostat --json",
      "claude plugin configure homeostat@homeostat --values-stdin",
    ]);
    expect(h.out.stdout).toContain("is the member ada-lovelace");
    expect(readSetupRecord(repo.dir).join?.state).toBe("done");
  });

  test("--join prints the /plugin step when kb_dir cannot be set, and flags an unknown member", async () => {
    const repo = kbRepo("bitbucket");
    const h = harness({
      host: "bitbucket",
      terminal: false,
      claude: {
        "plugin list --json": {
          code: 0,
          stdout: '[{"id":"homeostat@homeostat"}]',
          stderr: "",
        },
        "plugin configure homeostat@homeostat --values-stdin": {
          code: 1,
          stdout: "",
          stderr: "unknown option",
        },
      },
    });
    await runCli(["node", "homeostat", "init", repo.dir, "--member", "dana"], {
      ...h.io,
      stdout: () => {},
    });
    expect(await setup(h.io, repo.dir, "--join")).toBe(1);
    expect(h.out.calls).not.toContain("claude plugin install homeostat@homeostat");
    expect(h.out.stdout).toContain("/plugin > homeostat > Configure");
    expect(h.out.stdout).toContain('"Ada Lovelace" is no member');
  });
});

describe("cleanSecret", () => {
  test("trims, and refuses doubled pastes and inner whitespace", () => {
    expect(cleanSecret(`  ${TOKEN}\n`)).toEqual({ value: TOKEN });
    expect(cleanSecret(`${TOKEN}${TOKEN}`)).toEqual({ error: expect.stringContaining("twice") });
    expect(cleanSecret(`${TOKEN}\n${TOKEN}`)).toEqual({
      error: expect.stringContaining("line breaks"),
    });
    expect(cleanSecret("")).toEqual({ error: "nothing entered" });
    for (const r of [cleanSecret(`${TOKEN}${TOKEN}`), cleanSecret(`${TOKEN} x`)])
      expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
