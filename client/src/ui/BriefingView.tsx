import { useEffect, useState, type ReactNode } from 'react';
import { api, type Briefing, type BriefingListItem, type BriefTeamRef, type TeamDossier } from '../api';
import { fmtAgo, fmtCountdown, fmtInt } from '../format';

interface Props {
  /** Briefing to open first; null = newest. */
  initialId: number | null;
  onClose: () => void;
  onOpenTeam: (teamId: number) => void;
  onSeen: (id: number) => void;
}

const REL_TAG: Record<string, string> = { home: 'HOME', subscribed: 'WATCH', village: 'VILLAGE' };

export function BriefingView({ initialId, onClose, onOpenTeam, onSeen }: Props) {
  const [list, setList] = useState<BriefingListItem[]>([]);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [choice, setChoice] = useState<number | 'preview' | null>(initialId);
  const [b, setB] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .briefings()
      .then((r) => {
        setList(r.items);
        setNextAt(r.nextAt);
        setChoice((c) => c ?? r.items[0]?.id ?? 'preview');
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (choice === null) return;
    setB(null);
    const load = choice === 'preview' ? api.briefingPreview() : api.briefing(choice);
    load
      .then((x) => {
        setB(x);
        if (x.id) onSeen(x.id);
      })
      .catch((e) => setError(String(e)));
  }, [choice, onSeen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tz = b?.timeZone ?? 'Europe/Berlin';
  const when = (t: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(t);
  const T = ({ t, inVillage }: { t: BriefTeamRef; inVillage?: boolean }) => {
    // Inside the village table every row is a village team, so that tag would be noise.
    const tag = inVillage && t.relation === 'village' ? null : REL_TAG[t.relation];
    return (
      <button className={`bf-team rel-${t.relation}`} onClick={() => onOpenTeam(t.id)}>
        {t.name}
        {tag && <span className="bf-rel">{tag}</span>}
      </button>
    );
  };

  return (
    <div className="briefing-backdrop" onClick={onClose}>
      <article className="briefing panel" onClick={(e) => e.stopPropagation()} aria-label="Daily briefing">
        <header className="bf-head">
          <div>
            <div className="bf-eyebrow">Daily briefing{b?.preview && ' · live draft'}</div>
            <h1>{b ? when(b.periodEnd) : '…'}</h1>
            {b && <div className="muted">Covers {when(b.periodStart)} → {when(b.periodEnd)}</div>}
          </div>
          <div className="bf-controls">
            <select value={choice ?? ''} onChange={(e) => setChoice(e.target.value === 'preview' ? 'preview' : Number(e.target.value))}>
              <option value="preview">Live draft · last 24 h</option>
              {list.map((i) => (
                <option key={i.id} value={i.id}>
                  {when(i.periodEnd)}
                </option>
              ))}
            </select>
            {nextAt && <span className="muted">Next: {when(nextAt)}</span>}
            <button className="btn btn-icon" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        {error && <div className="tp-empty">Could not load briefing: {error}</div>}
        {!b && !error && <div className="tp-empty">Compiling…</div>}
        {b && (
          <div className="bf-body">
            <p className="bf-lead">{b.summary}</p>

            <div className="bf-kpis">
              <Kpi label="Commits" value={fmtInt(b.global.commits)} />
              <Kpi label="Active teams" value={fmtInt(b.global.activeTeams)} />
              <Kpi label="Lines +/−" value={`+${fmtInt(b.global.additions)} / −${fmtInt(b.global.deletions)}`} small />
              <Kpi label="New parts" value={fmtInt(b.global.partsPublished)} />
              <Kpi label="Registry total" value={`${fmtInt(b.global.registryTotals.published)} pub · ${fmtInt(b.global.registryTotals.draft)} draft`} small />
              <Kpi label="Wiki freeze" value={`T−${fmtCountdown(b.freeze.remainingMs).replace(/:\d\d$/, '')}`} accent />
            </div>

            {b.news.length > 0 && (
              <Section title="Wire · what broke">
                <ul className="bf-news">
                  {b.news.map((n, i) => (
                    <li key={i} className={`sev-${n.severity}`}>
                      <span className="bf-news-tag">{n.severity === 'breaking' ? 'BREAKING' : 'FLASH'}</span>
                      <span className="muted">{when(n.at)}</span>
                      {n.teamId ? (
                        <button className="bf-link" onClick={() => onOpenTeam(n.teamId!)}>
                          {n.headline}
                        </button>
                      ) : (
                        <span>{n.headline}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {b.home && (
              <Section title={`Home · ${b.home.team.name}`}>
                <Dossier d={b.home} />
              </Section>
            )}

            {b.village && (
              <Section title={`Village · ${b.village.name}`} aside={`${b.home?.team.name ?? 'Home'} is #${b.village.homeRank} of ${b.village.teams.length} by 7-day commits`}>
                <table className="tp-table bf-village">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Team</th>
                      <th className="num">Commits 24h</th>
                      <th className="num">Lines 24h</th>
                      <th className="num">Commits 7d</th>
                      <th className="num">World 7d</th>
                      <th className="num">Parts pub / draft</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.village.teams.slice(0, 20).map((r, i) => (
                      <tr key={r.team.id} className={r.team.relation === 'home' ? 'bf-home-row' : ''}>
                        <td className="num muted">{i + 1}</td>
                        <td>
                          <T t={r.team} inVillage />
                        </td>
                        <td className="num">{r.commits24h || '—'}</td>
                        <td className="num">{r.lines24h ? fmtInt(r.lines24h) : '—'}</td>
                        <td className="num">{r.commits7d || '—'}</td>
                        <td className="num muted">{r.rank7d ? `#${r.rank7d}` : '—'}</td>
                        <td className="num">{r.published === null ? '…' : `${r.published} / ${r.draft}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {b.village.teams.length > 20 && <div className="caption">+{b.village.teams.length - 20} more teams in this village</div>}
              </Section>
            )}

            {b.subscribed.length > 0 && (
              <Section title={`Watchlist · ${b.subscribed.length} team${b.subscribed.length === 1 ? '' : 's'}`}>
                <div className="bf-dossiers">
                  {b.subscribed.map((d) => (
                    <div key={d.team.id} className="bf-dossier-card">
                      <h3>
                        <T t={d.team} />
                      </h3>
                      <Dossier d={d} />
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <div className="bf-grid">
              <Section title="Most active">
                <ol className="bf-rank">
                  {b.topMovers.map((m) => (
                    <li key={m.team.id}>
                      <T t={m.team} />
                      <span className="num">{m.commits}</span>
                    </li>
                  ))}
                </ol>
              </Section>
              <Section title="Biggest code drops">
                <ol className="bf-rank">
                  {b.biggestDrops.map((m) => (
                    <li key={m.team.id}>
                      <T t={m.team} />
                      <span className="num">{fmtInt(m.additions + m.deletions)} lines</span>
                    </li>
                  ))}
                </ol>
              </Section>
              <Section title="Climbers · 7-day rank">
                {b.climbers.length ? (
                  <ol className="bf-rank">
                    {b.climbers.map((c) => (
                      <li key={c.team.id}>
                        <T t={c.team} />
                        <span className="num">
                          {c.before ? `#${c.before}` : 'new'} → #{c.rank}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="muted">No big moves.</div>
                )}
              </Section>
              <Section title="Went quiet · 48 h silent">
                {b.wentQuiet.length ? (
                  <ol className="bf-rank">
                    {b.wentQuiet.map((q) => (
                      <li key={q.team.id}>
                        <T t={q.team} />
                        <span className="num muted">{q.commitsBefore} commits the week before</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="muted">Nobody dropped off.</div>
                )}
              </Section>
              <Section title="Registry · new parts">
                {b.partsLeaders.length ? (
                  <ol className="bf-rank">
                    {b.partsLeaders.map((p) => (
                      <li key={p.team.id}>
                        <T t={p.team} />
                        <span className="num">{p.parts} parts</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="muted">No newly published parts.</div>
                )}
              </Section>
              <Section title="First commits">
                {b.global.newlyActive.length ? (
                  <div className="bf-chips">
                    {b.global.newlyActive.map((t) => (
                      <T key={t.id} t={t} />
                    ))}
                  </div>
                ) : (
                  <div className="muted">No teams started today.</div>
                )}
              </Section>
            </div>
          </div>
        )}
      </article>
    </div>
  );
}

function Kpi({ label, value, small, accent }: { label: string; value: string; small?: boolean; accent?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${small ? 'small' : ''} ${accent ? 'bf-accent' : ''}`}>{value}</div>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="bf-section">
      <h2>
        <span>{title}</span>
        {aside && <span className="muted">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

function Dossier({ d }: { d: TeamDossier }) {
  const rankMove =
    d.rank7d && d.rank7dBefore ? (d.rank7dBefore > d.rank7d ? `▲ ${d.rank7dBefore - d.rank7d}` : d.rank7dBefore < d.rank7d ? `▼ ${d.rank7d - d.rank7dBefore}` : '=') : null;
  return (
    <div className="bf-dossier">
      <div className="bf-dossier-stats">
        <span>
          <b>{d.commits}</b> commits
        </span>
        <span>
          <b>+{fmtInt(d.additions)}</b> / <b>−{fmtInt(d.deletions)}</b> lines
        </span>
        <span>
          <b>{d.contributors}</b> contributors
        </span>
        <span>
          7d rank <b>{d.rank7d ? `#${d.rank7d}` : '—'}</b> {rankMove && <span className="muted">({rankMove})</span>}
        </span>
        {d.registry && (
          <span>
            parts <b className="v-published">{d.registry.published}</b>
            {d.registry.publishedChange ? <span className="muted"> (+{d.registry.publishedChange})</span> : null} ·{' '}
            <b className="v-draft">{d.registry.draft}</b> draft
          </span>
        )}
        <span className="muted">last commit {fmtAgo(d.lastCommitAt)}</span>
      </div>
      {d.commits === 0 ? (
        <div className="muted">No commits in this period.</div>
      ) : (
        <div className="bf-dossier-cols">
          <div>
            <h4>Pages & files touched</h4>
            {d.pages.length ? (
              <table className="tp-table">
                <tbody>
                  {d.pages.map((p) => (
                    <tr key={p.path}>
                      <td className="mono bf-path" title={p.path}>
                        {p.created && <span className="tag tag-dim">new</span>}
                        {p.path}
                      </td>
                      <td className="num muted">{p.commits}×</td>
                      <td className="num">
                        <span className="add">+{fmtInt(p.additions)}</span> <span className="del">−{fmtInt(p.deletions)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="muted">File detail still being collected ({d.pageCoverage.detailed}/{d.pageCoverage.commits} commits).</div>
            )}
          </div>
          <div>
            <h4>Commits</h4>
            <ul className="bf-commits">
              {d.recentCommits.map((c) => (
                <li key={c.sha}>
                  <span>{c.title}</span>
                  <span className="muted">
                    {c.author} · <span className="add">+{fmtInt(c.additions)}</span> <span className="del">−{fmtInt(c.deletions)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {d.authors.length > 0 && <div className="caption">By {d.authors.map((a) => `${a.name} (${a.commits})`).join(', ')}</div>}
          </div>
        </div>
      )}
      {d.news.length > 0 && (
        <ul className="bf-news">
          {d.news.map((n, i) => (
            <li key={i} className={`sev-${n.severity}`}>
              <span className="bf-news-tag">{n.severity === 'breaking' ? 'BREAKING' : 'FLASH'}</span>
              {n.headline}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
