import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { NewsEvent } from '../api';
import { fmtInt } from '../format';

export interface NewsDeskHandle {
  push(e: NewsEvent): void;
}

interface Props {
  /** Fly the map to the team and start the red siren rings. */
  onFocus: (e: NewsEvent) => void;
  onOpenTeam: (teamId: number) => void;
  sound: boolean;
}

const BREAKING_MS = 12_000;
const FLASH_MS = 7_000;

/** Short two-tone alert, synthesised (no audio assets). Only plays after a user gesture has unlocked audio. */
let audio: AudioContext | null = null;
export function unlockAudio() {
  audio ??= new AudioContext();
  void audio.resume();
}
function siren(times: number) {
  if (!audio || audio.state !== 'running') return;
  const t0 = audio.currentTime;
  const gain = audio.createGain();
  gain.gain.value = 0.06;
  gain.connect(audio.destination);
  for (let i = 0; i < times * 2; i++) {
    const osc = audio.createOscillator();
    osc.type = 'square';
    osc.frequency.value = i % 2 ? 660 : 880;
    osc.connect(gain);
    osc.start(t0 + i * 0.28);
    osc.stop(t0 + i * 0.28 + 0.24);
  }
}

function subline(e: NewsEvent): string {
  const d = e.detail as Record<string, number | string | null>;
  switch (e.type) {
    case 'code-drop':
      return [
        d.additions !== undefined ? `+${fmtInt(Number(d.additions))} / −${fmtInt(Number(d.deletions ?? 0))} lines` : null,
        d.commits ? `${d.commits} commit${d.commits === 1 ? '' : 's'}` : null,
        d.biggestCommit ? `biggest: “${d.biggestCommit}”` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'burst':
      return `${d.commits} commits within 30 minutes`;
    case 'parts-drop':
      return `${d.totalPublished} published in total · ${d.draftsLeft} drafts still pending`;
    case 'milestone':
      return 'Wiki freeze countdown';
  }
}

export const NewsDesk = forwardRef<NewsDeskHandle, Props>(function NewsDesk({ onFocus, onOpenTeam, sound }, ref) {
  const [current, setCurrent] = useState<NewsEvent | null>(null);
  const [flashes, setFlashes] = useState<NewsEvent[]>([]);
  const queue = useRef<NewsEvent[]>([]);
  const busy = useRef(false);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const timer = useRef<number | undefined>(undefined);

  const next = useCallback(() => {
    const e = queue.current.shift();
    if (!e) {
      busy.current = false;
      setCurrent(null);
      return;
    }
    busy.current = true;
    setCurrent(e);
    onFocus(e);
    // A short screen jolt as the intermission lands.
    document.body.classList.add('shake');
    window.setTimeout(() => document.body.classList.remove('shake'), 600);
    if (soundRef.current) siren(3);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(next, BREAKING_MS);
  }, [onFocus]);

  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    next();
  }, [next]);

  useImperativeHandle(ref, () => ({
    push(e) {
      if (e.severity === 'breaking') {
        queue.current.push(e);
        if (!busy.current) next();
      } else {
        setFlashes((f) => [e, ...f].slice(0, 4));
        onFocus(e);
        if (soundRef.current) siren(1);
        window.setTimeout(() => setFlashes((f) => f.filter((x) => x.id !== e.id)), FLASH_MS);
      }
    },
  }));

  useEffect(() => {
    if (!current) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current, dismiss]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      {current && (
        <div className="breaking" role="alert" aria-live="assertive">
          <div className="breaking-vignette" />
          <div className="breaking-scan" />
          <div className="breaking-banner">
            <div className="breaking-slab">
              <span className="breaking-siren" aria-hidden>
                ◉
              </span>
              BREAKING NEWS
              {current.test && <span className="breaking-drill">DRILL</span>}
            </div>
            <div className="breaking-body">
              <div className="breaking-kicker">
                <span>{current.kicker}</span>
                {current.team?.village && <span className="muted"> · {current.team.village} village</span>}
                {current.team?.country && <span className="muted"> · {current.team.country}</span>}
              </div>
              <h1 className="breaking-headline">{current.headline}</h1>
              <div className="breaking-sub">{subline(current)}</div>
              <div className="breaking-actions">
                {current.team && (
                  <button className="btn" onClick={() => onOpenTeam(current.team!.id)}>
                    Open dossier
                  </button>
                )}
                <button className="btn" onClick={dismiss}>
                  Dismiss (Esc)
                </button>
                {queue.current.length > 0 && <span className="muted">+{queue.current.length} more</span>}
              </div>
            </div>
            <div className="breaking-timer" key={current.id} style={{ animationDuration: `${BREAKING_MS}ms` }} />
          </div>
          <div className="breaking-ticker" aria-hidden>
            <div className="breaking-ticker-track">
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i}>
                  ◆ {current.kicker} ◆ {current.headline} ◆ {subline(current)}&nbsp;&nbsp;&nbsp;
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flash-stack" aria-live="polite">
        {flashes.map((f) => (
          <button key={f.id} className="flash" onClick={() => f.team && onOpenTeam(f.team.id)}>
            <span className="flash-tag">FLASH</span>
            <span className="flash-kicker">{f.kicker}</span>
            <span className="flash-headline">{f.headline}</span>
          </button>
        ))}
      </div>
    </>
  );
});
