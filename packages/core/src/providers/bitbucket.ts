import { ProviderError, requestJson } from "./http.ts";
import {
  type Commit,
  type NewPullRequest,
  type OpenPullRequest,
  type Person,
  type Provider,
  type ProviderOptions,
  type PullRequest,
  type RepoRef,
  type ReviewComment,
  SKIP_MARKER,
} from "./types.ts";

interface BbUser {
  display_name?: string;
  nickname?: string;
  account_id?: string;
  uuid?: string;
}

interface BbPage<T> {
  values: T[];
  next?: string;
}

interface BbPullRequest {
  id: number;
  title: string;
  author: BbUser;
  updated_on: string;
  description?: string;
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
  links: { html: { href: string } };
}

interface BbComment {
  id: number;
  content: { raw: string };
  user: BbUser;
  created_on: string;
  deleted?: boolean;
  inline?: { path: string; from: number | null; to: number | null };
  parent?: { id: number };
  links: { html: { href: string } };
}

/** One entry of a PR's activity log; `update` entries record each push to the source branch. */
interface BbActivity {
  update?: { date: string; author?: BbUser; source: { commit?: { hash: string } } };
}

interface BbCommit {
  hash: string;
  date: string;
  message: string;
  author: { raw: string; user?: BbUser };
}

const person = (u: BbUser): Person => ({
  id: u.nickname ?? u.account_id ?? "unknown",
  ...(u.display_name ? { name: u.display_name } : {}),
});

/** Bitbucket Cloud REST 2.0. Auth is a workspace or repository access token (Bearer). */
export class BitbucketProvider implements Provider {
  readonly kind = "bitbucket";
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly members = new Map<string, Promise<BbUser[]>>();

  constructor(opts: ProviderOptions) {
    this.token = opts.token;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.bitbucket.org/2.0";
  }

  /**
   * Bitbucket records no merge time, so "merged since" means merged PRs updated since then;
   * `mergedAt` is the last update, which is the merge unless someone commented afterwards.
   */
  async listMergedPullRequests(repo: RepoRef, since: Date): Promise<PullRequest[]> {
    const query = new URLSearchParams({
      state: "MERGED",
      q: `updated_on >= ${since.toISOString()}`,
      sort: "-updated_on",
      pagelen: "50",
    });
    const prs = await this.paginate<BbPullRequest>(`${this.repoUrl(repo)}/pullrequests?${query}`);
    return prs.map((pr) => ({
      id: pr.id,
      title: pr.title,
      url: pr.links.html.href,
      author: person(pr.author),
      mergedAt: pr.updated_on,
      sourceBranch: pr.source.branch.name,
      targetBranch: pr.destination.branch.name,
      // Bitbucket Cloud has no PR labels, so the marker goes in the title or description.
      ...(`${pr.title}\n${pr.description ?? ""}`.includes(SKIP_MARKER)
        ? { skipRequested: true as const }
        : {}),
    }));
  }

  async listOpenPullRequests(repo: RepoRef): Promise<OpenPullRequest[]> {
    const prs = await this.paginate<BbPullRequest>(
      `${this.repoUrl(repo)}/pullrequests?state=OPEN&pagelen=50`,
    );
    return prs.map((pr) => ({
      id: pr.id,
      title: pr.title,
      url: pr.links.html.href,
      author: person(pr.author),
      sourceBranch: pr.source.branch.name,
      targetBranch: pr.destination.branch.name,
    }));
  }

  async listReviewComments(repo: RepoRef, pullRequestId: number): Promise<ReviewComment[]> {
    const comments = await this.paginate<BbComment>(
      `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/comments?pagelen=100`,
    );
    return comments
      .filter((c) => !c.deleted)
      .map((c) => {
        const line = c.inline?.to ?? c.inline?.from ?? undefined;
        return {
          id: c.id,
          body: c.content.raw,
          author: person(c.user),
          createdAt: c.created_on,
          url: c.links.html.href,
          ...(c.inline ? { path: c.inline.path } : {}),
          ...(line != null ? { line } : {}),
          ...(c.parent ? { inReplyTo: c.parent.id } : {}),
        };
      });
  }

