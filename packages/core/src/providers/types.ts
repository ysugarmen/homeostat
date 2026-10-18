/** A repository on a git host. On Bitbucket `owner` is the workspace and `name` the repo slug. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** A git-host account. `id` is the stable handle (Bitbucket nickname, GitHub login). */
export interface Person {
  id: string;
  name?: string;
}

export interface PullRequest {
  id: number;
  title: string;
  url: string;
  author: Person;
  /** ISO timestamp. Bitbucket has no merge time, so there it is the PR's last update. */
  mergedAt: string;
  sourceBranch: string;
  targetBranch: string;
  /** Set when the PR carries the `homeostat:skip` marker (label, title or description). */
  skipRequested?: true;
}

/** The marker that keeps a pull request out of the curator. */
export const SKIP_MARKER = "homeostat:skip";

export type OpenPullRequest = Omit<PullRequest, "mergedAt">;

/** One PR in full, for a person deciding on it. */
export interface PullRequestDetails extends OpenPullRequest {
  body: string;
  state: "open" | "merged" | "closed";
  createdAt: string;
  /** Who is asked to review it. */
  reviewers: Person[];
  /** Whether it conflicts with its target branch; undefined while the host can't tell. */
  conflicts?: boolean;
}

export interface ReviewComment {
  id: number;
  body: string;
  author: Person;
  createdAt: string;
  url: string;
  /** Set for inline comments on a file. */
  path?: string;
  line?: number;
  /** Id of the comment this replies to. */
  inReplyTo?: number;
}

export interface Commit {
  sha: string;
  date: string;
  message: string;
  author?: Person;
}

export interface NewPullRequest {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
}

/**
 * What the agents and `homeostat review` need from a git host. Reads span every configured code
 * repo; every write targets the KB repo. Branch content is pushed with git, not through here.
 */
export interface Provider {
  readonly kind: "bitbucket" | "github";
  listMergedPullRequests(repo: RepoRef, since: Date): Promise<PullRequest[]>;
  listOpenPullRequests(repo: RepoRef): Promise<OpenPullRequest[]>;
  listReviewComments(repo: RepoRef, pullRequestId: number): Promise<ReviewComment[]>;
  listCommits(repo: RepoRef, pullRequestId: number): Promise<Commit[]>;
  openPullRequest(repo: RepoRef, pr: NewPullRequest): Promise<{ id: number; url: string }>;
  /** Squash-merges a PR on the KB repo; used only for entries that pass every auto-merge gate. */
  mergePullRequest(repo: RepoRef, pullRequestId: number): Promise<void>;
  getPullRequest(repo: RepoRef, pullRequestId: number): Promise<PullRequestDetails>;
  /** The PR's changes as a unified diff. */
  getPullRequestDiff(repo: RepoRef, pullRequestId: number): Promise<string>;
  /** Closes (on Bitbucket, declines) a PR on the KB repo without merging it. */
  closePullRequest(repo: RepoRef, pullRequestId: number): Promise<void>;
  commentOnPullRequest(repo: RepoRef, pullRequestId: number, body: string): Promise<void>;
  /** Asks these git-host users (GitHub logins or Bitbucket nicknames, no @) to review. */
  requestReviewers?(repo: RepoRef, pullRequestId: number, logins: string[]): Promise<void>;
}

export interface ProviderOptions {
  /** Access token owned by the team (see the permissions model in the execution plan). */
  token: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** API base URL, for self-hosted or proxied instances. */
  baseUrl?: string;
}
