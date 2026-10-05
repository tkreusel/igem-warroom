import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { HttpError, Semaphore, sleep } from './http.ts';

export interface GitlabProject {
  id: number;
  path: string;
  path_with_namespace: string;
  created_at: string;
  last_activity_at: string;
  default_branch: string | null;
  web_url: string;
  namespace: { full_path: string };
}

export interface GitlabCommit {
  id: string;
  title: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  committed_date: string;
  stats?: { additions: number; deletions: number; total: number };
}

export interface Budget {
  authenticated: boolean;
  remaining: number | null;
  resetAt: number | null; // ms epoch
  requestsMade: number;
  /** Hard throttle after a 429: every request waits. */
  throttledUntil: number | null;
  /** Background work paused to keep the reserve for live polling. */
  pausedUntil: number | null;
}

interface RequestOptions {
  /** Critical requests (live polling) may dip into the reserved budget. */
  critical?: boolean;
}

/**
 * GitLab REST client that respects the instance's rate limit.
 * Anonymous access on gitlab.igem.org is limited to 600 requests/hour, so we track
 * RateLimit-Remaining / RateLimit-Reset and pause non-critical work before running dry.
 */
class GitlabClient extends EventEmitter {
  readonly budget: Budget = {
    authenticated: Boolean(config.gitlabToken),
    remaining: null,
    resetAt: null,
    requestsMade: 0,
    throttledUntil: null,
    pausedUntil: null,
  };
  private readonly sem = new Semaphore(config.gitlabConcurrency);

  private async waitForBudget(critical: boolean) {
    for (;;) {
      const { remaining, resetAt, throttledUntil } = this.budget;
      const now = Date.now();
      if (throttledUntil && throttledUntil > now) {
        await sleep(Math.min(throttledUntil - now, 60_000));
        continue;
      }
      const floor = critical ? 2 : config.gitlabReserve;
      if (remaining !== null && resetAt !== null && remaining <= floor && resetAt > now) {
        // Background work pauses here; critical requests can still use the reserve below the floor.
        if (!critical) {
          this.budget.pausedUntil = resetAt + 1_000;
          this.emit('budget', this.budget);
        }
        await sleep(Math.min(resetAt + 1_000 - now, 60_000));
        continue;
      }
      if (!critical && this.budget.pausedUntil) {
        this.budget.pausedUntil = null;
        this.emit('budget', this.budget);
      }
      return;
    }
  }

  private updateBudget(headers: Headers) {
    const remaining = headers.get('ratelimit-remaining');
    const reset = headers.get('ratelimit-reset');
    if (remaining !== null) this.budget.remaining = Number(remaining);
    if (reset !== null) this.budget.resetAt = Number(reset) * 1000;
    this.emit('budget', this.budget);
  }

  async request<T>(path: string, params: Record<string, string | number | boolean> = {}, opts: RequestOptions = {}) {
    const url = new URL(config.gitlabApi + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      await this.waitForBudget(Boolean(opts.critical));
      const res = await this.sem.run(async () => {
        // Optimistic local decrement so concurrent workers don't overshoot.
        if (this.budget.remaining !== null) this.budget.remaining--;
        this.budget.requestsMade++;
        return fetch(url, {
          headers: config.gitlabToken ? { 'PRIVATE-TOKEN': config.gitlabToken } : {},
          signal: AbortSignal.timeout(30_000),
        });
      });
      this.updateBudget(res.headers);

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? 60);
        this.budget.throttledUntil = Date.now() + retryAfter * 1000;
        this.emit('budget', this.budget);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(2 ** attempt * 2000);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url.toString(), await res.text());
      return { data: (await res.json()) as T, headers: res.headers };
    }
  }

  /** Follow X-Next-Page until exhausted, `maxPages` is reached, or `stop` returns true for a page. */
  async paginate<T>(
    path: string,
    params: Record<string, string | number | boolean> = {},
    opts: RequestOptions & { maxPages?: number; stop?: (page: T[]) => boolean } = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (let n = 0; n < (opts.maxPages ?? Infinity); n++) {
      const { data, headers } = await this.request<T[]>(path, { ...params, page, per_page: 100 }, opts);
      out.push(...data);
      const next = headers.get('x-next-page');
      if (!next || opts.stop?.(data)) break;
      page = Number(next);
    }
    return out;
  }

  /**
   * All projects in the competition namespace. The group itself is hidden from anonymous users,
   * but namespace search over public projects works (~6 requests for every team).
   */
  async listYearProjects(year: number): Promise<GitlabProject[]> {
    const all = await this.paginate<GitlabProject>('/projects', {
      search: String(year),
      search_namespaces: true,
      simple: true,
      order_by: 'id',
      sort: 'asc',
    });
    return all.filter((p) => p.namespace.full_path === String(year));
  }

  /** Projects in the competition namespace with activity after `since` (cheap change detection). */
  async listActiveProjectsSince(year: number, since: Date): Promise<GitlabProject[]> {
    const all = await this.paginate<GitlabProject>(
      '/projects',
      {
        last_activity_after: since.toISOString(),
        order_by: 'last_activity_at',
        sort: 'desc',
        simple: true,
      },
      { critical: true },
    );
    return all.filter((p) => p.namespace.full_path === String(year));
  }

  async getProject(pathWithNamespace: string) {
    return (await this.request<GitlabProject>(`/projects/${encodeURIComponent(pathWithNamespace)}`)).data;
  }

  /** Commits on the default branch, newest first. */
  async listCommits(
    projectId: number,
    opts: { since?: Date; critical?: boolean; stop?: (page: GitlabCommit[]) => boolean } = {},
  ) {
    const params: Record<string, string | number | boolean> = { with_stats: true };
    if (opts.since) params.since = opts.since.toISOString();
    return this.paginate<GitlabCommit>(`/projects/${projectId}/repository/commits`, params, opts);
  }

  /** Per-file diffs of one commit (paginated; wiki commits rarely exceed one page). */
  async commitDiff(projectId: number, sha: string) {
    return this.paginate<GitlabDiff>(`/projects/${projectId}/repository/commits/${sha}/diff`, {}, { maxPages: 3 });
  }
}

export interface GitlabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

export const gitlab = new GitlabClient();
