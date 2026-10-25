import {
  type ConfigEdit,
  loginKey,
  memberFromGit,
  type Person,
  ROLES,
  type Role,
  setupStep,
  slugify,
} from "@homeostat/core";
import { git } from "../../git.ts";
import { describeError, type SetupContext, type Step } from "../context.ts";

const allAreas = (ctx: SetupContext): string[] => {
  const c = ctx.config();
  if (!c) return [];
  return [
    ...Object.keys(c.areas),
    ...Object.entries(c.repos ?? {}).flatMap(([r, v]) =>
      Object.keys(v.areas).map((a) => `${r}/${a}`),
    ),
  ];
};

/** Step 5: you, and whoever else joins, picked from the workspace or org with their handles. */
export const teamStep: Step = {
  info: setupStep("team") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    const local = ctx.local().team ?? { state: "missing" };
    if (local.state !== "done") return local;
    const config = ctx.config();
    const name = git(ctx.root, "config", "user.name");
    if (config && name) {
      const id = memberFromGit(config.team.members, name);
      if (!config.team.members.some((m) => m.id === id))
        return { state: "missing", reason: `your git user.name "${name}" maps to no member` };
    }
    return local;
  },
  async run(ctx) {
    const config = ctx.config();
    if (!config) return;
    const api = await ctx.ensureReader();
    const kb = ctx.kbRepo();
    let people: Person[] = [];
    if (api && kb) {
      try {
        people = await api.listMembers(kb);
      } catch (e) {
        ctx.say(`  could not list the members: ${describeError(e)}`);
      }
    }
    const handleOf = (p: Person) => `@${p.id}`;
    const label = (p: Person) => (p.name ? `${p.name} (${handleOf(p)})` : handleOf(p));
    const taken = new Set(config.team.members.map((m) => m.handle && loginKey(m.handle)));
    const ids = new Set(config.team.members.map((m) => m.id));
    if (people.length) {
      ctx.say(`  ${people.length} people on the host:`);
      people.forEach((p, i) => {
        ctx.say(`    ${String(i + 1).padStart(2)}. ${label(p)}`);
      });
    }
    const pick = (answer: string): Person | undefined => {
      const n = Number(answer);
      if (Number.isInteger(n) && people[n - 1]) return people[n - 1];
      const login = answer.replace(/^@/, "");
      return (
        people.find((p) => p.id.toLowerCase() === login.toLowerCase()) ??
        (login ? { id: login } : undefined)
      );
    };

    const edits: ConfigEdit[] = [];
    // You: the member `init` seeded from git user.name, given a handle.
    const gitName = git(ctx.root, "config", "user.name");
    const myId = memberFromGit(config.team.members, gitName);
    const myIndex = config.team.members.findIndex((m) => m.id === myId);
    const me = myIndex >= 0 ? config.team.members[myIndex] : undefined;
    if (!me?.handle) {
      const you = pick(
        await ctx.ask(
          people.length
            ? "  Which one is you? (number or handle)"
            : "  Your handle on the host (login or nickname)",
        ),
      );
      if (!you) return;
      taken.add(loginKey(handleOf(you)));
      if (me) edits.push({ path: ["team", "members", myIndex, "handle"], set: handleOf(you) });
      else {
        const id = uniqueId(slugify(gitName) ?? slugify(you.name ?? you.id) ?? "owner", ids);
        edits.push({
          path: ["team", "members"],
          append: { id, handle: handleOf(you), role: "senior", areas: [] },
        });
      }
    }
    // Members still without a handle (added by hand earlier).
    for (const [i, m] of config.team.members.entries()) {
      if (m.handle || m.id === myId) continue;
      const h = pick(await ctx.ask(`  Handle for ${m.id} (number or login)`));
      if (!h) continue;
      taken.add(loginKey(handleOf(h)));
      edits.push({ path: ["team", "members", i, "handle"], set: handleOf(h) });
    }

    const others = people.filter((p) => !taken.has(loginKey(handleOf(p))));
    if (others.length || !people.length) {
      ctx.say(
        "  Only members' review comments become lessons; anyone can be added later with setup --step team.",
      );
      const answer = await ctx.ask(
        "  Who else joins? (numbers or handles, comma-separated; all; empty for nobody)",
      );
      const chosen =
        answer.toLowerCase() === "all"
          ? others
          : answer
              .split(",")
              .map((a) => pick(a.trim()))
              .filter(
                (p): p is Person => Boolean(p) && !taken.has(loginKey(handleOf(p as Person))),
              );
      const areas = allAreas(ctx);
      for (const p of chosen) {
        taken.add(loginKey(handleOf(p)));
        const roleAnswer = (
          await ctx.ask(`  Role for ${label(p)}: ${ROLES.join(", ")}`, "member")
        ).toLowerCase();
        const role: Role = (ROLES as readonly string[]).includes(roleAnswer)
          ? (roleAnswer as Role)
          : "member";
        const owned = areas.length
          ? (
              await ctx.ask(
                `  Areas ${label(p)} owns (${areas.join(", ")}; comma-separated, empty for none)`,
              )
            )
              .split(/[,\s]+/)
              .filter((a) => areas.includes(a))
          : [];
        const id = uniqueId(slugify(p.name ?? p.id) ?? "member", ids);
        edits.push({
          path: ["team", "members"],
          append: { id, handle: handleOf(p), role, areas: owned },
        });
      }
    }
    if (edits.length) ctx.edit(edits);
  },
};

function uniqueId(base: string, ids: Set<string>): string {
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  ids.add(id);
  return id;
}
