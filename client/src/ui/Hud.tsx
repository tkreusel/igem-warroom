import type { Meta, TeamSummary } from '../api';
import { fmtAgo, fmtCountdown, fmtInt } from '../format';
import { openRegistryWindow } from '../shared/channel';

interface Props {
  meta: Meta | null;
  teams: TeamSummary[];
  connected: boolean;
  now: number;
  briefingUnread: boolean;
  onOpenBriefing: () => void;
  sound: boolean;
  onToggleSound: () => void;
}

export function Hud({ meta, teams, connected, now, briefingUnread, onOpenBriefing, sound, onToggleSound }: Props) {
  const freezeAt = meta ? Date.parse(meta.wikiFreezeAt) : null;
  const remaining = freezeAt ? freezeAt - now : 0;
  const tracked = teams.filter((t) => t.gitlabPath).length;
  const urgent = remaining > 0 && remaining < 3 * 86400_000;

  return (
    <header className="hud">
      <div className="hud-brand">
        <svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden>
          <circle r="6.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
          <path d="M0 -10v6M0 10v-6M-10 0h6M10 0h-6" stroke="var(--accent)" strokeWidth="1.5" />
        </svg>
        <span>
          IGEM WARROOM <span className="muted">// {meta?.year ?? 2026}</span>
        </span>
      </div>

      <div className={`hud-cell hud-freeze ${urgent ? 'urgent' : ''}`}>
        <span className="hud-label">Wiki freeze</span>
        <span className="hud-value mono">{freezeAt ? `T−${fmtCountdown(remaining)}` : '—'}</span>
      </div>

      <div className="hud-cell">
        <span className="hud-label">Commits 24h</span>
        <span className="hud-value">{meta ? fmtInt(meta.stats.last24h.commits) : '—'}</span>
      </div>
      <div className="hud-cell">
        <span className="hud-label">Active teams 24h</span>
        <span className="hud-value">{meta ? fmtInt(meta.stats.last24h.teams) : '—'}</span>
      </div>
      <div className="hud-cell">
        <span className="hud-label">Active teams 7d</span>
        <span className="hud-value">{meta ? fmtInt(meta.stats.last7d.teams) : '—'}</span>
      </div>
      <div className="hud-cell">
        <span className="hud-label">Repos tracked</span>
        <span className="hud-value">
          {tracked}
          <span className="muted">/{teams.length}</span>
        </span>
      </div>

      <div className="hud-spacer" />

      <SyncCell meta={meta} now={now} />

      <button className={`hud-link ${briefingUnread ? 'hud-unread' : ''}`} onClick={onOpenBriefing} title="Daily briefing (09:00 Berlin)">
        Briefing{briefingUnread && <span className="hud-badge">NEW</span>}
      </button>
      <button
        className="hud-link hud-icon"
        onClick={onToggleSound}
        aria-pressed={sound}
        title={sound ? 'Alert sound on' : 'Alert sound off'}
      >
        {sound ? '🔊' : '🔇'}
      </button>
      <button className="hud-link" onClick={() => openRegistryWindow()} title="Open the parts registry in its own window">
        Parts registry ↗
      </button>

      <div className={`hud-live ${connected ? 'on' : 'off'}`}>
        <span className="dot" />
        {connected ? 'LIVE' : 'OFFLINE'}
      </div>
    </header>
  );
}

function SyncCell({ meta, now }: { meta: Meta | null; now: number }) {
  if (!meta) return null;
  const { sync, budget } = meta;
  const bf = sync.backfill;
  const resumeAt = Math.max(budget.throttledUntil ?? 0, budget.pausedUntil ?? 0);
  const throttled = resumeAt > now;
  let state: { cls: string; text: string };
  if (sync.lastPollError) state = { cls: 'bad', text: 'Poll error' };
  else if (throttled)
    state = {
      cls: 'warn',
      text: `${bf.running ? `Backfill ${bf.done}/${bf.total} · ` : ''}API budget low · resumes in ${Math.ceil((resumeAt - now) / 60_000)}m`,
    };
  else if (bf.running) state = { cls: 'warn', text: `Backfill ${bf.done}/${bf.total}` };
  else state = { cls: 'good', text: `Polled ${fmtAgo(sync.lastPollAt, now)}` };

  return (
    <div className="hud-cell hud-sync" title={sync.lastPollError ?? ''}>
      <span className="hud-label">
        Sync · API {budget.authenticated ? 'token' : 'anon'}
        {budget.remaining !== null && ` · ${budget.remaining} req left`}
      </span>
      <span className={`hud-value status-${state.cls}`}>
        <span className="status-icon" aria-hidden>
          {state.cls === 'good' ? '●' : state.cls === 'warn' ? '▲' : '■'}
        </span>{' '}
        {state.text}
      </span>
    </div>
  );
}
