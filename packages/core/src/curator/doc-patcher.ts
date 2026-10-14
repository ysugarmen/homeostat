import { z } from "zod";
import type { Asker } from "../claude.ts";
import type { ReviewThread } from "./threads.ts";

/** A document the thread's file falls under, as the patcher sees it. */
export interface DocCandidate {
  path: string;
  title: string;
  sections: { id: string; heading: string; body: string }[];
}

export interface DocProposal {
  path: string;
  sectionId: string;
  op: "replace" | "append";
  body: string;
  reason: string;
}

/** Proposes at most one section edit per review thread; null when no document is affected. */
export interface DocPatcher {
  propose(thread: ReviewThread, docs: readonly DocCandidate[]): Promise<DocProposal | null>;
}

export const docPatchSchema = z.object({
  change: z
    .boolean()
    .describe("true only if the thread makes a listed section wrong or incomplete"),
  path: z.string().describe("the document path, exactly as listed"),
  sectionId: z.string().describe("the section id, exactly as listed"),
  op: z
    .enum(["replace", "append"])
    .describe("append to add a fact; replace when the text is now wrong"),
  body: z.string().describe("the section's new text (replace) or the text to add (append)"),
  reason: z.string().describe("one sentence: what in the thread makes the section out of date"),
});

export const DOC_PATCH_SYSTEM = `You keep a software team's reference documents current. You get one code-review thread whose feedback led to a code change, and the document sections that cover the file it was on.

Decide whether the thread makes one of those sections wrong or incomplete: a renamed service or function, a moved path, a finished migration, a new constraint. Most threads change no document; then set change to false.

If one does, edit exactly one section. Prefer append for a new fact. Use replace only when existing text is now wrong, and then keep every sentence that is still true, word for word. Use only names and facts from the thread and the section; never invent details. Keep the section's style and length.`;

export function docPatchPrompt(thread: ReviewThread, docs: readonly DocCandidate[]): string {
  const conversation = [thread.root, ...thread.replies]
    .map((c) => `${c.author.id}: ${c.body.trim()}`)
    .join("\n\n");
  const sections = docs
    .flatMap((d) =>
      d.sections.map(
        (s) =>
          `<section path="${d.path}" id="${s.id}" heading="${s.heading}">\n${s.body}\n</section>`,
      ),
    )
    .join("\n\n");
  return `Repository: ${thread.repo}
Pull request: ${thread.pullRequest.title}
Comment on: ${thread.root.path ?? "the pull request as a whole"}

<thread>
${conversation}
</thread>

Document sections that cover this file:

${sections}`;
}

export class ClaudeDocPatcher implements DocPatcher {
  private readonly ask: Asker;

  constructor(ask: Asker) {
    this.ask = ask;
  }

  async propose(thread: ReviewThread, docs: readonly DocCandidate[]): Promise<DocProposal | null> {
    if (docs.length === 0) return null;
    const out = await this.ask(DOC_PATCH_SYSTEM, docPatchPrompt(thread, docs), docPatchSchema);
    if (!out?.change) return null;
    return {
      path: out.path,
      sectionId: out.sectionId,
      op: out.op,
      body: out.body.trim(),
      reason: out.reason.trim(),
    };
  }
}
