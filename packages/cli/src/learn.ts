import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  applySectionPatch,
  CORE_AREA,
  type CommentRef,
  CommentUrlError,
  type Config,
  countTokens,
  type Frontmatter,
  formatEntry,
  ID_PATTERN,
  type KbFiles,
  type Kind,
  logEvent,
  PatchError,
  parseCommentUrl,
  type RepoRef,
  type ReviewComment,
  readKbView,
  score,
  slugify,
  validate,
  writePendingFile,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { formatIssues } from "./format.ts";
import { commitFile, existsOnRef, git, pushBranch } from "./git.ts";
import { memberIdFrom } from "./init.ts";
import { CliError, providerFor } from "./provider.ts";

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
  /** One of KINDS; `decision` needs `adopted`. */
  kind?: string;
  /** With kind decision: record a proposal the team chose not to adopt. */
  notAdopted?: boolean;
  exampleFile?: string;
  /** `<area>/<topic>`: patch a section of knowledge/<area>/docs/<topic>.md instead of adding a rule. */
  doc?: string;
  /** With --doc: the section id to replace or append to, or a new id with --heading. */
  section?: string;
  /** With --doc: the section text (falls back to --rule). */
  text?: string;
  /** With --doc: add the text to the section instead of replacing it. */
  append?: boolean;
  /** With --doc: the heading of a new section. */
  heading?: string;
  /** `manual` (default) or `agent-handoff`; a comment URL always means `pr-feedback`. */
  source?: string;
  /** Commit the entry to this branch of the KB repo instead of writing it to the working tree. */
  branch?: string;
  push?: boolean;
}

const HAND_SOURCES = ["manual", "agent-handoff"] as const;

class LearnError extends CliError {}

interface FetchedComment {
  comment: ReviewComment;
  /** Some commit on the PR is later than the comment: the +3 signal, at PR granularity. */
  changedCode: boolean;
}

async function fetchComment(ref: CommentRef, io: Io): Promise<FetchedComment> {
  const provider = providerFor(ref.host, io, `read ${ref.host} comments`);
  const comments = await provider.listReviewComments(ref.repo, ref.pullRequest);
  const comment = comments.find((c) => c.id === ref.comment);
  if (!comment) throw new LearnError(`comment ${ref.comment} not found on PR ${ref.pullRequest}`);
  const commits = await provider.listCommits(ref.repo, ref.pullRequest);
  const at = Date.parse(comment.createdAt);
  return { comment, changedCode: commits.some((c) => Date.parse(c.date) > at) };
}

function loadConfig(files: Record<string, string>): Config {
  const result = validate(files);
  if (!result.config) {
    throw new LearnError("homeostat.yaml is missing or invalid; run homeostat validate to see why");
  }
  return result.config;
}

/** `homeostat learn [url]`: writes one candidate entry, from flags, prompts or a PR comment. */
export async function runLearn(
  url: string | undefined,
  opts: LearnOptions,
  io: Io,
): Promise<number> {
  try {
    return await learn(url, opts, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function learn(url: string | undefined, opts: LearnOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir);
  // The developer's view: their pending lessons count for id clashes and validation.
  const files = readKbView(root).files;
  const config = loadConfig(files);
  if (opts.doc) return learnDoc(root, files, config, opts, io);

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
    let ref: CommentRef;
    try {
      ref = parseCommentUrl(url);
    } catch (e) {
      if (e instanceof CommentUrlError) throw new LearnError(e.message);
      throw e;
    }
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

  const id = opts.id ?? slugify(fields.title) ?? "";
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
    ...(opts.kind ? { kind: opts.kind as Kind } : {}),
    ...(opts.kind === "decision" ? { adopted: !opts.notAdopted } : {}),
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
  logEvent(root, {
    ts: (io.now?.() ?? new Date()).toISOString(),
    type: "entry-created",
    id,
    area,
    author,
    sourceType: frontmatter.source.type,
    ...(opts.branch ? { branch: opts.branch } : {}),
  });
  if (opts.branch) {
    try {
      commitFile(root, opts.branch, path, text, `homeostat: candidate ${id}`);
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

  writePendingFile(root, path, text);
  io.stdout(
    `saved ${id} ${summary}: it applies to your sessions now, and tomorrow's daily run decides it for the team\n`,
  );
  return 0;
}

/**
 * `learn --doc <area>/<topic> --section <id>`: a one-section patch to a document, never a
 * whole-file rewrite. Like a rule, it lands as a candidate change for the owning team to review.
 */
function learnDoc(
  root: string,
  files: KbFiles,
  config: Config,
  opts: LearnOptions,
  io: Io,
): number {
  if (opts.push && !opts.branch) throw new LearnError("--push needs --branch");
  const [area, topic] = (opts.doc ?? "").split("/");
  if (!area || !topic)
    throw new LearnError("--doc takes <area>/<topic>, e.g. integrations/partner-calls");
  const path = `knowledge/${area}/docs/${topic.replace(/\.md$/, "")}.md`;
  const body = (opts.text ?? opts.rule ?? "").trim();
  if (!opts.section || !body) throw new LearnError("--doc needs --section and --text");
  const author = opts.author ?? memberIdFrom(git(root, "config", "user.name"));
  if (!config.team.members.some((m) => m.id === author)) {
    throw new LearnError(`${author} is not a team member; pass --author`);
  }
  // On a branch, patch the branch's copy so earlier patches there are kept.
  const current =
    (opts.branch && git(root, "show", `refs/heads/${opts.branch}:${path}`)) || files[path];
  if (current === undefined) throw new LearnError(`no document at ${path}`);

  const today = (io.now?.() ?? new Date()).toISOString().slice(0, 10);
  const provenance = { source: opts.source ?? "manual", author, updated: today };
  let text: string;
  try {
    text = applySectionPatch(
      current.endsWith("\n") ? current : `${current}\n`,
      opts.heading
        ? { op: "add", id: opts.section, heading: opts.heading, body, provenance }
        : { op: opts.append ? "append" : "replace", id: opts.section, body, provenance },
      today,
    );
  } catch (e) {
    if (e instanceof PatchError) throw new LearnError(e.message);
    throw e;
  }
  const issues = validate({ ...files, [path]: text }).issues.filter(
    (i) => i.file === path && i.severity === "error",
  );
  if (issues.length > 0) {
    io.stdout(`${formatIssues(issues, io).text}nothing written\n`);
    return 1;
  }
  const what = `${opts.heading ? "added" : opts.append ? "appended to" : "updated"} #${opts.section} in ${path}`;
  if (opts.branch) {
    try {
      commitFile(root, opts.branch, path, text, `homeostat: ${what}`);
      io.stdout(`committed: ${what} on ${opts.branch}\n`);
      if (opts.push) {
        pushBranch(root, opts.branch);
        io.stdout(`pushed ${opts.branch} to origin\n`);
      }
    } catch (e) {
      throw new LearnError((e as Error).message);
    }
    return 0;
  }
  writePendingFile(root, path, text);
  io.stdout(
    `${what}: it applies to your sessions now, and tomorrow's daily run decides it for the team\n`,
  );
  return 0;
}
