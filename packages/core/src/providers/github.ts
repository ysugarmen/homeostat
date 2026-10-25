import { ProviderError, requestJson } from "./http.ts";
import {
  type Commit,
  type HostSetup,
  type NewPullRequest,
  type OpenPullRequest,
  type Person,
  type Provider,
  type ProviderOptions,
  type PullRequest,
  type PullRequestDetails,
  type RepoInfo,
  type RepoRef,
  type ReviewComment,
  SKIP_MARKER,
} from "./types.ts";

interface GhUser {
  login: string;
}

interface GhPullRequest {
  number: number;
  title: string;
  html_url: string;
  user: GhUser;
  updated_at: string;
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
  body?: string | null;
  labels?: { name: string }[];
}

/** The single-PR view adds what the list leaves out. */
interface GhPullRequestDetails extends GhPullRequest {
  state: "open" | "closed";
  created_at: string;
  requested_reviewers?: GhUser[];
  mergeable: boolean | null;
  mergeable_state?: string;
}

interface GhReviewComment {
  id: number;
  body: string;
  user: GhUser;
  path: string;
  line: number | null;
  original_line?: number | null;
  in_reply_to_id?: number;
  created_at: string;
  html_url: string;
}

interface GhCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: GhUser | null;
}

/** Finds the `rel="next"` URL in a GitHub `Link` header. */
function nextLink(header: string | null): string | undefined {
  return header?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}

/**
 * GitHub REST API. Auth is the workflow's `GITHUB_TOKEN` for the same repo, or a fine-grained
 * PAT / GitHub App token when reading other repos in the org.
 */
