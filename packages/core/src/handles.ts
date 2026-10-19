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
