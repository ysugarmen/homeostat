import { resolve } from "node:path";
import {
  type Entry,
  explainEntry,
  hitLine,
  kbReport,
  readEvents,
  readKbView,
  type SearchHit,
  STATUSES,
  type Status,
  searchEntries,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { findKb } from "./hook.ts";
import { CliError } from "./provider.ts";

/** Read-only commands an agent or person reaches for first: search, explain, list, status. */
export interface QueryOptions {
  dir?: string;
  json?: boolean;
}

/**
 * `inForce` reads pending lessons as accepted, the way the author's sessions see them; search uses
 * it so a lesson saved a minute ago is found. explain, list and status show the real status.
 */
function load(opts: QueryOptions, io: Io, view: { inForce?: boolean } = {}) {
  const root = opts.dir ? resolve(opts.dir) : findKb(io.env, process.cwd());
  if (!root) {
    throw new CliError(
      "no knowledge base here: pass --dir, set HOMEOSTAT_DIR, or run inside the KB repo",
    );
  }
  const { files, pending } = readKbView(root, view);
  const kb = validate(files);
  if (!kb.config)
    throw new CliError(`homeostat.yaml is missing or invalid in ${root}; run homeostat validate`);
  const pendingIds = new Set(
    kb.entries.filter((e) => pending.has(e.path)).map((e) => e.entry.frontmatter.id),
  );
  return {
    root,
    config: kb.config,
    entries: kb.entries.map((e) => e.entry),
    docs: kb.docs,
    pendingIds,
  };
}

const summary = (e: Entry) => ({
  id: e.frontmatter.id,
  title: e.frontmatter.title,
  area: e.frontmatter.area,
  status: e.frontmatter.status,
  score: e.frontmatter.score,
  rule: e.sections.rule ?? "",
});

function guard(io: Io, run: () => number): number {
  try {
    return run();
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

export function runSearch(
  query: string[],
  opts: QueryOptions & { area?: string; path?: string; limit?: string; all?: boolean },
  io: Io,
): number {
  return guard(io, () => {
    const { entries } = load(opts, io, { inForce: true });
    const hits: SearchHit[] = searchEntries(entries, query.join(" "), {
      ...(opts.area ? { area: opts.area } : {}),
      ...(opts.path ? { path: opts.path } : {}),
      ...(opts.all ? { statuses: STATUSES as readonly Status[] } : {}),
      limit: opts.limit ? Number(opts.limit) : 10,
    });
    if (opts.json) {
      io.stdout(
        `${JSON.stringify(
          hits.map((h) => ({ ...summary(h.entry), match: h.score })),
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(
        hits.length ? `${hits.map((h) => hitLine(h.entry)).join("\n")}\n` : "no matching entries\n",
      );
    }
    return 0;
  });
}

export function runExplain(id: string, opts: QueryOptions, io: Io): number {
  return guard(io, () => {
    const { config, entries, pendingIds } = load(opts, io);
    const entry = entries.find((e) => e.frontmatter.id === id);
    if (!entry) {
      const close = searchEntries(entries, id.replace(/-/g, " "), { limit: 3, statuses: STATUSES });
      const hint = close.length
        ? `; closest: ${close.map((h) => h.entry.frontmatter.id).join(", ")}`
        : "";
      throw new CliError(`no entry with id "${id}"${hint}`);
    }
    io.stdout(
      opts.json
        ? `${JSON.stringify({ ...entry.frontmatter, sections: entry.sections }, null, 2)}\n`
        : `${explainEntry(entry, config)}\n${
            pendingIds.has(id)
              ? "Pending in this clone: it applies to your sessions now; the next daily run decides it for the team.\n"
              : ""
          }`,
    );
    return 0;
  });
}

export function runList(opts: QueryOptions & { area?: string; status?: string }, io: Io): number {
  return guard(io, () => {
    const { entries } = load(opts, io);
    if (opts.status && !(STATUSES as readonly string[]).includes(opts.status)) {
      throw new CliError(`--status must be one of ${STATUSES.join(", ")}`);
    }
    const shown = entries
      .filter((e) => (opts.status ? e.frontmatter.status === opts.status : true))
      .filter((e) => !opts.area || e.frontmatter.area === opts.area)
      .sort(
        (a, b) =>
          a.frontmatter.area.localeCompare(b.frontmatter.area) ||
          b.frontmatter.score - a.frontmatter.score,
      );
    if (opts.json) {
      io.stdout(`${JSON.stringify(shown.map(summary), null, 2)}\n`);
    } else {
      io.stdout(
        shown.length
          ? `${shown.map((e) => `${e.frontmatter.status.padEnd(9)} ${String(e.frontmatter.score).padStart(2)}  ${e.frontmatter.id}  [${e.frontmatter.area}]`).join("\n")}\n`
          : "no entries\n",
      );
    }
    return 0;
  });
}

export function runStatus(opts: QueryOptions & { days?: string }, io: Io): number {
  return guard(io, () => {
    const { root, config, entries, docs } = load(opts, io);
    const days = opts.days ? Number(opts.days) : 7;
    const now = io.now?.() ?? new Date();
    // The report counts its own window; document decay looks back 90 days.
    const events = readEvents(root, {
      since: new Date(now.getTime() - Math.max(days, 90) * 86_400_000).toISOString(),
    });
    io.stdout(`${kbReport(entries, config, { days, now, events, docs })}\n`);
    return 0;
  });
}