  async listCommits(repo: RepoRef, pullRequestId: number): Promise<Commit[]> {
    let commits: BbCommit[];
    try {
      commits = await this.paginate<BbCommit>(
        `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/commits?pagelen=100`,
      );
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return this.pushes(repo, pullRequestId);
      throw e;
    }
    return commits.map((c) => ({
      sha: c.hash,
      date: c.date,
      message: c.message.trimEnd(),
      ...(c.author.user ? { author: person(c.author.user) } : {}),
    }));
  }

  /**
   * Bitbucket answers 404 for the commits of a merged PR whose source branch was deleted, so the
   * pushes recorded in its activity stand in: one per new head commit, dated when it was pushed,
   * without a message.
   */
  private async pushes(repo: RepoRef, pullRequestId: number): Promise<Commit[]> {
    const activity = await this.paginate<BbActivity>(
      `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/activity?pagelen=50`,
    );
    const updates = activity
      .flatMap((a) => (a.update?.source.commit ? [a.update] : []))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const seen = new Set<string>();
    const commits: Commit[] = [];
    for (const u of updates) {
      const sha = u.source.commit?.hash ?? "";
      if (seen.has(sha)) continue;
      seen.add(sha);
      commits.push({
        sha,
        date: u.date,
        message: "",
        ...(u.author ? { author: person(u.author) } : {}),
      });
    }
    return commits;
  }

  async openPullRequest(repo: RepoRef, pr: NewPullRequest): Promise<{ id: number; url: string }> {
    const { body } = await requestJson(
      "Bitbucket",
      this.fetch,
      `${this.repoUrl(repo)}/pullrequests`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          title: pr.title,
          description: pr.body,
          source: { branch: { name: pr.sourceBranch } },
          destination: { branch: { name: pr.targetBranch } },
          close_source_branch: true,
        },
      },
    );
    const created = body as { id: number; links: { html: { href: string } } };
    return { id: created.id, url: created.links.html.href };
  }

  async mergePullRequest(repo: RepoRef, pullRequestId: number): Promise<void> {
    await requestJson(
      "Bitbucket",
      this.fetch,
      `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/merge`,
      {
        method: "POST",
        headers: this.headers(),
        body: { merge_strategy: "squash", close_source_branch: true },
      },
    );
  }

  /**
   * Bitbucket names reviewers by account, not nickname, so the logins are looked up among the
   * workspace's members (needs `read:workspace:bitbucket`). The PR's reviewer list is replaced
   * wholesale, so it is sent back with the existing reviewers kept.
   */
  async requestReviewers(repo: RepoRef, pullRequestId: number, logins: string[]): Promise<void> {
    if (logins.length === 0) return;
    const members = await this.workspaceMembers(repo.owner);
    const added = logins.map((login) => {
      const user = members.find((u) => u.nickname?.toLowerCase() === login.toLowerCase());
      if (!user?.uuid) throw new Error(`${login} is not a member of the ${repo.owner} workspace`);
      return user.uuid;
    });
    const url = `${this.repoUrl(repo)}/pullrequests/${pullRequestId}`;
    const { body } = await requestJson("Bitbucket", this.fetch, url, { headers: this.headers() });
    const pr = body as { title: string; reviewers?: BbUser[] };
    const uuids = [...new Set([...(pr.reviewers ?? []).flatMap((r) => r.uuid ?? []), ...added])];
    await requestJson("Bitbucket", this.fetch, url, {
      method: "PUT",
      headers: this.headers(),
      body: { title: pr.title, reviewers: uuids.map((uuid) => ({ uuid })) },
    });
  }

  private workspaceMembers(workspace: string): Promise<BbUser[]> {
    let members = this.members.get(workspace);
    if (!members) {
      members = this.paginate<{ user: BbUser }>(
        `${this.baseUrl}/workspaces/${encodeURIComponent(workspace)}/members?pagelen=100`,
      ).then((ms) => ms.map((m) => m.user));
      // A failed lookup is retried on the next call rather than cached.
      members.catch(() => this.members.delete(workspace));
      this.members.set(workspace, members);
    }
    return members;
  }

  private repoUrl(repo: RepoRef) {
    return `${this.baseUrl}/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  private async paginate<T>(url: string): Promise<T[]> {
    const all: T[] = [];
    let next: string | undefined = url;
    while (next) {
      const { body } = await requestJson("Bitbucket", this.fetch, next, {
        headers: this.headers(),
      });
      const page = body as BbPage<T>;
      all.push(...page.values);
      next = page.next;
    }
    return all;
  }
}
