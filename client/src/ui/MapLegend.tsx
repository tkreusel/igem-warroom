import { HEAT_GRADIENT_CSS } from '../map/heat';

export function MapLegend({ onReset, onTestAlert }: { onReset: () => void; onTestAlert: () => void }) {
  return (
    <div className="legend panel">
      <div className="legend-row">
        <span className="legend-title">Activity heat</span>
      </div>
      <div className="legend-ramp" style={{ background: HEAT_GRADIENT_CSS }} />
      <div className="legend-row legend-ends">
        <span>quiet</span>
        <span>hot</span>
      </div>
      <div className="legend-caption">Commits weighted by recency (48h decay). Marker size = total commits.</div>
      <div className="legend-keys">
        <span>
          <svg width="22" height="22" viewBox="-11 -11 22 22">
            <circle r="6" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M9 0h-4M-9 0h4M0 9v-4M0 -9v4" stroke="var(--accent)" strokeWidth="1.5" />
          </svg>
          Home team
        </span>
        <span>
          <svg width="22" height="22" viewBox="-11 -11 22 22">
            <path d="M0 -8L8 0L0 8L-8 0Z" fill="none" stroke="var(--ink)" strokeWidth="1.5" />
          </svg>
          Watchlist
        </span>
        <span>
          <svg width="22" height="22" viewBox="-11 -11 22 22">
            <circle r="7" fill="none" stroke="rgba(70,224,200,0.7)" strokeWidth="1.2" strokeDasharray="3 3" />
          </svg>
          Village rival
        </span>
        <span>
          <svg width="22" height="22" viewBox="-11 -11 22 22">
            <circle r="4" fill="none" stroke="#8f6316" strokeWidth="1.5" />
          </svg>
          No commits yet
        </span>
        <span>
          <svg width="22" height="22" viewBox="-11 -11 22 22">
            <circle r="3" fill="none" stroke="#55605b" strokeDasharray="2 2" />
          </svg>
          No public repo
        </span>
      </div>
      <div className="legend-buttons">
        <button className="btn btn-small" onClick={onReset}>
          Reset view
        </button>
        <button className="btn btn-small" onClick={onTestAlert} title="Fire a demo BREAKING NEWS alert">
          Test alert
        </button>
      </div>
    </div>
  );
}
