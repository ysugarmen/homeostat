import { Command, CommanderError } from "commander";
import { runCodeowners } from "./codeowners.ts";
import { runValidate } from "./validate.ts";

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

  try {
    await program.parseAsync([...argv]);
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
  return exitCode;
}
