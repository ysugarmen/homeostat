import { bitbucketCron, setupStep, wantedSchedules } from "@homeostat/core";
import { plural } from "../../format.ts";
import { adminHint, describeError, errorStatus, repoUrl, type Step } from "../context.ts";

/** Step 11: Bitbucket Pipelines schedules through the API; on GitHub, the workflows and Actions. */
export const schedulesStep: Step = {
  info: setupStep("schedules") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    const local = ctx.local().schedules;
    if (local) return local;
    const config = ctx.config();
    const kb = ctx.kbRepo();
    const host = ctx.host();
    if (!config || !kb || !host) return { state: "missing", reason: "needs the host step first" };
    // Scheduled in this run counts as scheduled: the host's list lags behind a write.
    const wanted = wantedSchedules(config);
    const fresh = wanted.filter((w) => ctx.scheduledNow.has(w.pipeline));
    if (host === "bitbucket" && wanted.length && fresh.length === wanted.length)
      return { state: "done", reason: `${plural(wanted.length, "schedule")} set just now` };
    const api =
      host === "bitbucket"
        ? ctx.admin
          ? ctx.client(host, ctx.admin)
          : ctx.reader()
        : ctx.reader();
    if (!api) return { state: "unknown", reason: "needs a token to check" };
    try {
      if (host === "github") {
        if (!api.actionsEnabled) return { state: "unknown" };
        return (await api.actionsEnabled(kb))
          ? { state: "done", reason: "the workflows' crons run; Actions are enabled" }
          : { state: "missing", reason: "Actions are disabled on the KB repo" };
      }
      if (!api.listSchedules) return { state: "unknown" };
      const have = await api.listSchedules(kb);
      // Matched by pipeline and enabled, never by cron: Bitbucket rewrites the cron it stores
      // (seconds, `?`, MON for 1), and a team may move a schedule to another hour on purpose.
      const missing = wanted.filter(
        (w) =>
          !ctx.scheduledNow.has(w.pipeline) &&
          !have.some((h) => h.pipeline === w.pipeline && h.enabled),
      );
      return missing.length
        ? {
            state: "missing",
            reason: `not scheduled: ${missing.map((m) => m.pipeline).join(", ")}`,
          }
        : { state: "done", reason: plural(wanted.length, "schedule") };
    } catch (e) {
      return { state: "unknown", reason: `${describeError(e)}${adminHint(host, e)}` };
    }
  },
  async run(ctx) {
    const config = ctx.config();
    const kb = ctx.kbRepo();
    const host = ctx.host();
    if (!config?.sources || !kb || !host) return;
    const full = `${kb.owner}/${kb.name}`;
    const local = ctx.local().schedules;
    if (local) {
      ctx.say(
        `  ${local.reason}. Run homeostat init --host ${host} in an empty folder and copy ${host === "github" ? "the workflows from .github/workflows/" : "the custom pipelines from bitbucket-pipelines.yml"}, then rerun this step.`,
      );
      return;
    }
    if (host === "github") {
      ctx.say(
        `  The schedules are the workflows' crons. Turn Actions on at ${repoUrl(host, full)}/settings/actions (Allow all actions).`,
      );
      return;
    }
    const base = config.sources.baseBranch;
    const wanted = wantedSchedules(config);
    const manual = () =>
      ctx.say(
        `  Add them by hand at ${repoUrl(host, full)}/admin/pipelines/schedules (Repository settings > Pipelines > Schedules):\n${wanted
          .map((w) => `    ${w.pipeline} on ${base}, cron ${w.cron} (UTC)`)
          .join("\n")}`,
      );
    try {
      await ctx.withAdmin(async (api) => {
        if (!api.listSchedules || !api.createSchedule || !api.enableSchedule)
          throw new Error("this client cannot manage schedules");
        const have = await api.listSchedules(kb);
        for (const w of wanted) {
          if (ctx.scheduledNow.has(w.pipeline)) continue;
          const existing = have.find((h) => h.pipeline === w.pipeline);
          if (!existing?.enabled) {
            if (existing) await api.enableSchedule(kb, existing.uuid);
            else
              await api.createSchedule(kb, {
                pipeline: w.pipeline,
                branch: base,
                cron: bitbucketCron(w.cron),
              });
            ctx.ok(`${existing ? "enabled" : "scheduled"} ${w.pipeline} (${w.cron} UTC)`);
          }
          ctx.scheduledNow.add(w.pipeline);
        }
      });
    } catch (e) {
      ctx.bad(describeError(e));
      if (errorStatus(e) === 400)
        ctx.say(
          `  Bitbucket schedules only pipelines that exist on ${base}: merge the setup commit, then rerun homeostat setup --step schedules.`,
        );
      else manual();
    }
  },
};
