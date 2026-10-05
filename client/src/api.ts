export interface TeamSummary {
  id: number;
  slug: string;
  name: string;
  village: string | null;
  institution: string | null;
  city: string | null;
  country: string | null;
  region: string | null;
  section: string | null;
  status: string | null;
  lat: number | null;
  lng: number | null;
  coordSource: string | null;
  gitlabPath: string | null;
  synced: boolean;
  commits: number;
  lastCommitAt: number | null;
  c24h: number;
  c7d: number;
  c30d: number;
  additions: number;
  deletions: number;
  contributors: number;
  heat: number;
  spark: number[];
  rank7d: number | null;
  rankTotal: number | null;
  /** Parts registry counts; null until fetched or when the team has no registry organisation. */
  registry: { published: number; draft: number; screening: number } | null;
  subscribed: boolean;
  /** Same iGEM village as the home team. */
  sameVillage: boolean;
}

export interface TeamDetail extends TeamSummary {
  wikiUrl: string;
  repoUrl: string | null;
  regionRank7d: number | null;
  regionTeams: number;
  daily: { start: number; counts: number[] };
  hourWeekday: number[][];
  authors: { name: string; commits: number; additions: number; deletions: number; lastAt: number }[];
  recent: { sha: string; title: string; author: string; at: number; additions: number; deletions: number }[];
  pages: PageTouch[] | null;
  pageCoverage: { commits: number; detailed: number } | null;
  news: { id: number; at: number; headline: string; severity: string }[];
}

export interface PageTouch {
  path: string;
  commits: number;
  additions: number;
  deletions: number;
  lastAt: number;
  created: boolean;
}

export type Relation = 'home' | 'subscribed' | 'village' | 'other';

export interface NewsEvent {
  id: number;
  at: number;
  type: 'code-drop' | 'burst' | 'parts-drop' | 'milestone';
  severity: 'breaking' | 'flash';
  score: number;
  headline: string;
  kicker: string;
  team: { id: number; name: string; slug: string; country: string | null; village: string | null; lat: number | null; lng: number | null } | null;
  relation: Relation | null;
  detail: Record<string, unknown>;
  test?: boolean;
}

export interface BriefTeamRef {
  id: number;
  name: string;
  slug: string;
  country: string | null;
  village: string | null;
  relation: Relation;
}

export interface TeamDossier {
  team: BriefTeamRef;
  commits: number;
  additions: number;
  deletions: number;
  contributors: number;
  lastCommitAt: number | null;
  rank7d: number | null;
  rank7dBefore: number | null;
  recentCommits: { sha: string; title: string; author: string; at: number; additions: number; deletions: number }[];
  authors: { name: string; commits: number }[];
  pages: PageTouch[];
  pageCoverage: { commits: number; detailed: number };
  registry: { published: number; draft: number; screening: number; publishedChange: number | null; draftChange: number | null } | null;
  news: { at: number; headline: string; severity: string }[];
}

export interface Briefing {
  id: number | null;
  preview?: boolean;
  periodStart: number;
  periodEnd: number;
  generatedAt: number;
  timeZone: string;
  summary: string;
  freeze: { at: number; remainingMs: number };
  global: {
    commits: number;
    activeTeams: number;
    additions: number;
    deletions: number;
    newlyActive: BriefTeamRef[];
    partsPublished: number;
    registryTotals: { published: number; draft: number };
  };
  home: TeamDossier | null;
  village: {
    name: string;
    homeRank: number;
    teams: {
      team: BriefTeamRef;
      commits24h: number;
      lines24h: number;
      commits7d: number;
      published: number | null;
      draft: number | null;
      rank7d: number | null;
    }[];
  } | null;
  subscribed: TeamDossier[];
  topMovers: { team: BriefTeamRef; commits: number; additions: number; deletions: number; contributors: number }[];
  biggestDrops: { team: BriefTeamRef; commits: number; additions: number; deletions: number }[];
  climbers: { team: BriefTeamRef; rank: number; before: number | null; gain: number }[];
  wentQuiet: { team: BriefTeamRef; commitsBefore: number }[];
  partsLeaders: { team: BriefTeamRef; parts: number }[];
  news: { at: number; headline: string; severity: string; kicker: string; teamId: number | null }[];
}

export interface BriefingListItem {
  id: number;
  periodStart: number;
  periodEnd: number;
  createdAt: number;
  summary: string;
}

export interface FeedItem {
  teamId: number;
  teamName: string;
  slug: string;
  sha: string;
  title: string;
  author: string;
  at: number;
  additions: number;
  deletions: number;
}

