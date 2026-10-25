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
  /** The commit the host has for the PR's source; it lags a force push for a while. */
  headSha?: string;
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
  /**
   * Squash-merges a PR on the KB repo. `message` is the squash commit's message, so a branch's
   * `[skip ci]` commits never reach the base branch's message.
   */
  mergePullRequest(
    repo: RepoRef,
    pullRequestId: number,
    opts?: { message?: string },
  ): Promise<void>;
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
  /**
   * Bitbucket only: the Atlassian account email that owns `token`. With it, `token` is an API
   * token, sent as Basic auth; without it, an access token, sent as Bearer.
   */
  user?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** API base URL, for self-hosted or proxied instances. */
  baseUrl?: string;
}

/** A repository as `homeostat setup` needs it: its default branch and whether the token can push. */
export interface RepoInfo {
  /** owner/name as the host spells it. */
  fullName: string;
  defaultBranch: string;
  private?: boolean;
  /** Whether the token may push; undefined when the host does not say. */
  canWrite?: boolean;
}

/** A Pipelines repository variable. A secured one's value is never returned. */
export interface RepoVariable {
  uuid: string;
  key: string;
  secured: boolean;
}

/** A Pipelines schedule that runs a custom pipeline on a branch. */
export interface PipelineSchedule {
  uuid: string;
  /** The custom pipeline's name (the selector pattern). */
  pipeline: string;
  branch: string;
  /** Bitbucket's seven-field cron (seconds first, `?` for one of the day fields), in UTC. */
  cron: string;
  enabled: boolean;
}

/**
 * The calls `homeostat setup` makes beyond the agents' needs. Members, repos and folders exist on
 * both hosts; variables and schedules on Bitbucket; Actions secrets and permissions on GitHub
 * (GitHub secrets are written with `gh`, since the REST API needs them encrypted first).
 */
export interface HostSetup {
  readonly kind: "bitbucket" | "github";
  /**
   * Bitbucket: the workspace's members (nickname, display name). GitHub: the org's members,
   * else the repo's collaborators when the owner is a user.
   */
  listMembers(repo: RepoRef): Promise<Person[]>;
  getRepository(repo: RepoRef): Promise<RepoInfo>;
  /** Throws unless the token can read the repo's pull requests (reads at most one). */
  probePullRequests(repo: RepoRef): Promise<void>;
  /** The names of the folders at the top of `branch`. */
  topLevelFolders(repo: RepoRef, branch: string): Promise<string[]>;
  listVariables?(repo: RepoRef): Promise<RepoVariable[]>;
  /** Creates the variable, or updates the one with this key. */
  setVariable?(repo: RepoRef, key: string, value: string, secured: boolean): Promise<void>;
  listSchedules?(repo: RepoRef): Promise<PipelineSchedule[]>;
  createSchedule?(
    repo: RepoRef,
    schedule: { pipeline: string; branch: string; cron: string },
  ): Promise<void>;
  enableSchedule?(repo: RepoRef, uuid: string): Promise<void>;
  /** GitHub: the names of the repo's Actions secrets (needs admin). */
  listSecretNames?(repo: RepoRef): Promise<string[]>;
  /** GitHub: whether Actions may run in the repo. */
  actionsEnabled?(repo: RepoRef): Promise<boolean>;
}
