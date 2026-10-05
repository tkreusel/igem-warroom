import { useMemo } from 'react';
import type { TeamSummary } from '../api';
import { fmtAgo, fmtCompact, regionLabel, sectionLabel } from '../format';
import { Sparkline } from './Sparkline';

export type Metric = 'c24h' | 'c7d' | 'commits' | 'heat';

export type Scope = 'all' | 'village' | 'watch';

export interface Filters {
  query: string;
  region: string;
  section: string;
  activeOnly: boolean;
  scope: Scope;
}

const METRICS: { key: Metric; label: string }[] = [
  { key: 'c24h', label: '24H' },
  { key: 'c7d', label: '7D' },
  { key: 'commits', label: 'TOTAL' },
  { key: 'heat', label: 'HEAT' },
];

interface Props {
  teams: TeamSummary[];
  visible: TeamSummary[];
  metric: Metric;
  onMetric: (m: Metric) => void;
  filters: Filters;
  onFilters: (f: Filters) => void;
  homeSlug: string;
  selectedId: number | null;
  onPick: (t: TeamSummary) => void;
  now: number;
}

export function Leaderboard({ teams, visible, metric, onMetric, filters, onFilters, homeSlug, selectedId, onPick, now }: Props) {
  const regions = useMemo(() => [...new Set(teams.map((t) => t.region).filter(Boolean) as string[])].sort(), [teams]);
  const sections = useMemo(() => [...new Set(teams.map((t) => t.section ?? 'other'))].sort(), [teams]);

  const ranked = useMemo(
    () => [...visible].sort((a, b) => b[metric] - a[metric] || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0)),
    [visible, metric],
  );
  const sparkMax = useMemo(() => Math.max(1, ...ranked.slice(0, 60).flatMap((t) => t.spark)), [ranked]);
  const home = teams.find((t) => t.slug === homeSlug);
  const homeIdx = ranked.findIndex((t) => t.slug === homeSlug);

  const fmtValue = (t: TeamSummary) => (metric === 'heat' ? t.heat.toFixed(1) : fmtCompact(t[metric]));

  return (
    <aside className="leaderboard panel">
      <div className="panel-title">
        <span>Leaderboard</span>
        <span className="muted">
          {visible.length}/{teams.length} teams
        </span>
      </div>

      <div className="seg" role="tablist">
        {METRICS.map((m) => (
          <button key={m.key} role="tab" aria-selected={metric === m.key} className={metric === m.key ? 'on' : ''} onClick={() => onMetric(m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="filters">
        <div className="seg seg-inline" role="tablist" aria-label="Scope">
          {(
            [
              ['all', 'All teams'],
              ['village', 'My village'],
              ['watch', `Watchlist (${teams.filter((t) => t.subscribed).length})`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filters.scope === k} className={filters.scope === k ? 'on' : ''} onClick={() => onFilters({ ...filters, scope: k })}>
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search team, city, country…"
          value={filters.query}
          onChange={(e) => onFilters({ ...filters, query: e.target.value })}
        />
        <div className="filter-row">
          <select value={filters.region} onChange={(e) => onFilters({ ...filters, region: e.target.value })}>
            <option value="">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {regionLabel(r)}
              </option>
            ))}
          </select>
          <select value={filters.section} onChange={(e) => onFilters({ ...filters, section: e.target.value })}>
            <option value="">All sections</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {sectionLabel(s === 'other' ? null : s)}
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={filters.activeOnly} onChange={(e) => onFilters({ ...filters, activeOnly: e.target.checked })} />
          Active in last 7 days only
        </label>
      </div>

      {home && (
        <button className={`lb-home ${selectedId === home.id ? 'sel' : ''}`} onClick={() => onPick(home)}>
          <span className="lb-home-tag">HOME</span>
          <span className="lb-name">{home.name}</span>
          <span className="lb-home-rank">{homeIdx >= 0 && home[metric] > 0 ? `#${homeIdx + 1}` : '—'}</span>
          <span className="lb-val">{fmtValue(home)}</span>
        </button>
      )}

      <ol className="lb-list">
        {ranked.map((t, i) => (
          <li key={t.id}>
            <button
              className={`lb-row ${t.slug === homeSlug ? 'home' : ''} ${selectedId === t.id ? 'sel' : ''}`}
              onClick={() => onPick(t)}
              title={`${t.name} — last commit ${fmtAgo(t.lastCommitAt, now)}`}
            >
              <span className="lb-rank">{t[metric] > 0 ? i + 1 : '—'}</span>
              <span className="lb-main">
                <span className="lb-name">
                  {t.subscribed && (
                    <span className="mark-watch" title="Watchlist">
                      ◆{' '}
                    </span>
                  )}
                  {t.sameVillage && !t.subscribed && t.slug !== homeSlug && (
                    <span className="mark-village" title="Same village">
                      ◌{' '}
                    </span>
                  )}
                  {t.name}
                </span>
                <span className="lb-sub">
                  {t.country} · {fmtAgo(t.lastCommitAt, now)}
                </span>
              </span>
              <Sparkline values={t.spark} max={sparkMax} width={56} height={16} />
              <span className="lb-val">{t.gitlabPath ? fmtValue(t) : '—'}</span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
