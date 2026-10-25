import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CODEOWNERS_FILE, readKbFiles, setupStep, validate } from "@homeostat/core";
import { formatIssues } from "../../format.ts";
import { git, networkEnv, networkTimeout } from "../../git.ts";
import { firstLine, type SetupContext, type Step } from "../context.ts";

export const SETUP_BRANCH = "homeostat-setup";

/** What setup writes; nothing else in the checkout is committed. */
const PATHS = [
  "homeostat.yaml",
  ".gitignore",
  "knowledge",
  ".github",
  "bitbucket-pipelines.yml",
  ".bitbucket",
  CODEOWNERS_FILE,
];

const changed = (ctx: SetupContext) =>
  (git(ctx.root, "status", "--porcelain", "--", ...PATHS) ?? "").split("\n").filter(Boolean);

/** Step 10: one validated commit, pushed to a branch for review (or to the base branch if you say so). */
export const commitStep: Step = {
  info: setupStep("commit") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    if (git(ctx.root, "rev-parse", "--is-inside-work-tree") !== "true")
      return { state: "missing", reason: "not a git checkout" };
    const dirty = changed(ctx);
    if (dirty.length) return { state: "missing", reason: `${dirty.length} files not committed` };
    if (!git(ctx.root, "rev-parse", "--verify", "--quiet", "HEAD"))
      return { state: "missing", reason: "nothing committed yet" };
    const ahead = git(ctx.root, "rev-list", "--count", "@{u}..HEAD");
    if (ahead === undefined) {
      const unpushed = git(ctx.root, "log", "--oneline", "HEAD", "--not", "--remotes");
      return unpushed
        ? { state: "missing", reason: "not pushed" }
        : { state: "done", reason: "pushed" };
    }
    return ahead === "0"
      ? { state: "done", reason: "pushed" }
      : { state: "missing", reason: `${ahead} commits not pushed` };
  },
  async run(ctx) {
    const result = validate(readKbFiles(ctx.root));
    if (!result.ok) {
      ctx.say(
        `${
          formatIssues(
            result.issues.filter((i) => i.severity === "error"),
            ctx.io,
          ).text
        }  Fix these and rerun.`,
      );
      return;
    }
    const base = ctx.config()?.sources?.baseBranch ?? "main";
    const current = git(ctx.root, "rev-parse", "--abbrev-ref", "HEAD");
    const remoteHasBase = Boolean(
      git(ctx.root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`),
    );
    let branch = current && current !== "HEAD" ? current : base;
    if (changed(ctx).length) {
      if (!remoteHasBase) {
        ctx.say(`  The KB repo is empty, so the first commit goes to ${base}.`);
        branch = base;
      } else if (current === base) {
        const toBase = await ctx.yes(
          `  Commit straight to ${base} without review? (No: a branch ${SETUP_BRANCH} to open a PR from)`,
        );
        branch = toBase ? base : SETUP_BRANCH;
      }
      try {
        if (branch !== current) run(ctx.root, ["checkout", "-B", branch]);
        run(ctx.root, ["add", "-A", "--", ...PATHS.filter((p) => existsSync(join(ctx.root, p)))]);
        run(ctx.root, ["commit", "-q", "-m", "homeostat: setup"]);
        ctx.say(`  ${ctx.paint("green", "✓")} committed "homeostat: setup" on ${branch}`);
      } catch (e) {
        ctx.say(`  ${ctx.paint("red", "✗")} ${(e as Error).message}`);
        return;
      }
    }
    try {
      run(ctx.root, ["push", "-q", "-u", "origin", branch], true);
      ctx.say(`  ${ctx.paint("green", "✓")} pushed ${branch}`);
    } catch (e) {
      ctx.say(`  ${ctx.paint("red", "✗")} ${(e as Error).message}`);
      return;
    }
    if (branch !== base)
      ctx.say(`  Open a PR from ${branch} to ${base} and merge it: CI runs what is on ${base}.`);
  },
};

function run(dir: string, args: string[], network = false) {
  try {
    execFileSync("git", ["-C", dir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(network ? { env: networkEnv(dir), timeout: networkTimeout() } : {}),
    });
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer }).stderr ?? "");
    throw new Error(`git ${args[0]} failed${stderr ? `: ${firstLine(stderr)}` : ""}`);
  }
}
