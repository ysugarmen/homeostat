import { requestJson } from "./http.ts";
import type {
  Commit,
  NewPullRequest,
  OpenPullRequest,
  Person,
  Provider,
  ProviderOptions,
  PullRequest,
  RepoRef,
  ReviewComment,
} from "./types.ts";

interface BbUser {
  display_name?: string;
  nickname?: string;
  account_id?: string;
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
    const commits = await this.paginate<BbCommit>(
      `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/commits?pagelen=100`,
    );
    return commits.map((c) => ({
      sha: c.hash,
      date: c.date,
      message: c.message.trimEnd(),
      ...(c.author.user ? { author: person(c.author.user) } : {}),
    }));
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
