import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BitbucketProvider,
  CONFIG_FILE,
  type Config,
  type ConfigEdit,
  editConfig,
  GitHubProvider,
  type HostSetup,
  type KbFiles,
  localSetupChecks,
  ProviderError,
  parseConfig,
  type RepoRef,
  readKbFiles,
  type SetupCheck,
  type SetupStepInfo,
} from "@homeostat/core";
import type { HostAuth, Io, SpawnResult } from "../cli.ts";
import { painter } from "../format.ts";
import { BITBUCKET_USER_VAR, TOKEN_VARS } from "../provider.ts";

export type Host = "bitbucket" | "github";

/** One step of the checklist: how to tell whether it is done, and how to do it. */
export interface Step {
  info: SetupStepInfo;
  detect(ctx: SetupContext): Promise<SetupCheck>;
  run(ctx: SetupContext): Promise<void>;
  /** Without a terminal: which flags or environment variables supply what it would ask. */
  supply?: string;
}

export interface SetupFlags {
  host?: string;
  repo?: string[];
  runtime?: string;
}

/** The CI variable names the pipelines and workflows read. */
export const TOKEN_VAR: Record<Host, string> = {
  bitbucket: "HOMEOSTAT_BITBUCKET_TOKEN",
  github: "HOMEOSTAT_GITHUB_TOKEN",
};
export const EMAIL_VAR = BITBUCKET_USER_VAR;
export const DEFAULT_SLACK_VAR = "HOMEOSTAT_SLACK_WEBHOOK";

/**
 * A secret as pasted: trimmed, and refused when it holds whitespace or line breaks inside, or is
 * the same value twice, which is how a token pasted by hand most often goes wrong. The message
 * never repeats the value.
 */
export function cleanSecret(raw: string): { value: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: "nothing entered" };
  if (/\s/.test(value))
    return { error: "it holds spaces or line breaks: paste the value once, on its own" };
  const half = value.length / 2;
  if (value.length >= 16 && Number.isInteger(half) && value.slice(0, half) === value.slice(half))
    return { error: "it looks pasted twice (the same value repeated): paste it once" };
  return { value };
}

export const parseRepoRef = (s: string): RepoRef | undefined => {
  const [owner, name, ...rest] = s.split("/");
  return owner && name && rest.length === 0 ? { owner, name } : undefined;
};

export const repoUrl = (host: Host, repo: string) =>
  host === "github" ? `https://github.com/${repo}` : `https://bitbucket.org/${repo}`;

/**
 * What every step shares: the KB folder, the prompts, the secrets typed in this run (kept in
 * memory only, and scrubbed from every line printed), and the git-host clients they unlock.
 */
export class SetupContext {
  readonly root: string;
  readonly io: Io;
  readonly flags: SetupFlags;
  readonly paint: ReturnType<typeof painter>;
  /** The git-host token verified in this run (or taken from the environment). */
  auth: HostAuth | undefined;
  /** A token for the admin-only writes (variables, schedules), when it differs from `auth`. */
  admin: HostAuth | undefined;
  /** The model credential typed in this run, for a first base built right away. */
  modelKey: string | undefined;
  /** Set once the join command was shown. */
  shared = false;
  private readonly secrets: string[] = [];
  private gh: boolean | undefined;
  private readonly given: Io;

  constructor(root: string, io: Io, flags: SetupFlags = {}) {
    this.root = root;
    this.given = io;
    this.flags = flags;
    this.paint = painter(io);
    const scrub = (t: string) => this.redact(t);
    this.io = { ...io, stdout: (t) => io.stdout(scrub(t)), stderr: (t) => io.stderr(scrub(t)) };
  }

