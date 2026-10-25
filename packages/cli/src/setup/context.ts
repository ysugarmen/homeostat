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
import type { HostAuth, Io, SpawnOptions, SpawnResult } from "../cli.ts";
import { painter } from "../format.ts";
import { guide } from "../init.ts";
import { envAuth, GIT_EMAIL_VAR, GIT_TOKEN_VAR } from "../provider.ts";

export type Host = "bitbucket" | "github";

export const HOST_NAME: Record<Host, string> = { bitbucket: "Bitbucket", github: "GitHub" };

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

/** The CI variable names setup stores; the pipelines and workflows read them. */
export const TOKEN_VAR = GIT_TOKEN_VAR;
export const EMAIL_VAR = GIT_EMAIL_VAR;
export const DEFAULT_SLACK_VAR = "HOMEOSTAT_SLACK_WEBHOOK";

/** What a hidden prompt says, so nobody pastes a token anywhere but the terminal. */
export const PASTE_HINT = "then press Enter (nothing shows while you paste)";

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

/** A numbered menu's option: what it is called, and what picking it means. */
export interface Choice<T extends string> {
  value: T;
  label: string;
}

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
  /**
   * CI variables and schedules written in this run. They count as present for the rest of the
   * run: the host's lists lag behind a write, so listing again right after would say "missing".
   */
  readonly storedNow = new Set<string>();
  readonly scheduledNow = new Set<string>();
  private readonly secrets: string[] = [];
  private gh: boolean | undefined;
  private adminAsked = false;
  /** Why the last check of the CI variables or secrets could not answer. */
  ciUnreadable = "no token yet to read the CI variables with";
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

  ok(text: string) {
    this.say(`  ${this.paint("green", "✓")} ${text}`);
  }

  bad(text: string) {
    this.say(`  ${this.paint("red", "✗")} ${text}`);
  }

  get interactive(): boolean {
    return Boolean(this.given.ask);
  }

  /** One question; the default, if any, shows in brackets and is taken on an empty answer. */
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
   * A numbered menu: the question, one line per option, then the number to type, with `current`
   * as the default. A number or an option's value is accepted; three tries.
   */
  async choose<T extends string>(
    question: string,
    options: readonly Choice<T>[],
    current?: T,
  ): Promise<T | undefined> {
    if (!this.interactive) return undefined;
    this.say(`  ${question}`);
    options.forEach((o, i) => {
      this.say(`    ${i + 1}) ${o.label}`);
    });
    const at = options.findIndex((o) => o.value === current);
    const fallback = at >= 0 ? String(at + 1) : "";
    for (let i = 0; i < 3; i++) {
      const answer = (await this.ask(`  Number (1-${options.length})`, fallback)).toLowerCase();
      const n = Number(answer);
      const picked =
        (Number.isInteger(n) ? options[n - 1] : undefined) ??
        options.find((o) => o.value === answer);
      if (picked) return picked.value;
      this.say(`  Type a number from 1 to ${options.length}.`);
    }
    return undefined;
  }

  /**
   * A secret from the first of `envVars` that is set, else pasted hidden. `what` names it in the
   * prompt ("the GitHub token"). Three tries at a clean value; undefined when there is no terminal,
   * no clean value, or, with `optional`, an empty answer.
   */
  async secret(
    what: string,
    envVars: string | readonly string[] = [],
    opts: { optional?: boolean } = {},
  ): Promise<string | undefined> {
    for (const envVar of typeof envVars === "string" ? [envVars] : envVars) {
      const fromEnv = this.given.env?.[envVar];
      if (!fromEnv) continue;
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
    const skip = opts.optional ? "; empty to skip" : "";
    for (let i = 0; i < 3; i++) {
      const raw = await this.given.secret(`  Paste ${what}, ${PASTE_HINT}${skip}`);
      if (opts.optional && !raw.trim()) return undefined;
      const c = cleanSecret(raw);
      if ("value" in c) {
        this.remember(c.value);
        this.ok("received");
        return c.value;
      }
      this.remember(raw.trim());
      this.bad(c.error);
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
      this.bad(`not saved: ${first?.message ?? "invalid config"}`);
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

  /** The token from this run, else from the environment (new or old names); never prompts. */
  envAuth(host: Host): HostAuth | undefined {
    if (this.auth) return this.auth;
    const found = envAuth(host, this.given.env);
    if (!found) return undefined;
    this.remember(found.token);
    return { token: found.token, ...(found.user ? { user: found.user } : {}) };
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
    this.say(`  Setup reads ${HOST_NAME[host]} with your token, kept in memory for this run only.`);
    const auth = await this.askAuth(host, `your ${HOST_NAME[host]} token`);
    if (!auth) return undefined;
    try {
      await this.client(host, auth).getRepository(kb);
    } catch (e) {
      this.bad(describeError(e));
      return undefined;
    }
    this.auth = auth;
    return this.client(host, auth);
  }

  /** The email that makes a Bitbucket token an Atlassian API token; empty for an access token. */
  async askEmail(): Promise<string> {
    return this.ask(
      "  Email of the Atlassian account that created this token (example: you@company.com; leave empty for a workspace access token)",
    );
  }

  async askAuth(
    host: Host,
    what: string,
    opts: { optional?: boolean } = {},
  ): Promise<HostAuth | undefined> {
    const token = await this.secret(what, [], opts);
    if (!token) return undefined;
    if (host === "github") return { token };
    const user = await this.askEmail();
    return { token, ...(user ? { user } : {}) };
  }

  /**
   * The client for admin-only writes (CI variables, schedules): the token from this run or the
   * environment, else one asked for. When that token is refused for lack of admin, `withAdmin`
   * asks once for a separate admin token, kept in memory for this run only.
   */
  async adminClient(): Promise<HostSetup | undefined> {
    const host = this.host();
    if (!host) return undefined;
    if (this.admin) return this.client(host, this.admin);
    const read = this.envAuth(host);
    if (read) return this.client(host, read);
    const admin = await this.askAdmin();
    return admin ? this.client(host, admin) : undefined;
  }

  private async askAdmin(): Promise<HostAuth | undefined> {
    const host = this.host();
    if (!host || !this.interactive || this.adminAsked) return undefined;
    this.adminAsked = true;
    this.say(
      `  Storing CI variables and schedules needs a token with admin on the KB repo. It is used for this run only, not stored.`,
    );
    const auth = await this.askAuth(host, "a token with admin on the KB repo", { optional: true });
    if (auth) this.admin = auth;
    return auth;
  }

  /** Runs an admin-only write; on a 403 asks once for an admin token and tries again with it. */
  async withAdmin<T>(write: (api: HostSetup) => Promise<T>): Promise<T> {
    const host = this.host();
    const api = await this.adminClient();
    if (!host || !api) throw new Error("no token to write with");
    try {
      return await write(api);
    } catch (e) {
      if (errorStatus(e) !== 403 || this.admin || this.adminAsked || !this.interactive) throw e;
      this.bad("403: this token cannot do that; it needs admin on the KB repo.");
      const admin = await this.askAdmin();
      if (!admin) throw e;
      return write(this.client(host, admin));
    }
  }

  // ---- programs ----

  async run(
    command: string,
    args: string[],
    input?: string,
    opts: Omit<SpawnOptions, "input" | "cwd"> = {},
  ): Promise<SpawnResult> {
    if (!this.given.spawn) return { code: 127, stdout: "", stderr: `${command}: not available` };
    return this.given.spawn(command, args, {
      ...opts,
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

  /**
   * The first of `names` that exists as a CI variable or secret; false when none does; undefined
   * when that cannot be checked from here.
   */
  async secretPresent(names: readonly string[]): Promise<string | false | undefined> {
    const host = this.host();
    const kb = this.kbRepo();
    if (!host || !kb) return undefined;
    const pick = (have: string[]) => names.find((n) => have.includes(n)) ?? false;
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
            return pick((JSON.parse(r.stdout) as { name: string }[]).map((s) => s.name));
        }
        const api = this.reader();
        if (!api?.listSecretNames) return undefined;
        return pick(await api.listSecretNames(kb));
      }
      const auth = this.admin ?? this.envAuth(host);
      const api = auth ? this.client(host, auth) : undefined;
      if (!api?.listVariables) return undefined;
      return pick((await api.listVariables(kb)).map((v) => v.key));
    } catch (e) {
      this.ciUnreadable = `${describeError(e)}${adminHint(host, e)}`;
      return undefined;
    }
  }

  /** Whether the CI variable or secret exists; undefined when that cannot be checked from here. */
  async secretExists(name: string): Promise<boolean | undefined> {
    const found = await this.secretPresent([name]);
    return found === undefined ? undefined : found === name;
  }

  /**
   * A stored secret's checklist state. Stored in this run counts as done without asking the host
   * again. An old name (`legacy`) still counts, with a nudge to rename it.
   */
  async secretState(name: string, legacy?: string): Promise<SetupCheck> {
    if (this.storedNow.has(name)) return { state: "done", reason: `${name} stored just now` };
    const found = await this.secretPresent(legacy ? [name, legacy] : [name]);
    if (found === name) return { state: "done", reason: `${name} is stored` };
    if (found)
      return {
        state: "done",
        reason: `${found} is stored: works; consider renaming to ${name}`,
      };
    if (found === false) return { state: "missing", reason: `${name} is not stored` };
    return {
      state: "unknown",
      reason: `cannot tell whether ${name} is stored: ${this.ciUnreadable}`,
    };
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
      this.ok(`stored ${name} ${where}`);
      this.storedNow.add(name);
      return true;
    };
    if (host === "github") {
      if (await this.hasGh()) {
        const r = await this.run("gh", ["secret", "set", name, "-R", full], value);
        if (r.code === 0) return ok(`as an Actions secret on ${full}`);
        this.bad(`gh could not store ${name}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
      } else {
        this.say("  gh is not installed or not logged in, so setup cannot store Actions secrets.");
      }
      this.say(
        `  Store it yourself: run  gh secret set ${name} -R ${full}  and paste the value when asked,\n  or add it at ${repoUrl(host, full)}/settings/secrets/actions (New repository secret).`,
      );
      return false;
    }
    try {
      await this.withAdmin(async (api) => {
        if (!api.setVariable) throw new Error("this client cannot store variables");
        await api.setVariable(kb, name, value, secured);
      });
      return ok(`as a ${secured ? "secured " : ""}repository variable on ${full}`);
    } catch (e) {
      this.bad(`could not store ${name}: ${describeError(e)}`);
    }
    this.say(
      `  Add it by hand at ${repoUrl(host, full)}/admin/pipelines/repository-variables\n  (Repository settings > Pipelines > Repository variables): name ${name}, paste the value you just entered${secured ? ", tick Secured" : ""}.`,
    );
    return false;
  }
}

export const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 200) ?? "";

/**
 * Reading CI variables and schedules needs more than the daily run's token has: say what, so a
 * 403 is not mistaken for a broken token.
 */
export function adminHint(host: string | undefined, e: unknown): string {
  if (!(e instanceof ProviderError) || e.status !== 403) return "";
  return host === "bitbucket" || host === "github" ? NEEDS_ADMIN : "";
}

/** The short form in a checklist row; `adminNote` explains it once below the list. */
export const NEEDS_ADMIN = ", needs repo admin to read";

export function adminNote(host: string | undefined): string {
  return host === "github"
    ? `Needs repo admin to read: listing Actions secrets needs admin on the KB repo. Log in to gh as an admin, or check them in Settings > Secrets. The daily run itself does not need it. More: ${guide("git-host-token")}`
    : `Needs repo admin to read: listing pipeline variables and schedules needs admin:pipeline:bitbucket on the KB repo. The daily run itself does not need it. Check them in Repository settings > Pipelines, or rerun with an admin token. More: ${guide("git-host-token")}`;
}

/** A short reason for a failed call: the status and what it means, never a header or a value. */
export function describeError(e: unknown): string {
  if (e instanceof ProviderError) {
    if (e.status === 401) return "401: the token was rejected (wrong token, or expired)";
    if (e.status === 403) return "403";
    if (e.status === 404) return "404: not found, or the token cannot see it";
    return `${e.provider} answered ${e.status}`;
  }
  return e instanceof Error ? firstLine(e.message) : "failed";
}

export const errorStatus = (e: unknown): number | undefined =>
  e instanceof ProviderError ? e.status : undefined;
