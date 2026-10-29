import { resolve } from "node:path";
import { buildDigest, readEvents, readKbFiles, validate } from "@homeostat/core";
import type { Io } from "./cli.ts";
import { slackProblem } from "./daily.ts";

export interface DigestOptions {
  dir?: string;
  days?: string;
  dryRun?: boolean;
}

/** `homeostat digest`: builds the weekly digest and posts it to the Slack webhook (run in CI). */
export async function runDigest(opts: DigestOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const kb = validate(readKbFiles(root));
  if (!kb.config) {
    io.stderr("homeostat.yaml is missing or invalid; run homeostat validate\n");
    return 1;
  }
  const now = io.now?.() ?? new Date();
  const days = opts.days ? Number(opts.days) : 7;
  const text = buildDigest({
    config: kb.config,
    entries: kb.entries.map((e) => ({ ...e.entry, path: e.path })),
    docs: kb.docs,
    events: readEvents(root, { since: new Date(now.getTime() - days * 86_400_000).toISOString() }),
    now,
    days,
  });
  const variable = kb.config.notifications.slackWebhookEnv;
  if (opts.dryRun || !variable) {
    io.stdout(`${text}\n`);
    if (!variable && !opts.dryRun) {
      io.stdout("\n(no notifications.slackWebhookEnv in homeostat.yaml: printed, not posted)\n");
    }
    return 0;
  }
  // The same warning as the daily run's, then how to fix it; the digest fails, as it posted nothing.
  const problem = slackProblem(kb.config, io);
  if (problem) {
    io.stderr(
      `${problem}\nset ${variable} to the Slack incoming-webhook URL (a CI secret) to post the digest\n`,
    );
    return 1;
  }
  const url = io.env?.[variable] ?? "";
  const res = await (io.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mrkdwn: true }),
  });
  if (!res.ok) {
    io.stderr(`Slack refused the digest: ${res.status} ${await res.text()}\n`);
    return 1;
  }
  io.stdout("digest posted to Slack\n");
  return 0;
}
