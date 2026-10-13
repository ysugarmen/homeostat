import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BitbucketProvider,
  CORE_AREA,
  type Config,
  countTokens,
  type Frontmatter,
  formatEntry,
  GitHubProvider,
  ID_PATTERN,
  type Provider,
  type RepoRef,
  type ReviewComment,
  score,
  validate,
} from "@kbx/core";

import type { Io } from "./cli.ts";
import { readKbFiles } from "./files.ts";
import { formatIssues } from "./format.ts";
import { commitFile, existsOnRef, git, pushBranch } from "./git.ts";
import { memberIdFrom } from "./init.ts";

export interface LearnOptions {
  dir: string;
  title?: string;
  rule?: string;
  why?: string;
  area?: string;
  scope?: string[];
  author?: string;
  owner?: string;
  id?: string;
  tag?: string[];
  exampleFile?: string;
  /** `manual` (default) or `agent-handoff`; a comment URL always means `pr-feedback`. */
  source?: string;
  /** Commit the entry to this branch of the KB repo instead of writing it to the working tree. */
  branch?: string;
  push?: boolean;
}

const HAND_SOURCES = ["manual", "agent-handoff"] as const;

export interface CommentRef {
  host: "bitbucket" | "github";
  repo: RepoRef;
  pullRequest: number;
  comment: number;
}

class LearnError extends Error {}

/** Parses a Bitbucket `#comment-N` or GitHub `#discussion_rN` PR comment link. */
export function parseCommentUrl(url: string): CommentRef {
  const bb =
    /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)[^#]*#comment-(\d+)$/.exec(
      url,
    );
  if (bb) {
    const [, owner = "", name = "", pr = "", comment = ""] = bb;
    return { host: "bitbucket", repo: { owner, name }, pullRequest: +pr, comment: +comment };
  }
  const gh =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)[^#]*#(discussion_r|issuecomment-)(\d+)$/.exec(
      url,
    );
  if (gh) {
    const [, owner = "", name = "", pr = "", kind, comment = ""] = gh;
    if (kind === "issuecomment-") {
      throw new LearnError(
        "only review comments (on a line of the diff) are supported; this is a general PR comment",
      );
    }
    return { host: "github", repo: { owner, name }, pullRequest: +pr, comment: +comment };
  }
  throw new LearnError(`not a Bitbucket or GitHub PR comment URL: ${url}`);
}

const TOKEN_VARS = {
  bitbucket: ["KBX_BITBUCKET_TOKEN"],
  github: ["KBX_GITHUB_TOKEN", "GITHUB_TOKEN"],
};

function providerFor(ref: CommentRef, io: Io): Provider {
  const vars = TOKEN_VARS[ref.host];
  const token = vars.map((v) => io.env?.[v]).find(Boolean);
  if (!token) throw new LearnError(`set ${vars.join(" or ")} to read ${ref.host} comments`);
  const opts = { token, ...(io.fetch ? { fetch: io.fetch } : {}) };
  return ref.host === "bitbucket" ? new BitbucketProvider(opts) : new GitHubProvider(opts);
}

interface FetchedComment {
  comment: ReviewComment;
  /** Some commit on the PR is later than the comment: the +3 signal, at PR granularity. */
  changedCode: boolean;
}

async function fetchComment(ref: CommentRef, io: Io): Promise<FetchedComment> {
  const provider = providerFor(ref, io);
  const comments = await provider.listReviewComments(ref.repo, ref.pullRequest);
  const comment = comments.find((c) => c.id === ref.comment);
  if (!comment) throw new LearnError(`comment ${ref.comment} not found on PR ${ref.pullRequest}`);
  const commits = await provider.listCommits(ref.repo, ref.pullRequest);
  const at = Date.parse(comment.createdAt);
  return { comment, changedCode: commits.some((c) => Date.parse(c.date) > at) };
}

export const slugify = (text: string) => memberIdFrom(text).slice(0, 60).replace(/-+$/, "");

function loadConfig(files: Record<string, string>): Config {
  const result = validate(files);
  if (!result.config) {
    throw new LearnError("kbx.yaml is missing or invalid; run kbx validate to see why");
  }
  return result.config;
}

