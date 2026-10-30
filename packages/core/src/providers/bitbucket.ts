import { idempotentWrite, ProviderError, requestJson } from "./http.ts";
import {
  type Commit,
  type HostSetup,
  type NewPullRequest,
  type OpenPullRequest,
  type Person,
  type PipelineSchedule,
  type Provider,
  type ProviderOptions,
  type PullRequest,
  type PullRequestDetails,
  type RepoInfo,
  type RepoRef,
  type RepoVariable,
  type ReviewComment,
  SKIP_MARKER,
} from "./types.ts";

interface BbSchedule {
  uuid: string;
  enabled: boolean;
  cron_pattern: string;
  target?: { ref_name?: string; selector?: { type?: string; pattern?: string } };
}

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
  source: { branch: { name: string }; commit?: { hash: string } };
  destination: { branch: { name: string } };
  links: { html: { href: string } };
}

interface BbPullRequestDetails extends BbPullRequest {
  state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  created_on: string;
  reviewers?: BbUser[];
}

interface BbMergeabilityCheck {
  type: string;
  reason?: "clean" | "conflicts" | "merge_impossible";
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

/**
 * The Authorization header for a Bitbucket token: an access token (workspace, project or
 * repository) is Bearer; an Atlassian API token is Basic with its account email.
 */
export function bitbucketAuth(token: string, user?: string): string {
  return user ? `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` : `Bearer ${token}`;
}

/** Bitbucket Cloud REST 2.0, with an access token or an account's API token (see bitbucketAuth). */
export class BitbucketProvider implements Provider, HostSetup {
  readonly kind = "bitbucket";
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly user: string | undefined;
  private readonly members = new Map<string, Promise<BbUser[]>>();
  private readonly sleep: (ms: number) => Promise<void>;
  /** Polls of an async merge, two seconds apart. */
  private readonly mergePolls = 60;

