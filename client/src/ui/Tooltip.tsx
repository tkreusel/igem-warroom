import type { TeamSummary } from '../api';
import { fmtAgo, fmtInt, regionLabel, sectionLabel } from '../format';
import { Sparkline } from './Sparkline';

interface Props {
  team: TeamSummary;
  x: number;
  y: number;
  now: number;
}

export function Tooltip({ team, x, y, now }: Props) {
  // Flip to the other side of the cursor near the right/bottom edges.
  const left = x + 300 > window.innerWidth ? x - 296 : x + 16;
  const top = y + 200 > window.innerHeight ? y - 196 : y + 16;
  return (
    <div className="tooltip" style={{ left, top }}>
      <div className="tt-head">
        <span className="tt-name">{team.name}</span>
        <span className="tt-sub">
          {team.city}, {team.country} · {regionLabel(team.region)} · {sectionLabel(team.section)}
        </span>
        {team.coordSource === 'city' && <span className="tt-sub">Location approximate (city centre)</span>}
        {(team.subscribed || team.sameVillage || team.village) && (
          <span className="tt-tags">
            {team.subscribed && <span className="tag tag-watch">◆ WATCHLIST</span>}
            {team.sameVillage && <span className="tag tag-village">VILLAGE RIVAL</span>}
            {team.village && <span className="muted">{team.village}</span>}
          </span>
        )}
      </div>
      {!team.gitlabPath ? (
        <div className="tt-note">No public wiki repository</div>
      ) : (
        <>
          <div className="tt-grid">
            <span>Last commit</span>
            <b>{fmtAgo(team.lastCommitAt, now)}</b>
            <span>24h / 7d</span>
            <b>
              {team.c24h} / {team.c7d}
            </b>
            <span>Total commits</span>
            <b>{fmtInt(team.commits)}</b>
            <span>Contributors</span>
            <b>{team.contributors}</b>
            <span>Rank (7d)</span>
            <b>{team.rank7d ? `#${team.rank7d}` : '—'}</b>
          </div>
          {team.registry && (
            <div className="tt-reg">
              <span>Registry parts</span>
              <b>
                <span className="v-published">{team.registry.published}</span>{' '}
                {team.registry.screening > 0 && <span className="v-screening">{team.registry.screening}</span>}{' '}
                <span className="v-draft">{team.registry.draft}</span>
              </b>
            </div>
          )}
          <div className="tt-spark">
            <span>14 days</span>
            <Sparkline values={team.spark} width={150} height={22} />
          </div>
          {!team.synced && <div className="tt-note">History still syncing…</div>}
        </>
      )}
    </div>
  );
}
