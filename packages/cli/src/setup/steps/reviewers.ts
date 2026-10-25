import { isSenior, setupStep } from "@homeostat/core";
import type { Step } from "../context.ts";

/** Step 6 (optional): who decides the lessons the daily run is unsure about. */
export const reviewersStep: Step = {
  info: setupStep("reviewers") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    return ctx.local().reviewers ?? { state: "optional" };
  },
  async run(ctx) {
    const config = ctx.config();
    if (!config) return;
    const ids = config.team.members.map((m) => m.id);
    const seniors = config.team.members.filter((m) => isSenior(m.role)).map((m) => m.id);
    const answer = await ctx.ask(
      `  Reviewers (member ids: ${ids.join(", ")}; comma-separated)`,
      seniors.join(", "),
    );
    const picked = [...new Set(answer.split(/[,\s]+/).filter((id) => ids.includes(id)))];
    if (picked.length) ctx.edit([{ path: ["team", "reviewers"], set: picked }]);
  },
};