  constructor(opts: ProviderOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.token = opts.token;
    this.user = opts.user;
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

  async getPullRequest(repo: RepoRef, pullRequestId: number): Promise<PullRequestDetails> {
    const url = `${this.repoUrl(repo)}/pullrequests/${pullRequestId}`;
    const [{ body }, conflicts] = await Promise.all([
      requestJson("Bitbucket", this.fetch, url, { headers: this.headers() }),
      this.conflicts(url),
    ]);
    const pr = body as BbPullRequestDetails;
    return {
      id: pr.id,
      title: pr.title,
      url: pr.links.html.href,
      author: person(pr.author),
      sourceBranch: pr.source.branch.name,
      targetBranch: pr.destination.branch.name,
      body: pr.description ?? "",
      state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
      createdAt: pr.created_on,
      reviewers: (pr.reviewers ?? []).map(person),
      ...(conflicts === undefined ? {} : { conflicts }),
      ...(pr.source.commit?.hash ? { headSha: pr.source.commit.hash } : {}),
    };
  }

  /**
   * Bitbucket's own pre-merge evaluation; its git check says whether the PR conflicts. Undefined
   * when Bitbucket could not evaluate it, or the PR is no longer open.
   */
  private async conflicts(prUrl: string): Promise<boolean | undefined> {
    try {
      const { body } = await requestJson("Bitbucket", this.fetch, `${prUrl}/mergeability/checks`, {
        headers: this.headers(),
      });
      const checks = (body as { values: BbMergeabilityCheck[] }).values;
      const reason = checks.find((c) => c.type === "git_mergeability_check")?.reason;
      return reason === undefined ? undefined : reason !== "clean";
    } catch {
      return undefined;
    }
  }

  /** Bitbucket redirects to the repository diff for the PR's revisions. */
  async getPullRequestDiff(repo: RepoRef, pullRequestId: number): Promise<string> {
    const { body } = await requestJson(
      "Bitbucket",
      this.fetch,
      `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/diff`,
      { headers: { ...this.headers(), Accept: "text/plain" } },
    );
    return String(body ?? "");
  }

  async closePullRequest(repo: RepoRef, pullRequestId: number): Promise<void> {
    await requestJson(
      "Bitbucket",
      this.fetch,
      `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/decline`,
      { method: "POST", headers: this.headers() },
    );
  }

  async commentOnPullRequest(repo: RepoRef, pullRequestId: number, text: string): Promise<void> {
    await requestJson(
      "Bitbucket",
      this.fetch,
      `${this.repoUrl(repo)}/pullrequests/${pullRequestId}/comments`,
      { method: "POST", headers: this.headers(), body: { content: { raw: text } } },
    );
  }

  async openPullRequest(repo: RepoRef, pr: NewPullRequest): Promise<{ id: number; url: string }> {
    return idempotentWrite(
      () => this.createPullRequest(repo, pr),
      async () => {
        const open = (await this.listOpenPullRequests(repo)).find(
          (p) => p.sourceBranch === pr.sourceBranch && p.targetBranch === pr.targetBranch,
        );
        return open ? { value: { id: open.id, url: open.url } } : undefined;
      },
    );
  }

  private async createPullRequest(
    repo: RepoRef,
    pr: NewPullRequest,
  ): Promise<{ id: number; url: string }> {
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

  /**
   * Merges asynchronously: a squash merge of a large PR can outlast the request, and Bitbucket then
   * merges without ever answering. It returns a task to poll instead; if that runs out, the PR's
   * own state decides.
   */
  async mergePullRequest(
    repo: RepoRef,
    pullRequestId: number,
    opts: { message?: string } = {},
  ): Promise<void> {
    const url = `${this.repoUrl(repo)}/pullrequests/${pullRequestId}`;
    const merged = async () => {
      const { body: pr } = await requestJson("Bitbucket", this.fetch, url, {
        headers: this.headers(),
      });
      return (pr as { state?: string }).state === "MERGED";
    };
    const { body, headers } = await idempotentWrite(
      () =>
        requestJson("Bitbucket", this.fetch, `${url}/merge?async=true`, {
          method: "POST",
          headers: this.headers(),
          body: {
            merge_strategy: "squash",
            close_source_branch: true,
            ...(opts.message ? { message: opts.message } : {}),
          },
        }),
      async () =>
        (await merged())
          ? { value: { body: { state: "MERGED" }, headers: new Headers() } }
          : undefined,
    );
    const task = headers.get("location");
    if (!task || (body as { state?: string } | undefined)?.state === "MERGED") return;
    for (let i = 0; i < this.mergePolls; i++) {
      await this.sleep(2000);
      const { body: status } = await requestJson("Bitbucket", this.fetch, task, {
        headers: this.headers(),
      });
      if ((status as { task_status?: string }).task_status === "SUCCESS") return;
    }
    const { body: pr } = await requestJson("Bitbucket", this.fetch, url, {
      headers: this.headers(),
    });
    if ((pr as { state?: string }).state === "MERGED") return;
    throw new ProviderError(
      "Bitbucket",
      504,
      url,
      "the merge did not finish in time; check the PR",
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

  /** Everyone in the repo's workspace, by nickname: the handle reviewers are asked by. */
  async listMembers(repo: RepoRef): Promise<Person[]> {
    const members = await this.workspaceMembers(repo.owner);
    return members.filter((u) => u.nickname).map(person);
  }

  async getRepository(repo: RepoRef): Promise<RepoInfo> {
    const { body } = await requestJson("Bitbucket", this.fetch, this.repoUrl(repo), {
      headers: this.headers(),
    });
    const r = body as { full_name: string; is_private?: boolean; mainbranch?: { name: string } };
    return {
      fullName: r.full_name,
      defaultBranch: r.mainbranch?.name ?? "main",
      ...(r.is_private === undefined ? {} : { private: r.is_private }),
    };
  }

  async probePullRequests(repo: RepoRef): Promise<void> {
    await requestJson("Bitbucket", this.fetch, `${this.repoUrl(repo)}/pullrequests?pagelen=1`, {
      headers: this.headers(),
    });
  }

  /** The `src` listing of the branch's root; folders are `commit_directory` entries. */
  async topLevelFolders(repo: RepoRef, branch: string): Promise<string[]> {
    const items = await this.paginate<{ path: string; type: string }>(
      `${this.repoUrl(repo)}/src/${encodeURIComponent(branch)}/?pagelen=100`,
    );
    return items.filter((i) => i.type === "commit_directory").map((i) => i.path);
  }

  async listVariables(repo: RepoRef): Promise<RepoVariable[]> {
    const vars = await this.paginate<{ uuid: string; key: string; secured?: boolean }>(
      `${this.repoUrl(repo)}/pipelines_config/variables/?pagelen=100`,
    );
    return vars.map((v) => ({ uuid: v.uuid, key: v.key, secured: v.secured === true }));
  }

  /** Updates the variable with this key by its uuid, or creates it. The value is only ever sent. */
  async setVariable(repo: RepoRef, key: string, value: string, secured: boolean): Promise<void> {
    const existing = (await this.listVariables(repo)).find((v) => v.key === key);
    const base = `${this.repoUrl(repo)}/pipelines_config/variables/`;
    const body = { key, value, secured };
    if (existing) {
      await requestJson("Bitbucket", this.fetch, `${base}${encodeURIComponent(existing.uuid)}`, {
        method: "PUT",
        headers: this.headers(),
        body: { ...body, uuid: existing.uuid },
      });
    } else {
      await requestJson("Bitbucket", this.fetch, base, {
        method: "POST",
        headers: this.headers(),
        body,
      });
    }
  }

  async listSchedules(repo: RepoRef): Promise<PipelineSchedule[]> {
    const items = await this.paginate<BbSchedule>(
      `${this.repoUrl(repo)}/pipelines_config/schedules/?pagelen=100`,
    );
    return items.map((s) => ({
      uuid: s.uuid,
      pipeline: s.target?.selector?.pattern ?? "",
      branch: s.target?.ref_name ?? "",
      cron: s.cron_pattern,
      enabled: s.enabled,
    }));
  }

  async createSchedule(
    repo: RepoRef,
    schedule: { pipeline: string; branch: string; cron: string },
  ): Promise<void> {
    await requestJson(
      "Bitbucket",
      this.fetch,
      `${this.repoUrl(repo)}/pipelines_config/schedules/`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          type: "pipeline_schedule",
          enabled: true,
          cron_pattern: schedule.cron,
          target: {
            type: "pipeline_ref_target",
            ref_type: "branch",
            ref_name: schedule.branch,
            selector: { type: "custom", pattern: schedule.pipeline },
          },
        },
      },
    );
  }

  async enableSchedule(repo: RepoRef, uuid: string): Promise<void> {
    await requestJson(
      "Bitbucket",
      this.fetch,
      `${this.repoUrl(repo)}/pipelines_config/schedules/${encodeURIComponent(uuid)}`,
      {
        method: "PUT",
        headers: this.headers(),
        body: { type: "pipeline_schedule", enabled: true },
      },
    );
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
    return { Authorization: bitbucketAuth(this.token, this.user), Accept: "application/json" };
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