export class GitHubProvider implements Provider, HostSetup {
  readonly kind = "github";
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: ProviderOptions) {
    this.token = opts.token;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
  }

  /** Walks closed PRs newest-updated first and stops at the first page older than `since`. */
  async listMergedPullRequests(repo: RepoRef, since: Date): Promise<PullRequest[]> {
    const merged: PullRequest[] = [];
    let next: string | undefined =
      `${this.repoUrl(repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
    while (next) {
      const { body, headers } = await this.get(next);
      const page = body as GhPullRequest[];
      for (const pr of page) {
        if (pr.merged_at && new Date(pr.merged_at) >= since) {
          merged.push({
            id: pr.number,
            title: pr.title,
            url: pr.html_url,
            author: { id: pr.user.login },
            mergedAt: pr.merged_at,
            sourceBranch: pr.head.ref,
            targetBranch: pr.base.ref,
            ...(pr.labels?.some((l) => l.name === SKIP_MARKER) ||
            `${pr.title}\n${pr.body ?? ""}`.includes(SKIP_MARKER)
              ? { skipRequested: true as const }
              : {}),
          });
        }
      }
      const oldest = page.at(-1);
      next =
        oldest && new Date(oldest.updated_at) >= since ? nextLink(headers.get("link")) : undefined;
    }
    return merged;
  }

  /** Inline review comments. Outdated comments have no `line`, so the original line is used. */
  async listOpenPullRequests(repo: RepoRef): Promise<OpenPullRequest[]> {
    const prs = await this.paginate<GhPullRequest>(
      `${this.repoUrl(repo)}/pulls?state=open&per_page=100`,
    );
    return prs.map((pr) => ({
      id: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: { id: pr.user.login },
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
    }));
  }

  async listReviewComments(repo: RepoRef, pullRequestId: number): Promise<ReviewComment[]> {
    const comments = await this.paginate<GhReviewComment>(
      `${this.repoUrl(repo)}/pulls/${pullRequestId}/comments?per_page=100`,
    );
    return comments.map((c) => {
      const line = c.line ?? c.original_line ?? undefined;
      return {
        id: c.id,
        body: c.body,
        author: { id: c.user.login },
        createdAt: c.created_at,
        url: c.html_url,
        path: c.path,
        ...(line != null ? { line } : {}),
        ...(c.in_reply_to_id !== undefined ? { inReplyTo: c.in_reply_to_id } : {}),
      };
    });
  }

  async listCommits(repo: RepoRef, pullRequestId: number): Promise<Commit[]> {
    const commits = await this.paginate<GhCommit>(
      `${this.repoUrl(repo)}/pulls/${pullRequestId}/commits?per_page=100`,
    );
    return commits.map((c) => ({
      sha: c.sha,
      date: c.commit.author?.date ?? "",
      message: c.commit.message.trimEnd(),
      ...(c.author
        ? {
            author: {
              id: c.author.login,
              ...(c.commit.author ? { name: c.commit.author.name } : {}),
            },
          }
        : {}),
    }));
  }

  async openPullRequest(repo: RepoRef, pr: NewPullRequest): Promise<{ id: number; url: string }> {
    const { body } = await requestJson("GitHub", this.fetch, `${this.repoUrl(repo)}/pulls`, {
      method: "POST",
      headers: this.headers(),
      body: { title: pr.title, body: pr.body, head: pr.sourceBranch, base: pr.targetBranch },
    });
    const created = body as { number: number; html_url: string };
    return { id: created.number, url: created.html_url };
  }

  /** GitHub works mergeability out in the background: `mergeable` is null until it has. */
  async getPullRequest(repo: RepoRef, pullRequestId: number): Promise<PullRequestDetails> {
    const { body } = await this.get(`${this.repoUrl(repo)}/pulls/${pullRequestId}`);
    const pr = body as GhPullRequestDetails;
    return {
      id: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: { id: pr.user.login },
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      body: pr.body ?? "",
      state: pr.merged_at ? "merged" : pr.state,
      createdAt: pr.created_at,
      reviewers: (pr.requested_reviewers ?? []).map((u) => ({ id: u.login })),
      ...(pr.mergeable === null ? {} : { conflicts: pr.mergeable_state === "dirty" }),
    };
  }

  async getPullRequestDiff(repo: RepoRef, pullRequestId: number): Promise<string> {
    const { body } = await requestJson(
      "GitHub",
      this.fetch,
      `${this.repoUrl(repo)}/pulls/${pullRequestId}`,
      { headers: { ...this.headers(), Accept: "application/vnd.github.diff" } },
    );
    return String(body ?? "");
  }

  async closePullRequest(repo: RepoRef, pullRequestId: number): Promise<void> {
    await requestJson("GitHub", this.fetch, `${this.repoUrl(repo)}/pulls/${pullRequestId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: { state: "closed" },
    });
  }

  /** A PR's conversation comments live on its issue. */
  async commentOnPullRequest(repo: RepoRef, pullRequestId: number, text: string): Promise<void> {
    await requestJson(
      "GitHub",
      this.fetch,
      `${this.repoUrl(repo)}/issues/${pullRequestId}/comments`,
      { method: "POST", headers: this.headers(), body: { body: text } },
    );
  }

  async requestReviewers(repo: RepoRef, pullRequestId: number, logins: string[]): Promise<void> {
    if (logins.length === 0) return;
    await requestJson(
      "GitHub",
      this.fetch,
      `${this.repoUrl(repo)}/pulls/${pullRequestId}/requested_reviewers`,
      { method: "POST", headers: this.headers(), body: { reviewers: logins } },
    );
  }

  async mergePullRequest(
    repo: RepoRef,
    pullRequestId: number,
    opts: { message?: string } = {},
  ): Promise<void> {
    await requestJson("GitHub", this.fetch, `${this.repoUrl(repo)}/pulls/${pullRequestId}/merge`, {
      method: "PUT",
      headers: this.headers(),
      body: {
        merge_method: "squash",
        ...(opts.message
          ? { commit_title: `${opts.message} (#${pullRequestId})`, commit_message: "" }
          : {}),
      },
    });
  }

  /** The org's members; for a repo owned by a user (the orgs call 404s), its collaborators. */
  async listMembers(repo: RepoRef): Promise<Person[]> {
    let users: GhUser[];
    try {
      users = await this.paginate<GhUser>(
        `${this.baseUrl}/orgs/${encodeURIComponent(repo.owner)}/members?per_page=100`,
      );
    } catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 404) throw e;
      users = await this.paginate<GhUser>(`${this.repoUrl(repo)}/collaborators?per_page=100`);
    }
    return users.map((u) => ({ id: u.login }));
  }

  async getRepository(repo: RepoRef): Promise<RepoInfo> {
    const { body } = await this.get(this.repoUrl(repo));
    const r = body as {
      full_name: string;
      default_branch: string;
      private?: boolean;
      permissions?: { push?: boolean };
    };
    return {
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      ...(r.private === undefined ? {} : { private: r.private }),
      ...(r.permissions ? { canWrite: r.permissions.push === true } : {}),
    };
  }

  async probePullRequests(repo: RepoRef): Promise<void> {
    await this.get(`${this.repoUrl(repo)}/pulls?state=all&per_page=1`);
  }

  async topLevelFolders(repo: RepoRef, branch: string): Promise<string[]> {
    const { body } = await this.get(
      `${this.repoUrl(repo)}/contents/?ref=${encodeURIComponent(branch)}`,
    );
    return (body as { name: string; type: string }[])
      .filter((i) => i.type === "dir")
      .map((i) => i.name);
  }

  async listSecretNames(repo: RepoRef): Promise<string[]> {
    const { body } = await this.get(`${this.repoUrl(repo)}/actions/secrets?per_page=100`);
    return (body as { secrets: { name: string }[] }).secrets.map((s) => s.name);
  }

  async actionsEnabled(repo: RepoRef): Promise<boolean> {
    const { body } = await this.get(`${this.repoUrl(repo)}/actions/permissions`);
    return (body as { enabled: boolean }).enabled === true;
  }

  private repoUrl(repo: RepoRef) {
    return `${this.baseUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private get(url: string) {
    return requestJson("GitHub", this.fetch, url, { headers: this.headers() });
  }

  private async paginate<T>(url: string): Promise<T[]> {
    const all: T[] = [];
    let next: string | undefined = url;
    while (next) {
      const { body, headers } = await this.get(next);
      all.push(...(body as T[]));
      next = nextLink(headers.get("link"));
    }
    return all;
  }
}
