import { Command, CommanderError } from "commander";
import { runCodeowners } from "./codeowners.ts";
import { HOSTS, type InitOptions, runInit } from "./init.ts";
import { runValidate } from "./validate.ts";

/** Commands from the execution plan that exist in the CLI but are not built yet. */
const PLANNED: readonly [name: string, description: string, step: string][] = [
  ["learn", "Capture an entry interactively or from a PR comment URL", "2.1"],
  ["export", "Write accepted entries to agent rules files", "2.7"],
  ["up", "Start the agents and dashboard", "2.5"],
  ["status", "Show agent and knowledge-base health", "4.3"],
];

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

export const processIo: Io = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  color: process.stdout.isTTY === true && !process.env.NO_COLOR,
};

/** Runs the CLI with `argv` (as in `process.argv`) and returns the exit code. */
export async function runCli(argv: readonly string[], io: Io = processIo): Promise<number> {
  let exitCode = 0;
  const program = new Command("kbx")
    .description("Team knowledge base for coding agents.")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("validate")
    .description("Check kbx.yaml and every entry under knowledge/.")
    .argument("[dir]", "knowledge base root", ".")
    .option("--fix", "rewrite stale score and tokens values")
    .option("--json", "print the result as JSON")
    .action((dir: string, opts: { fix?: boolean; json?: boolean }) => {
      exitCode = runValidate(dir, opts, io);
    });

  program
    .command("codeowners")
    .description("Generate CODEOWNERS from kbx.yaml and entry owners.")
    .argument("[dir]", "knowledge base root", ".")
    .option("--check", "exit 1 if CODEOWNERS is stale, without writing it")
    .action((dir: string, opts: { check?: boolean }) => {
      exitCode = runCodeowners(dir, opts, io);
    });

  program
    .command("init")
    .description("Scaffold kbx.yaml, knowledge/ and a validate CI file in a KB repo.")
    .argument("[dir]", "knowledge base root", ".")
    .option("--host <host>", `git host for the CI file: ${HOSTS.join(" or ")} (default: detect)`)
    .option("--member <id>", "id of the first (senior) member (default: from git user.name)")
    .option("--handle <handle>", "CODEOWNERS handle of the first member, e.g. @you")
    .option("--force", "overwrite an existing kbx.yaml")
    .action((dir: string, opts: InitOptions) => {
      exitCode = runInit(dir, opts, io);
    });

  for (const [name, description, step] of PLANNED) {
    program
      .command(name)
      .description(`${description} (not built yet)`)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        io.stderr(`kbx ${name} is not built yet (execution plan step ${step})\n`);
        exitCode = 1;
      });
  }

  try {
    await program.parseAsync([...argv]);
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
  return exitCode;
}
