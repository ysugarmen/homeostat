/**
 * Members are matched to git-host users by handle. Bitbucket nicknames can hold spaces and
 * accented letters ("Javier Gallostra Acín"), so handles compare without the @, quotes, case
 * or extra spaces.
 */
export const loginKey = (handleOrLogin: string): string =>
  handleOrLogin
    .trim()
    .replace(/^@/, "")
    .replace(/^"(.*)"$/, "$1")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The member whose handle names `login` (a host user's nickname or login). */
export function memberForLogin<M extends { handle?: string | undefined }>(
  members: readonly M[],
  login: string,
): M | undefined {
  const key = loginKey(login);
  return members.find((m) => m.handle !== undefined && loginKey(m.handle) === key);
}

/** A handle as CODEOWNERS writes it: Bitbucket quotes a nickname with spaces, `@"Ana Ruiz"`. */
export const codeownersHandle = (handle: string): string =>
  /\s/.test(handle.trim()) ? `@"${handle.trim().replace(/^@/, "").replace(/^"|"$/g, "")}"` : handle;

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Which member a git user is, by `git config user.name`: the name as an id ("Dana" → dana),
 * the name as a member's handle ("Yonatan Sugarmen" → the member with handle
 * "@Yonatan Sugarmen"), or the first name as an id when exactly one member has it. Falls back
 * to the name as an id, which is no member: lessons then stay local, and the sync says so.
 */
export function memberFromGit(
  members: readonly { id: string; handle?: string | undefined }[],
  gitName: string | undefined,
): string {
  const name = (gitName ?? "").trim();
  const asId = slug(name) || "owner";
  if (members.some((m) => m.id === asId)) return asId;
  const byHandle = memberForLogin(members, name);
  if (byHandle) return byHandle.id;
  const first = slug(name.split(/\s+/)[0] ?? "");
  const byFirst = members.filter((m) => m.id === first);
  return byFirst.length === 1 && byFirst[0] ? byFirst[0].id : asId;
}