/** `kbx learn [url]`: writes one candidate entry, from flags, prompts or a PR comment. */
export async function runLearn(
  url: string | undefined,
  opts: LearnOptions,
  io: Io,
): Promise<number> {
  try {
    return await learn(url, opts, io);
  } catch (e) {
    if (e instanceof LearnError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function learn(url: string | undefined, opts: LearnOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir);
  const files = readKbFiles(root);
  const config = loadConfig(files);

  if (opts.push && !opts.branch) throw new LearnError("--push needs --branch");
  if (opts.source !== undefined) {
    if (url) throw new LearnError("a comment URL sets the source itself; drop --source");
    if (!HAND_SOURCES.includes(opts.source as (typeof HAND_SOURCES)[number])) {
      throw new LearnError(`--source must be ${HAND_SOURCES.join(" or ")}`);
    }
  }

  let source: Frontmatter["source"] = {
    type: (opts.source as (typeof HAND_SOURCES)[number] | undefined) ?? "manual",
    author: "",
  };
  let author = opts.author;
  if (url) {
    const ref = parseCommentUrl(url);
    const { comment, changedCode } = await fetchComment(ref, io);
    io.stdout(`${comment.author.name ?? comment.author.id} on ${comment.path ?? "the PR"}:\n`);
    io.stdout(`${comment.body.replace(/^/gm, "> ")}\n\n`);
    if (!author) {
      const handle = `@${comment.author.id}`;
      author = config.team.members.find((m) => m.handle === handle)?.id;
      if (!author) throw new LearnError(`no member has handle "${handle}"; pass --author`);
    }
    source = { type: "pr-feedback", url, author, changedCode };
  }

  const fields = { title: opts.title, rule: opts.rule, why: opts.why };
  const missing = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => !fields[k]);
  let area = opts.area;
  if (missing.length > 0 && io.ask) {
    const labels = { title: "Title", rule: "Rule (one paragraph)", why: "Why" };
    for (const key of missing) fields[key] = (await io.ask(labels[key])).trim();
    if (!area) area = (await io.ask(`Area [${CORE_AREA}]`)).trim() || undefined;
  }
  // Without --author or a PR comment, fall back to the git user if they are a member.
  author ??= memberIdFrom(git(root, "config", "user.name"));
  const stillMissing: string[] = Object.entries(fields)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (!opts.author && !config.team.members.some((m) => m.id === author)) {
    stillMissing.push("author");
  }
  if (stillMissing.length > 0) {
    throw new LearnError(`missing ${stillMissing.map((k) => `--${k}`).join(", ")}`);
  }
  area ??= CORE_AREA;

  const id = opts.id ?? slugify(fields.title ?? "");
  if (!ID_PATTERN.test(id)) throw new LearnError(`cannot derive an id from the title; pass --id`);
  const path = `knowledge/${area}/${id}.md`;
  if (opts.branch ? existsOnRef(root, opts.branch, path) : existsSync(join(root, path))) {
    throw new LearnError(
      `${path} already exists${opts.branch ? ` on ${opts.branch}` : ""}; pass --id`,
    );
  }

  const example = opts.exampleFile ? readFileSync(opts.exampleFile, "utf8").trim() : undefined;
  const body = [
    `## Rule\n${fields.rule}`,
    `## Why\n${fields.why}`,
    ...(example ? [`## Example\n${example}`] : []),
  ].join("\n\n");

  const today = (io.now?.() ?? new Date()).toISOString().slice(0, 10);
  const frontmatter: Frontmatter = {
    id,
    title: fields.title ?? "",
    area,
    scope: opts.scope?.length ? opts.scope : (config.areas[area] ?? ["**"]),
    status: "candidate",
    score: 0,
    owner: opts.owner ?? author,
    source: { ...source, author },
    created: today,
    lastConfirmed: today,
    ...(opts.tag?.length ? { tags: opts.tag } : {}),
    tokens: countTokens(body),
  };
  frontmatter.score = score(frontmatter, { config }).score;
  const text = formatEntry(frontmatter, body);

  const issues = validate({ ...files, [path]: text }).issues.filter(
    (i) => i.file === path && i.severity === "error",
  );
  if (issues.length > 0) {
    io.stdout(`${formatIssues(issues, io).text}nothing written\n`);
    return 1;
  }

  const summary = `(candidate, score ${frontmatter.score})`;
  if (opts.branch) {
    try {
      commitFile(root, opts.branch, path, text, `kbx: candidate ${id}`);
      io.stdout(`committed ${path} to ${opts.branch} ${summary}\n`);
      if (opts.push) {
        pushBranch(root, opts.branch);
        io.stdout(`pushed ${opts.branch} to origin\n`);
      }
    } catch (e) {
      throw new LearnError((e as Error).message);
    }
    return 0;
  }

  const full = join(root, ...path.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  io.stdout(
    `created ${path} ${summary}\n` +
      "Commit it on a branch and open a PR to the KB repo; a reviewer accepts it there.\n",
  );
  return 0;
}
