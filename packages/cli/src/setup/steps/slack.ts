import { type ConfigEdit, isSenior, setupStep } from "@homeostat/core";
import { DEFAULT_SLACK_VAR, type SetupContext, type Step } from "../context.ts";

const WEBHOOK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/\S+$/;
const MEMBER_ID = /^[UW][A-Z0-9]{6,}$/;

/** Step 8 (optional): the Slack webhook, tested with one post you confirm, and reviewers' IDs. */
export const slackStep: Step = {
  info: setupStep("slack") as NonNullable<ReturnType<typeof setupStep>>,
  supply: `${DEFAULT_SLACK_VAR} in the environment`,
  async detect(ctx) {
    const config = ctx.config();
    const name = config?.notifications.slackWebhookEnv;
    if (!config || !name) return { state: "optional" };
    const exists = await ctx.secretExists(name);
    if (exists === true) return { state: "done", reason: `${name} is stored` };
    if (exists === false) return { state: "missing", reason: `${name} is not stored` };
    return {
      state: "unknown",
      reason: `cannot tell whether ${name} is stored: ${ctx.ciUnreadable}`,
    };
  },
  async run(ctx) {
    const config = ctx.config();
    if (!config) return;
    const name = config.notifications.slackWebhookEnv ?? DEFAULT_SLACK_VAR;
    ctx.say(
      "  Make an incoming webhook for the team's channel (a Slack app > Incoming Webhooks > Add New Webhook).",
    );
    const url = await ctx.secret("  Webhook URL", name);
    if (!url) return;
    if (!WEBHOOK.test(url)) {
      ctx.say(
        `  ${ctx.paint("red", "✗")} that is not a Slack webhook URL (https://hooks.slack.com/…)`,
      );
      return;
    }
    if (!(await testPost(ctx, url))) return;
    if (!(await ctx.yes("  Did the test message arrive in the channel you want?"))) {
      ctx.say("  Make a webhook for the right channel and rerun: homeostat setup --step slack");
      return;
    }
    const stored = await ctx.storeSecret(name, url);
    const edits: ConfigEdit[] = [];
    if (!config.notifications.slackWebhookEnv)
      edits.push({ path: ["notifications", "slackWebhookEnv"], set: name });

    // The morning notice mentions the reviewers by Slack member ID.
    const asked = config.team.reviewers?.length
      ? config.team.members.filter((m) => config.team.reviewers?.includes(m.id))
      : config.team.members.filter((m) => isSenior(m.role));
    for (const m of asked) {
      if (m.slack) continue;
      const id = await ctx.ask(
        `  Slack member ID for ${m.id} (their Slack profile > ⋯ > Copy member ID; empty skips)`,
      );
      if (!id) continue;
      if (!MEMBER_ID.test(id)) {
        ctx.say("  not a member ID (like U0123ABCD); skipped");
        continue;
      }
      const i = config.team.members.indexOf(m);
      edits.push({ path: ["team", "members", i, "slack"], set: id });
    }
    if (edits.length) ctx.edit(edits);
    if (!stored) ctx.say(`  Once ${name} is stored, the digest and the morning notice post there.`);
  },
};

/** One post; the webhook URL is the secret, so it never appears in a message. */
async function testPost(ctx: SetupContext, url: string): Promise<boolean> {
  try {
    const res = await (ctx.io.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "homeostat setup: a test message. The review queue and the weekly digest will post here.",
      }),
    });
    if (res.ok) {
      ctx.say(`  ${ctx.paint("green", "✓")} posted a test message`);
      return true;
    }
    ctx.say(`  ${ctx.paint("red", "✗")} Slack refused the test post (${res.status})`);
  } catch {
    ctx.say(`  ${ctx.paint("red", "✗")} could not reach Slack`);
  }
  return false;
}
