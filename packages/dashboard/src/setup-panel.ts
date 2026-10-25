import type { SetupRecordItem, SetupRow } from "@homeostat/core";
import { esc, info } from "./charts.ts";

const MARK: Record<SetupRow["state"], string> = {
  done: "✓",
  missing: "✗",
  broken: "✗",
  optional: "○",
  unknown: "?",
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const fix = (name: string) => `<code>homeostat setup --step ${esc(name)}</code>`;

/** Whether every required step is done: the panel then moves below the rest of the page. */
export const setupComplete = (rows: readonly SetupRow[]) =>
  rows.filter((r) => r.required).every((r) => r.state === "done");

function row(r: SetupRow): string {
  const tag = r.required ? "" : `<span class="opt">optional${info(esc(r.why))}</span>`;
  let detail: string;
  if (r.state === "unknown" && r.source === "none")
    detail = "not checked yet: run <code>homeostat setup --check</code>";
  else {
    const reason = r.state === "optional" ? "" : esc(r.reason ?? "");
    const when = r.source === "record" && r.checkedAt ? `checked ${day(r.checkedAt)}` : "";
    detail = [reason, when].filter(Boolean).join(" · ");
  }
  const action = r.state === "missing" || r.state === "broken" ? fix(r.name) : "";
  return `<li class="${r.state}"><span class="mk" aria-label="${r.state}">${MARK[r.state]}</span><span class="t">${esc(r.title)}${tag}</span><span class="r">${detail}</span><span class="a">${action}</span></li>`;
}

/**
 * The Setup card: how far `homeostat setup` has got. Rows come from the files here, or for what
 * only the git host can confirm (a stored secret, a schedule), from the last recorded check. The
 * page makes no call of its own. A shared build shows only what the files show.
 */
export function setupPanel(
  rows: readonly SetupRow[],
  opts: { shared?: boolean; join?: SetupRecordItem } = {},
): string {
  const required = rows.filter((r) => r.required);
  const optional = rows.filter((r) => !r.required);
  const done = required.filter((r) => r.state === "done").length;
  const optDone = optional.filter((r) => r.state === "done").length;
  const pct = required.length ? Math.round((100 * done) / required.length) : 100;
  const tip = opts.shared
    ? "What homeostat.yaml and the CI files show. Secrets, schedules and the webhook are checked on a laptop with homeostat setup --check, so this shared view leaves them out."
    : "From the files here, and for what only the git host can confirm (secrets, schedules, the webhook), the last homeostat setup or setup --check on this laptop. Nothing is fetched to draw this.";
  const join = opts.shared
    ? ""
    : `<p class="join">${
        opts.join?.state === "done"
          ? `✓ This laptop: plugin installed, kb_dir set <span class="r">checked ${day(opts.join.checkedAt)}</span>`
          : `This laptop: <code>homeostat setup --join</code>${opts.join ? ` <span class="r">${esc(opts.join.reason ?? "")}</span>` : ""}`
      }</p>`;
  return `<section class="card span-12 setup" aria-labelledby="setup">
  <div class="card-head"><h2 id="setup">Setup${info(tip)}</h2><span class="state">${done}/${required.length} required · ${optDone}/${optional.length} optional</span></div>
  <div class="meter" role="progressbar" aria-label="Required setup steps done" aria-valuemin="0" aria-valuemax="${required.length}" aria-valuenow="${done}"><span style="width:${pct}%"></span></div>
  <ul class="checklist">${rows.map(row).join("")}</ul>
  ${join}
</section>`;
}

export const SETUP_CSS = `
/* Setup card. */
.meter { height: 8px; border-radius: 999px; background: var(--raised); overflow: hidden; margin: 0 0 14px; }
.meter span { display: block; height: 100%; background: var(--good); border-radius: 999px; }
.checklist { list-style: none; margin: 0; padding: 0; display: grid; }
.checklist li { display: grid; grid-template-columns: 1.4em minmax(0, 1.2fr) minmax(0, 1.4fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--rule); font-size: 14px; }
.checklist li:last-child { border-bottom: 0; }
.checklist .mk { font-weight: 700; text-align: center; }
.checklist .done .mk { color: var(--good); }
.checklist .missing .mk, .checklist .broken .mk { color: var(--critical); }
.checklist .optional .mk, .checklist .unknown .mk { color: var(--ink-3); }
.checklist .t { font-weight: 550; display: inline-flex; align-items: center; gap: 8px; }
.checklist .opt { font-size: 12px; font-weight: 550; color: var(--ink-3); display: inline-flex; align-items: center; gap: 2px; }
.checklist .r, .join .r { color: var(--ink-3); font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 700px) { .checklist li { grid-template-columns: 1.4em minmax(0, 1fr); } .checklist .r, .checklist .a { grid-column: 2; } }
.join { margin: 12px 0 0; font-size: 14px; color: var(--ink-2); }
`;
