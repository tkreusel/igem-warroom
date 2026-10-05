import type { FeedItem, NewsEvent } from '../api';
import { fmtAgo, fmtInt, fmtUtc } from '../format';

interface Props {
  items: (FeedItem & { fresh?: boolean })[];
  news: NewsEvent[];
  homeSlug: string;
  onPick: (teamId: number) => void;
  now: number;
}

type Row = { kind: 'commit'; at: number; c: FeedItem & { fresh?: boolean } } | { kind: 'news'; at: number; n: NewsEvent };

export function LiveFeed({ items, news, homeSlug, onPick, now }: Props) {
  // News interleaves with commits by time; only the last 24 h of news, so the wire stays current.
  const rows: Row[] = [
    ...items.map((c) => ({ kind: 'commit' as const, at: c.at, c })),
    ...news.filter((n) => now - n.at < 86400_000).map((n) => ({ kind: 'news' as const, at: n.at, n })),
  ].sort((a, b) => b.at - a.at);
  return (
    <section className="feed panel">
      <div className="panel-title">
        <span>Intercepts · latest commits</span>
        <span className="muted">{items.length}</span>
      </div>
      <ul className="feed-list">
        {rows.map((r) => {
          if (r.kind === 'news') {
            const n = r.n;
            return (
              <li key={`news-${n.id}`} className={`feed-news sev-${n.severity}`}>
                <button onClick={() => n.team && onPick(n.team.id)}>
                  <span className="feed-time">{fmtAgo(n.at, now)}</span>
                  <span className="feed-team">
                    <span className="bf-news-tag">{n.severity === 'breaking' ? 'BREAKING' : 'FLASH'}</span> {n.kicker}
                  </span>
                  <span className="feed-title">{n.headline}</span>
                </button>
              </li>
            );
          }
          const c = r.c;
          return (
          <li key={`${c.teamId}-${c.sha}`} className={`${c.fresh ? 'fresh' : ''} ${c.slug === homeSlug ? 'home' : ''}`}>
            <button onClick={() => onPick(c.teamId)}>
              <span className="feed-time" title={fmtUtc(c.at)}>
                {fmtAgo(c.at, now)}
              </span>
              <span className="feed-team">{c.teamName}</span>
              <span className="feed-title">{c.title}</span>
              <span className="delta">
                <span className="add">+{fmtInt(c.additions)}</span> <span className="del">−{fmtInt(c.deletions)}</span>
              </span>
            </button>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
