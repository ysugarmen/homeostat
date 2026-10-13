import { styleText } from "node:util";
import type { Issue } from "@kbx/core";
import type { Io } from "./cli.ts";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const painter = (io: Io) => (style: Parameters<typeof styleText>[0], text: string) =>
  io.color ? styleText(style, text) : text;

/** Issues grouped by file, one line each with severity, message and code. */
export function formatIssues(issues: readonly Issue[], io: Io): { text: string; files: number } {
  const paint = painter(io);
  const byFile = new Map<string, Issue[]>();
  for (const issue of issues) {
    const file = issue.file ?? "(knowledge base)";
    byFile.set(file, [...(byFile.get(file) ?? []), issue]);
  }

  let text = "";
  for (const [file, fileIssues] of byFile) {
    text += `${paint("underline", file)}\n`;
    for (const i of fileIssues) {
      const label = i.severity === "error" ? paint("red", "error") : paint("yellow", "warning");
      text += `  ${label}  ${i.message}  ${paint("dim", i.code)}\n`;
    }
    text += "\n";
  }
  return { text, files: byFile.size };
}
