import { useState, type ReactNode } from 'react';
import type { TeamDetail } from '../api';
import { fmtAgo, fmtInt, fmtUtc, regionLabel, sectionLabel } from '../format';
import { heatColor } from '../map/heat';
import { openRegistryWindow } from '../shared/channel';

interface Props {
  team: TeamDetail | null;
  loading: boolean;
  isHome: boolean;
  onClose: () => void;
  now: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY = 86400_000;

export function TeamPanel({ team, loading, isHome, onClose, now }: Props) {
  if (!team) {
    return (
      <aside className="team-panel panel">
        <div className="panel-title">
          <span>{loading ? 'Acquiring target…' : 'No target'}</span>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="team-panel panel">
      <div className="panel-title">
        <span>
          {isHome && <span className="tag tag-accent">HOME</span>} Target dossier
        </span>
        <button className="btn btn-icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="tp-head">
        <h2>{team.name}</h2>
        <div className="tp-sub">{team.institution}</div>
        <div className="tp-sub muted">
          {team.village ? `${team.village} Village · ` : ''}{sectionLabel(team.section)}
          {team.status !== 'accepted' && <span className="tag tag-warn"> {team.status}</span>}
        </div>
        <div className="tp-sub muted">
          {team.city}, {team.country} · {regionLabel(team.region)}
        </div>
        <div className="tp-links">
          <a href={team.wikiUrl} target="_blank" rel="noreferrer">
            Live wiki ↗
          </a>
          {team.repoUrl && (
            <a href={team.repoUrl} target="_blank" rel="noreferrer">
              GitLab repo ↗
            </a>
          )}
        </div>
      </div>

      {!team.gitlabPath ? (
        <div className="tp-empty">No public wiki repository found for this team in the 2026 GitLab namespace.</div>
      ) : (
        <>
          <div className="tp-stats">
            <Stat label="Last commit" value={fmtAgo(team.lastCommitAt, now)} />
            <Stat label="Commits 24h" value={fmtInt(team.c24h)} />
            <Stat label="Commits 7d" value={fmtInt(team.c7d)} />
            <Stat label="Total commits" value={fmtInt(team.commits)} />
            <Stat label="Contributors" value={fmtInt(team.contributors)} />
            <Stat label="Lines +/−" value={`+${fmtInt(team.additions)} / −${fmtInt(team.deletions)}`} small />
            <Stat label="Rank 7d · world" value={team.rank7d ? `#${team.rank7d}` : '—'} />
            <Stat label={`Rank 7d · ${regionLabel(team.region)}`} value={team.regionRank7d ? `#${team.regionRank7d} / ${team.regionTeams}` : '—'} />
          </div>

          <Section title="Parts registry">
            {team.registry ? (
              <div className="tp-reg">
                <span className="v-published">{team.registry.published} published</span>
                <span className="v-screening">{team.registry.screening} screening</span>
                <span className="v-draft">{team.registry.draft} draft</span>
                <button className="btn btn-small-inline" onClick={() => openRegistryWindow(team.id)}>
                  Parts ↗
                </button>
              </div>
            ) : (
              <span className="muted">No registry counts yet.</span>
            )}
          </Section>

          <Section title="Commits per day · last 60 days">
            <DailyBars start={team.daily.start} counts={team.daily.counts} />
          </Section>

          <Section title="Weekly rhythm · approx. local time">
            <RhythmGrid matrix={team.hourWeekday} lng={team.lng ?? 0} />
          </Section>

          <Section title="Contributors">
            <table className="tp-table">
              <thead>
                <tr>
                  <th>Author</th>
                  <th className="num">Commits</th>
                  <th className="num">+/−</th>
                  <th className="num">Last</th>
                </tr>
              </thead>
              <tbody>
                {team.authors.map((a) => (
                  <tr key={a.name + a.lastAt}>
                    <td>{a.name}</td>
                    <td className="num">{a.commits}</td>
                    <td className="num muted">
                      +{fmtInt(a.additions)}/−{fmtInt(a.deletions)}
                    </td>
                    <td className="num muted">{fmtAgo(a.lastAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Recent commits">
            <ul className="tp-commits">
              {team.recent.map((c) => (
                <li key={c.sha}>
                  <div className="tp-commit-title">{c.title}</div>
                  <div className="tp-commit-meta">
                    <span>{c.author}</span>
                    <span title={fmtUtc(c.at)}>{fmtAgo(c.at, now)}</span>
                    <span className="delta">
                      <span className="add">+{fmtInt(c.additions)}</span> <span className="del">−{fmtInt(c.deletions)}</span>
                    </span>
                  </div>
                </li>
              ))}
              {team.recent.length === 0 && <li className="muted">No team commits yet.</li>}
            </ul>
          </Section>
        </>
      )}
    </aside>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${small ? 'small' : ''}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tp-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** 60-day daily bar chart with hover readout. `noun` names what is counted. */
export function DailyBars({
  start,
  counts,
  noun = 'commit',
  barClass = 'bar',
  width: W = 340,
  height: H = 70,
}: {
  start: number;
  counts: number[];
  noun?: string;
  barClass?: string;
  /** viewBox size; match the container's aspect so tick text isn't scaled up. */
  width?: number;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...counts);
  const bw = W / counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const label =
    hover === null
      ? `${total} ${noun}s in ${counts.length} days · peak ${max}/day`
      : `${new Date(start + hover * DAY).toISOString().slice(0, 10)} · ${counts[hover]} ${noun}${counts[hover] === 1 ? '' : 's'}`;
  return (
    <div className="chart">
      <div className="chart-readout">{label}</div>
      <svg viewBox={`0 0 ${W} ${H + 14}`} width="100%" onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H} y2={H} className="axis" />
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - f * H} y2={H - f * H} className="grid" />
        ))}
        {counts.map((c, i) => {
          const h = c === 0 ? 0 : Math.max(2, (c / max) * H);
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              {/* Full-height hit target, bigger than the mark. */}
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {h > 0 && (
                <rect x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1)} height={h} rx={1} className={hover === i ? `${barClass} bar-hover` : barClass} />
              )}
            </g>
          );
        })}
        <text x={0} y={H + 12} className="tick">
          −60d
        </text>
        <text x={W / 2} y={H + 12} className="tick" textAnchor="middle">
          −30d
        </text>
        <text x={W} y={H + 12} className="tick" textAnchor="end">
          today
        </text>
      </svg>
    </div>
  );
}

/**
 * Commit counts by weekday × hour. Shifted from UTC by the team's solar offset (lng/15)
 * since timezones aren't in the registry — accurate to about ±1h.
 */
function RhythmGrid({ matrix, lng }: { matrix: number[][]; lng: number }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const offset = Math.round(lng / 15);
  // Re-bucket into local hours, carrying across midnight into the neighbouring weekday.
  const local = Array.from({ length: 7 }, () => new Array(24).fill(0));
  matrix.forEach((row, d) =>
    row.forEach((v, h) => {
      const lh = h + offset;
      const dd = (d + Math.floor(lh / 24) + 7) % 7;
      local[dd][((lh % 24) + 24) % 24] += v;
    }),
  );
  const max = Math.max(1, ...local.flat());
  const cell = 12;
  const gap = 2;
  const left = 28;
  const readout = hover
    ? `${WEEKDAYS[hover[0]]} ${String(hover[1]).padStart(2, '0')}:00 · ${local[hover[0]][hover[1]]} commits`
    : `UTC${offset >= 0 ? '+' : ''}${offset} (solar estimate)`;
  return (
    <div className="chart">
      <div className="chart-readout">{readout}</div>
      <svg viewBox={`0 0 ${left + 24 * (cell + gap)} ${7 * (cell + gap) + 14}`} width="100%" onMouseLeave={() => setHover(null)}>
        {local.map((row, d) => (
          <g key={d}>
            <text x={0} y={d * (cell + gap) + cell - 2} className="tick">
              {WEEKDAYS[d]}
            </text>
            {row.map((v, h) => (
              <rect
                key={h}
                x={left + h * (cell + gap)}
                y={d * (cell + gap)}
                width={cell}
                height={cell}
                rx={2}
                fill={v === 0 ? 'var(--cell-empty)' : heatColor(0.15 + 0.85 * (v / max))}
                onMouseEnter={() => setHover([d, h])}
                className={hover && hover[0] === d && hover[1] === h ? 'cell-hover' : ''}
              />
            ))}
          </g>
        ))}
        {[0, 6, 12, 18].map((h) => (
          <text key={h} x={left + h * (cell + gap)} y={7 * (cell + gap) + 11} className="tick">
            {String(h).padStart(2, '0')}
          </text>
        ))}
      </svg>
    </div>
  );
}
