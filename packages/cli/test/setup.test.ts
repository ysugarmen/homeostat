import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xyzSECRETxyz";
const SECRETS = [TOKEN, GH_TOKEN, API_KEY, WEBHOOK];

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
        [...state.variables].map(([key, v], i) => ({ uuid: `{${i}}`, key, secured: v.secured }))
      ),
      setVariable: async (_r, key, value, secured) => {
        check();
        if (state.refuseWrites)
          throw new ProviderError("Bitbucket", 403, "https://api.example/vars", "forbidden");
        state.variables.set(key, { value, secured });
      },
      listSchedules: async () => (check(), state.refuseReads && forbidden(), state.schedules),
      createSchedule: async (_r, s) => {
        check();
        state.schedules.push({ uuid: `{s${state.schedules.length}}`, ...s, enabled: true });
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

/** `gh` and `claude` as fakes; every call is recorded. */
function fakeSpawn(gh: GhState, calls: string[], claude: Record<string, SpawnResult> = {}) {
  return async (cmd: string, args: string[], opts: { input?: string } = {}) => {
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
    spawn: fakeSpawn(gh, out.calls, opts.claude),
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

function expectNoSecret(out: { stdout: string; stderr: string }) {
  for (const s of SECRETS) {
    expect(out.stdout).not.toContain(s);
    expect(out.stderr).not.toContain(s);
  }
}

const BITBUCKET_ANSWERS: [RegExp, string][] = [
  [/Git-host token for CI: cannot check/, "y"],
  [/account email/, "bot@acme.example"],
  [/same token for these writes/, "y"],
  [/Code repos the daily run reads/, "acme/integrations-api, acme/web"],
  [/Areas per repo is optional/, "y"],
  [/Areas for integrations-api/, ""],
  [/Areas for web/, "-"],
  [/Which one is you/, "2"],
  [/Who else joins/, "1"],
  [/Role for Dana Reyes/, "senior"],
  [/Areas Dana Reyes .*owns/, "integrations-api/services"],
  [/Reviewers is optional/, "y"],
  [/Reviewers \(member ids/, ""],
  [/Runtime/, ""],
  [/Slack is optional/, "y"],
  [/Did the test message arrive/, "y"],
  [/Slack member ID for ada-lovelace/, "U0123ABCD"],
  [/Slack member ID for dana-reyes/, ""],
  [/CODEOWNERS and branch protection is optional/, "y"],
  [/First base is optional/, "n"],
  [/Teammates is optional/, "y"],
];
const BITBUCKET_SECRETS: [RegExp, string][] = [
  [/HOMEOSTAT_BITBUCKET_TOKEN/, `  ${TOKEN}\n`],
  [/API key/, API_KEY],
  [/Webhook URL/, WEBHOOK],
];

/** A full Bitbucket setup, as the fresh-run test does it. */
async function bitbucketDone() {
  const repo = kbRepo("bitbucket");
  const h = harness({ host: "bitbucket", answers: BITBUCKET_ANSWERS, secrets: BITBUCKET_SECRETS });
  const code = await setup(h.io, repo.dir);
  return { repo, h, code };
}

const envFor = { HOMEOSTAT_BITBUCKET_TOKEN: TOKEN, HOMEOSTAT_BITBUCKET_EMAIL: "bot@acme.example" };

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
    // Secrets: trimmed, verified, stored as secured variables; never printed.
    expect(h.state.variables.get("HOMEOSTAT_BITBUCKET_TOKEN")).toEqual({
      value: TOKEN,
      secured: true,
    });
    expect(h.state.variables.get("HOMEOSTAT_BITBUCKET_EMAIL")).toEqual({
      value: "bot@acme.example",
      secured: false,
    });
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

  test("optional steps say they are optional and what you lose without them", async () => {
    const { h } = await bitbucketDone();
    expect(h.out.stdout).toMatch(
      /○ +4\. Areas per repo \(optional\) · Without areas every rule applies/,
    );
    expect(h.out.asked.some((q) => /First base is optional/.test(q))).toBe(true);
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
    for (const k of ["HOMEOSTAT_BITBUCKET_TOKEN", "ANTHROPIC_API_KEY", "HOMEOSTAT_SLACK_WEBHOOK"])
      state.variables.set(k, { value: "x", secured: true });
    state.schedules = ["homeostat-curator", "homeostat-deep-dive", "homeostat-digest"].map(
      (pipeline, i) => ({
        uuid: `{${i}}`,
        pipeline,
        branch: "main",
        cron: "0 0 6 * * ? *",
        enabled: true,
      }),
    );
    const h = harness({ host: "bitbucket", state, env: envFor });
    expect(await setup(h.io, repo.dir)).toBe(0);
    expect(h.out.asked).toEqual([]);
    expect(h.out.stdout).not.toContain("✗");
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
        [/Runtime/, ""],
        [/same token for these writes/, "y"],
        [/First base is optional/, "n"],
      ],
      secrets: [[/API key/, API_KEY]],
    });
    expect(await setup(h.io, repo.dir)).toBe(0);
    expect(h.out.stdout).toMatch(/✗ +7\. Model credential · ANTHROPIC_API_KEY is not stored/);
    expect(state.variables.get("ANTHROPIC_API_KEY")?.value).toBe(API_KEY);
    expect(h.out.asked).toHaveLength(4);
    expectNoSecret(h.out);
  });

  test("a refused write prints where to paste the value, never the value", async () => {
    const repo = kbRepo("bitbucket");
    const state = newState();
    state.refuseWrites = true;
    const h = harness({
      host: "bitbucket",
      state,
      answers: [
        [/account email/, ""],
        [/same token for these writes/, "y"],
      ],
      secrets: [[/HOMEOSTAT_BITBUCKET_TOKEN/, TOKEN]],
    });
    expect(await setup(h.io, repo.dir, "--step", "host")).toBe(0);
    expect(await setup(h.io, repo.dir, "--step", "token")).toBe(1);
    expect(h.out.stdout).toContain("403");
    expect(h.out.stdout).toContain(
      "https://bitbucket.org/acme/team-kb/admin/pipelines/repository-variables",
    );
    expect(h.out.stdout).toContain("name HOMEOSTAT_BITBUCKET_TOKEN");
    expectNoSecret(h.out);
  });

  test("a pasted-twice token is refused, and a wrong one is not stored", async () => {
    const repo = kbRepo("bitbucket");
    const h = harness({
      host: "bitbucket",
      answers: [[/account email/, ""]],
      secrets: [
        [/HOMEOSTAT_BITBUCKET_TOKEN/, `${TOKEN}${TOKEN}`],
        [/HOMEOSTAT_BITBUCKET_TOKEN/, "wrong-token-value"],
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
});

describe("homeostat setup on GitHub", () => {
  const answers: [RegExp, string][] = [
    [/Git-host token for CI: cannot check/, "y"],
    [/Code repos the daily run reads/, "https://github.com/acme/web-app"],
    [/Areas per repo is optional/, "n"],
    [/Which one is you/, "ada"],
    [/Who else joins/, ""],
    [/Reviewers is optional/, "n"],
    [/Runtime/, "api"],
    [/Slack is optional/, "n"],
    [/CODEOWNERS and branch protection is optional/, "n"],
    [/First base is optional/, "n"],
    [/Teammates is optional/, "n"],
  ];
  const secrets: [RegExp, string][] = [
    [/HOMEOSTAT_GITHUB_TOKEN/, GH_TOKEN],
    [/API key/, API_KEY],
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
    expect(h.gh.secrets.get("HOMEOSTAT_GITHUB_TOKEN")).toBe(GH_TOKEN);
    expect(h.gh.secrets.get("ANTHROPIC_API_KEY")).toBe(API_KEY);
    expect(h.out.calls).toContain("gh secret set ANTHROPIC_API_KEY -R acme/team-kb");
    expect(h.out.calls.join("\n")).not.toContain(API_KEY);
    expect(existsSync(join(repo.dir, ".github/workflows/homeostat-curator.yml"))).toBe(true);
    expect(h.out.stdout).toMatch(/✓ +9\. Schedules/);
    expectNoSecret(h.out);
  });

  test("without gh it prints the exact command, and nothing is stored", async () => {
    const repo = kbRepo("github");
    const h = harness({
      host: "github",
      gh: { installed: false, secrets: new Map() },
      secrets: [[/HOMEOSTAT_GITHUB_TOKEN/, GH_TOKEN]],
    });
    await setup(h.io, repo.dir, "--step", "host");
    expect(await setup(h.io, repo.dir, "--step", "token")).toBe(1);
    expect(h.out.stdout).toContain("gh secret set HOMEOSTAT_GITHUB_TOKEN -R acme/team-kb");
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
    expect(h.out.stdout).toContain("token: HOMEOSTAT_BITBUCKET_TOKEN");
  });

  test("--check says which required steps it could not check, and why, without failing", async () => {
    const { repo, h: first } = await bitbucketDone();
    first.state.refuseReads = true;
    const h = harness({ host: "bitbucket", state: first.state, env: envFor });
    expect(await setup(h.io, repo.dir, "--check")).toBe(0);
    expect(h.out.stdout).toMatch(/\? +2\. Git-host token for CI · .*403, needs repo admin to read/);
    expect(h.out.stdout).toMatch(/\? +9\. Schedules · 403, needs repo admin to read/);
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
    expect(b.out.stdout).toMatch(
      /✓ +2\. Git-host token for CI · HOMEOSTAT_BITBUCKET_TOKEN is stored/,
    );
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