export interface Budget {
  authenticated: boolean;
  remaining: number | null;
  resetAt: number | null;
  requestsMade: number;
  throttledUntil: number | null;
  pausedUntil: number | null;
}

export interface Meta {
  year: number;
  homeTeam: string;
  wikiFreezeAt: string;
  pollIntervalSec: number;
  serverTime: number;
  sync: {
    phase: 'idle' | 'teams' | 'backfill' | 'polling';
    teamsSyncedAt: number | null;
    lastPollAt: number | null;
    lastPollError: string | null;
    backfill: { total: number; done: number; errors: number; running: boolean };
  };
  budget: Budget;
  stats: { last24h: { commits: number; teams: number }; last7d: { commits: number; teams: number }; totalCommits: number };
}

/** SSE "commits" payload: a NewCommit joined with team name/slug. */
export interface LiveCommit {
  teamId: number;
  sha: string;
  committedAt: number;
  authorName: string;
  title: string;
  additions: number;
  deletions: number;
  name: string;
  slug: string;
}

// ---------- parts registry ----------

export interface RegistryBudget {
  windows: Record<'short' | 'medium' | 'large', { remaining: number | null; resetAt: number | null }>;
  requestsMade: number;
  waitingUntil: number | null;
}

export interface RegistryStatus {
  fullListAt: number | null;
  listing: boolean;
  lastLiveAt: number | null;
  lastError: string | null;
}

export interface RegistryOverview {
  totals: {
    published: number;
    draft: number;
    screening: number;
    rejected: number;
    documentation: number;
    summarised: number;
    withOrg: number;
    teamsPublishing: number;
    teamsDrafting: number;
    teams: number;
  };
  parts: { listed: number; attributed: number; created24h: number; created7d: number };
  daily: { start: number; counts: number[] };
  roles: { label: string; n: number }[];
  status: RegistryStatus;
  budget: RegistryBudget;
}

export interface RegistryTeamRow {
  id: number;
  slug: string;
  name: string;
  country: string | null;
  region: string | null;
  section: string | null;
  found: boolean | null;
  published: number;
  draft: number;
  screening: number;
  rejected: number;
  withDocs: number;
  documentation: number;
  partsKnown: number;
  new7d: number;
  lastPartAt: number | null;
  fetchedAt: number | null;
}

export interface RegistryPartRow {
  uuid: string;
  name: string;
  slug: string;
  title: string | null;
  role: string | null;
  seqLength: number | null;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
  teamCount: number;
  url: string;
}

export interface RegistryTeamDetail extends RegistryTeamRow {
  parts: RegistryPartRow[];
  history: { at: number; published: number; draft: number; screening: number; rejected: number }[];
  roles: { label: string; n: number }[];
  registryUrl: string;
}

export interface RegistryFeedItem {
  uuid: string;
  name: string;
  slug: string;
  title: string | null;
  role: string | null;
  seqLength: number | null;
  createdAt: number;
  updatedAt: number;
  url: string;
  teams: { id: number; name: string; slug: string }[];
  fresh?: boolean;
}

/** SSE "parts" payload. */
export interface LivePart {
  uuid: string;
  name: string;
  slug: string;
  title: string | null;
  role: string | null;
  seqLength: number | null;
  at: number;
  teams: { id: number; name: string; slug: string }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  meta: () => get<Meta>('/api/meta'),
  teams: () => get<TeamSummary[]>('/api/teams'),
  team: (id: number) => get<TeamDetail>(`/api/teams/${id}`),
  feed: (limit = 60) => get<FeedItem[]>(`/api/feed?limit=${limit}`),
  registryOverview: () => get<RegistryOverview>('/api/registry/overview'),
  registryTeams: () => get<RegistryTeamRow[]>('/api/registry/teams'),
  registryTeam: (id: number) => get<RegistryTeamDetail>(`/api/registry/teams/${id}`),
  registryFeed: (limit = 80) => get<RegistryFeedItem[]>(`/api/registry/feed?limit=${limit}`),
  subscribe: (id: number) => send('PUT', `/api/subscriptions/${id}`),
  unsubscribe: (id: number) => send('DELETE', `/api/subscriptions/${id}`),
  news: (limit = 50) => get<NewsEvent[]>(`/api/news?limit=${limit}`),
  testNews: () => send('POST', '/api/news/test'),
  briefings: () => get<{ items: BriefingListItem[]; nextAt: number }>('/api/briefings'),
  briefing: (id: number) => get<Briefing>(`/api/briefings/${id}`),
  briefingPreview: () => get<Briefing>('/api/briefings/preview'),
};

async function send(method: string, path: string) {
  const res = await fetch(path, { method });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}