  /** Replaces every secret seen in this run, so no value is ever printed. */
  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) if (s) out = out.split(s).join("***");
    return out;
  }

  remember(secret: string) {
    if (secret && !this.secrets.includes(secret)) this.secrets.push(secret);
  }

  say(text = "") {
    this.io.stdout(`${text}\n`);
  }

  get interactive(): boolean {
    return Boolean(this.given.ask);
  }

  async ask(question: string, fallback = ""): Promise<string> {
    if (!this.given.ask) return fallback;
    const answer = (await this.given.ask(fallback ? `${question} [${fallback}]` : question)).trim();
    return answer || fallback;
  }

  async yes(question: string, fallback = false): Promise<boolean> {
    const answer = await this.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`);
    if (!answer) return fallback;
    return /^y(es)?$/i.test(answer);
  }

  /**
   * A secret from `envVar` if set, else typed hidden. Three tries at a clean value; undefined when
   * there is no terminal or no clean value.
   */
  async secret(question: string, envVar?: string): Promise<string | undefined> {
    const fromEnv = envVar ? this.given.env?.[envVar] : undefined;
    if (fromEnv) {
      const c = cleanSecret(fromEnv);
      if ("value" in c) {
        this.remember(c.value);
        this.say(`  using ${envVar} from the environment`);
        return c.value;
      }
      this.say(`  ${envVar} in the environment is not usable: ${c.error}`);
    }
    if (!this.given.secret) {
      this.say("  cannot read a secret without a terminal");
      return undefined;
    }
    for (let i = 0; i < 3; i++) {
      const raw = await this.given.secret(`${question} (input hidden)`);
      const c = cleanSecret(raw);
      if ("value" in c) {
        this.remember(c.value);
        return c.value;
      }
      this.remember(raw.trim());
      this.say(`  ${this.paint("red", "✗")} ${c.error}`);
    }
    return undefined;
  }

  // ---- the config ----

  files(): KbFiles {
    return readKbFiles(this.root);
  }

  configText(): string | undefined {
    const path = join(this.root, CONFIG_FILE);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  config(): Config | undefined {
    const text = this.configText();
    return text === undefined ? undefined : parseConfig(text).config;
  }

  /** Edits homeostat.yaml in place (comments survive); refuses an edit that makes it invalid. */
  edit(edits: ConfigEdit[]): boolean {
    const text = this.configText();
    if (text === undefined) return false;
    const next = editConfig(text, edits);
    const { config, issues } = parseConfig(next);
    if (!config) {
      const first = issues.find((i) => i.severity === "error");
      this.say(`  ${this.paint("red", "✗")} not saved: ${first?.message ?? "invalid config"}`);
      return false;
    }
    writeFileSync(join(this.root, CONFIG_FILE), next);
    return true;
  }

  local(): ReturnType<typeof localSetupChecks> {
    return localSetupChecks(this.root, this.files());
  }

  host(): Host | undefined {
    return this.config()?.sources?.host;
  }

  kbRepo(): RepoRef | undefined {
    const kb = this.config()?.sources?.kbRepo;
    return kb ? parseRepoRef(kb) : undefined;
  }

  codeRepos(): string[] {
    const c = this.config();
    if (!c) return [];
    return [
      ...new Set([
        ...(c.sources?.repos ?? []),
        ...Object.values(c.repos ?? {}).map((r) => r.source),
      ]),
    ];
  }

  // ---- the git host ----

  client(host: Host, auth: HostAuth): HostSetup {
    if (this.given.hostSetup) return this.given.hostSetup(host, auth);
    const opts = {
      token: auth.token,
      ...(auth.user ? { user: auth.user } : {}),
      ...(this.given.fetch ? { fetch: this.given.fetch } : {}),
    };
    return host === "bitbucket" ? new BitbucketProvider(opts) : new GitHubProvider(opts);
  }

  /** The token from this run, else from the environment; never prompts. */
  envAuth(host: Host): HostAuth | undefined {
    if (this.auth) return this.auth;
    const vars: readonly string[] = TOKEN_VARS[host];
    const token = vars.map((v) => this.given.env?.[v]).find(Boolean);
    if (!token) return undefined;
    this.remember(token);
    const user = host === "bitbucket" ? this.given.env?.[EMAIL_VAR] : undefined;
    return { token, ...(user ? { user } : {}) };
  }

  /** A client to read with, if a token is at hand; never prompts. */
  reader(): HostSetup | undefined {
    const host = this.host();
    const auth = host ? this.envAuth(host) : undefined;
    return host && auth ? this.client(host, auth) : undefined;
  }

  /** A client to read with, asking for a token (verified, not stored) when there is none. */
  async ensureReader(): Promise<HostSetup | undefined> {
    const ready = this.reader();
    if (ready) return ready;
    const host = this.host();
    const kb = this.kbRepo();
    if (!host || !kb || !this.interactive) return undefined;
    this.say(`  Setup reads ${host} with a token. It is kept in memory for this run only.`);
    const auth = await this.askAuth(host, "Git-host token to read with");
    if (!auth) return undefined;
    try {
      await this.client(host, auth).getRepository(kb);
    } catch (e) {
      this.say(`  ${this.paint("red", "✗")} ${describeError(e)}`);
      return undefined;
    }
    this.auth = auth;
    return this.client(host, auth);
  }

  async askAuth(host: Host, question: string): Promise<HostAuth | undefined> {
    const token = await this.secret(question);
    if (!token) return undefined;
    if (host === "github") return { token };
    const user = await this.ask(
      "  Atlassian account email, for an API token (empty for a workspace access token)",
    );
    return { token, ...(user ? { user } : {}) };
  }

  /**
   * The client for admin-only writes. Storing a variable or a schedule needs admin access to the
   * KB repo, which the CI token usually lacks, so this asks once whether to use it anyway or a
   * separate token for these writes only (never stored).
   */
  async adminClient(): Promise<HostSetup | undefined> {
    const host = this.host();
    if (!host) return undefined;
    if (this.admin) return this.client(host, this.admin);
    const read = this.envAuth(host);
    if (!this.interactive) return read ? this.client(host, read) : undefined;
    const same =
      read &&
      (await this.yes(
        "  Storing CI variables needs admin access to the KB repo. Use the same token for these writes?",
        true,
      ));
    if (same && read) {
      this.admin = read;
    } else {
      const auth = await this.askAuth(host, "Admin token for these writes only (not stored)");
      if (!auth) return undefined;
      this.admin = auth;
    }
    return this.client(host, this.admin);
  }

  // ---- programs ----

  async run(command: string, args: string[], input?: string): Promise<SpawnResult> {
    if (!this.given.spawn) return { code: 127, stdout: "", stderr: `${command}: not available` };
    return this.given.spawn(command, args, {
      ...(input === undefined ? {} : { input }),
      cwd: this.root,
    });
  }

  /** Whether `gh` is installed and logged in. */
  async hasGh(): Promise<boolean> {
    if (this.gh === undefined) this.gh = (await this.run("gh", ["auth", "status"])).code === 0;
    return this.gh;
  }

  // ---- secrets in CI ----

  /** Whether the CI variable or secret exists; undefined when that cannot be checked from here. */
  async secretExists(name: string): Promise<boolean | undefined> {
    const host = this.host();
    const kb = this.kbRepo();
    if (!host || !kb) return undefined;
    try {
      if (host === "github") {
        if (await this.hasGh()) {
          const r = await this.run("gh", [
            "secret",
            "list",
            "-R",
            `${kb.owner}/${kb.name}`,
            "--json",
            "name",
          ]);
          if (r.code === 0)
            return (JSON.parse(r.stdout) as { name: string }[]).some((s) => s.name === name);
        }
        const api = this.reader();
        if (!api?.listSecretNames) return undefined;
        return (await api.listSecretNames(kb)).includes(name);
      }
      const auth = this.admin ?? this.envAuth(host);
      const api = auth ? this.client(host, auth) : undefined;
      if (!api?.listVariables) return undefined;
      return (await api.listVariables(kb)).some((v) => v.key === name);
    } catch {
      return undefined;
    }
  }

  /**
   * Stores a verified secret where CI reads it. Bitbucket: a secured repository variable through
   * the Pipelines API. GitHub: `gh secret set` with the value on stdin. If that is refused, or `gh`
   * is missing, it prints where to paste the value by hand, never the value itself.
   */
  async storeSecret(name: string, value: string, secured = true): Promise<boolean> {
    const host = this.host();
    const kb = this.kbRepo();
    if (!host || !kb) return false;
    const full = `${kb.owner}/${kb.name}`;
    const ok = (where: string) => {
      this.say(`  ${this.paint("green", "✓")} stored ${name} ${where}`);
      return true;
    };
    if (host === "github") {
      if (await this.hasGh()) {
        const r = await this.run("gh", ["secret", "set", name, "-R", full], value);
        if (r.code === 0) return ok(`as an Actions secret on ${full}`);
        this.say(
          `  ${this.paint("red", "✗")} gh could not store ${name}: ${firstLine(r.stderr) || `exit ${r.code}`}`,
        );
      } else {
        this.say("  gh is not installed or not logged in, so setup cannot store Actions secrets.");
      }
      this.say(
        `  Store it yourself: run  gh secret set ${name} -R ${full}  and paste the value when asked,\n  or add it at ${repoUrl(host, full)}/settings/secrets/actions (New repository secret).`,
      );
      return false;
    }
    const api = await this.adminClient();
    if (api?.setVariable) {
      try {
        await api.setVariable(kb, name, value, secured);
        return ok(`as a ${secured ? "secured " : ""}repository variable on ${full}`);
      } catch (e) {
        this.say(`  ${this.paint("red", "✗")} could not store ${name}: ${describeError(e)}`);
      }
    }
    this.say(
      `  Add it by hand at ${repoUrl(host, full)}/admin/pipelines/repository-variables\n  (Repository settings > Pipelines > Repository variables): name ${name}, paste the value you just entered${secured ? ", tick Secured" : ""}.`,
    );
    return false;
  }
}

export const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 200) ?? "";

/** A short reason for a failed call: the status and what it means, never a header or a value. */
export function describeError(e: unknown): string {
  if (e instanceof ProviderError) {
    if (e.status === 401) return "401: the token was rejected (wrong token, or expired)";
    if (e.status === 403) return "403: the token lacks the access this needs";
    if (e.status === 404) return "404: not found, or the token cannot see it";
    return `${e.provider} answered ${e.status}`;
  }
  return e instanceof Error ? firstLine(e.message) : "failed";
}

export const errorStatus = (e: unknown): number | undefined =>
  e instanceof ProviderError ? e.status : undefined;
