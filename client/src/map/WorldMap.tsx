import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { geoEqualEarth, geoGraticule10, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { quadtree, type Quadtree } from 'd3-quadtree';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import world110Url from 'world-atlas/countries-110m.json?url';
import world50Url from 'world-atlas/countries-50m.json?url';
import type { TeamSummary } from '../api';
import type { ReplayOverride } from '../ui/Replay';
import { heatColor, heatScale, markerRadius } from './heat';

export interface WorldMapHandle {
  flyTo(teamId: number, scale?: number): void;
  /** 'commit' = amber ripple; 'alert' = red siren rings for breaking news (repeats for ~12 s). */
  pulse(teamId: number, kind?: 'commit' | 'alert'): void;
  resetView(): void;
}

interface Props {
  teams: TeamSummary[];
  homeSlug: string;
  selectedId: number | null;
  isVisible: (t: TeamSummary) => boolean;
  onHover: (team: TeamSummary | null, clientX: number, clientY: number) => void;
  onSelect: (team: TeamSummary | null) => void;
  /** Time-replay values that replace live heat/commits while active. */
  override?: ReplayOverride | null;
}

interface Marker {
  team: TeamSummary;
  bx: number; // projected base coords (zoom 1)
  by: number;
  r: number;
  heat: number; // live value, or replay value while replaying
  commits: number;
  sx: number; // screen coords (current transform)
  sy: number;
}

interface BaseGeo {
  land: GeoPermissibleObjects;
  borders: GeoPermissibleObjects;
}

const C = {
  page: '#07090b',
  ocean: '#0b1014',
  grid: 'rgba(70, 224, 200, 0.07)',
  land: '#18201f',
  coast: 'rgba(70, 224, 200, 0.35)',
  border: 'rgba(70, 224, 200, 0.16)',
  rim: 'rgba(70, 224, 200, 0.45)',
  accent: '#46e0c8',
  ink: '#e8efe9',
  inkMuted: '#8a9690',
  noRepo: '#55605b',
};

const PULSE_MS = 4500;
const ALERT_MS = 12_000;

/** Fit the initial view to 56°S–84°N (skip Antarctica); points along the edges cover the curved outline. */
const INHABITED: GeoPermissibleObjects = {
  type: 'MultiPoint',
  coordinates: [
    ...Array.from({ length: 37 }, (_, i) => [-180 + i * 10, -56]),
    ...Array.from({ length: 37 }, (_, i) => [-180 + i * 10, 84]),
    ...Array.from({ length: 15 }, (_, i) => [-180, -56 + i * 10]),
    ...Array.from({ length: 15 }, (_, i) => [180, -56 + i * 10]),
  ],
};
const LABEL_ZOOM = 3.2;

async function loadGeo(url: string): Promise<BaseGeo> {
  const topo = (await (await fetch(url)).json()) as Topology;
  const countries = topo.objects.countries as GeometryCollection;
  return {
    land: feature(topo, topo.objects.land) as GeoPermissibleObjects,
    borders: mesh(topo, countries, (a, b) => a !== b),
  };
}

export const WorldMap = forwardRef<WorldMapHandle, Props>(function WorldMap(props, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // Everything the render loop reads lives in one mutable ref so React re-renders never touch the canvas.
  const s = useRef({
    w: 0,
    h: 0,
    dpr: 1,
    projection: geoEqualEarth(),
    transform: zoomIdentity as ZoomTransform,
    geoLow: null as BaseGeo | null,
    geoHigh: null as BaseGeo | null,
    markers: [] as Marker[],
    tree: null as Quadtree<Marker> | null,
    pulses: [] as { teamId: number; start: number; kind: 'commit' | 'alert' }[],
    hoverId: null as number | null,
    baseDirty: true,
    overlayDirty: true,
    zoom: null as ZoomBehavior<HTMLCanvasElement, unknown> | null,
    props,
  });
  s.current.props = props;

  function projectMarkers() {
    const st = s.current;
    st.markers = st.props.teams
      .filter((t) => t.lat !== null && t.lng !== null)
      .map((team) => {
        const [bx, by] = st.projection([team.lng!, team.lat!]) ?? [0, 0];
        return { team, bx, by, r: Math.min(18, markerRadius(team.commits)), heat: team.heat, commits: team.commits, sx: 0, sy: 0 };
      })
      // Hot markers draw last so they sit on top.
      .sort((a, b) => a.heat - b.heat || a.commits - b.commits);
    updateScreen();
  }

  function updateScreen() {
    const st = s.current;
    const { k, x, y } = st.transform;
    for (const m of st.markers) {
      m.sx = x + k * m.bx;
      m.sy = y + k * m.by;
    }
    st.tree = quadtree<Marker>()
      .x((m) => m.sx)
      .y((m) => m.sy)
      .addAll(st.markers);
    st.overlayDirty = true;
  }

  function drawBase() {
    const st = s.current;
    const ctx = baseRef.current?.getContext('2d');
    if (!ctx) return;
    const { k, x, y } = st.transform;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.page;
    ctx.fillRect(0, 0, st.w * st.dpr, st.h * st.dpr);
    ctx.setTransform(st.dpr * k, 0, 0, st.dpr * k, st.dpr * x, st.dpr * y);
    const path = geoPath(st.projection, ctx);

    ctx.beginPath();
    path({ type: 'Sphere' });
    ctx.fillStyle = C.ocean;
    ctx.fill();

    ctx.beginPath();
    path(geoGraticule10());
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 0.6 / k;
    ctx.stroke();

    const geo = k > 2.5 && st.geoHigh ? st.geoHigh : st.geoLow;
    if (geo) {
      ctx.beginPath();
      path(geo.land);
      ctx.fillStyle = C.land;
      ctx.fill();
      ctx.strokeStyle = C.coast;
      ctx.lineWidth = 0.7 / k;
      ctx.stroke();

      ctx.beginPath();
      path(geo.borders);
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 0.5 / k;
      ctx.stroke();
    }

    ctx.beginPath();
    path({ type: 'Sphere' });
    ctx.strokeStyle = C.rim;
    ctx.lineWidth = 1 / k;
    ctx.stroke();
    st.baseDirty = false;
  }

  function drawOverlay(now: number) {
    const st = s.current;
    const ctx = overlayRef.current?.getContext('2d');
    if (!ctx) return;
    const { props: p } = st;
    const k = st.transform.k;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, st.w, st.h);

    const zr = Math.min(1.8, 1 + Math.log2(k) * 0.35);
    const ov = p.override;
    if (ov) {
      for (const m of st.markers) {
        const v = ov.get(m.team.id);
        m.heat = v?.heat ?? 0;
        m.commits = v?.commits ?? 0;
        m.r = Math.min(18, markerRadius(m.commits));
      }
      st.markers.sort((a, b) => a.heat - b.heat || a.commits - b.commits);
    }
    const maxHeat = st.markers.reduce((mx, m) => Math.max(mx, m.heat), 0);
    const norm = heatScale(maxHeat);
    const inView = (m: Marker, pad = 20) => m.sx > -pad && m.sx < st.w + pad && m.sy > -pad && m.sy < st.h + pad;

    let home: Marker | undefined;
    let selected: Marker | undefined;
    let hovered: Marker | undefined;

    for (const m of st.markers) {
      if (m.team.slug === p.homeSlug) home = m;
      if (m.team.id === p.selectedId) selected = m;
      if (m.team.id === st.hoverId) hovered = m;
      if (!inView(m)) continue;
      const visible = p.isVisible(m.team);
      ctx.globalAlpha = visible ? 1 : 0.12;
      const r = m.r * zr;
      ctx.beginPath();
      if (!m.team.gitlabPath) {
        // No public repository: small hollow, dashed.
        ctx.arc(m.sx, m.sy, 2.5 * zr, 0, Math.PI * 2);
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = C.noRepo;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (m.commits === 0) {
        // Repo exists but no team commits yet: hollow ring.
        ctx.arc(m.sx, m.sy, 3 * zr, 0, Math.PI * 2);
        ctx.strokeStyle = heatColor(0);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.arc(m.sx, m.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = heatColor(norm(m.heat));
        ctx.fill();
        // Surface ring separates overlapping markers.
        ctx.strokeStyle = C.ocean;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Labels at higher zoom, hottest first, greedy collision avoidance.
    if (k >= LABEL_ZOOM) {
      const boxes: [number, number, number, number][] = [];
      ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      // Home team claims its label slot first, then hottest-first.
      const order = [...(home ? [home] : []), ...st.markers.slice().reverse().filter((m) => m !== home)];
      for (const m of order) {
        if (!inView(m, 0) || !p.isVisible(m.team)) continue;
        const r = (m.team.gitlabPath && m.commits ? m.r : 3) * zr;
        const tx = m.sx + r + 4;
        const tw = ctx.measureText(m.team.name).width;
        const box: [number, number, number, number] = [tx - 2, m.sy - 8, tx + tw + 2, m.sy + 8];
        if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        boxes.push(box);
        ctx.fillStyle = 'rgba(7, 9, 11, 0.75)';
        ctx.fillRect(box[0], box[1] + 2, box[2] - box[0], box[3] - box[1] - 4);
        ctx.fillStyle = m === home ? C.accent : m.heat > 0.05 ? C.ink : C.inkMuted;
        ctx.fillText(m.team.name, tx, m.sy);
      }
    }

    // Live pulses: amber ripples for commits, red siren rings for breaking news.
    st.pulses = st.pulses.filter((pl) => now - pl.start < (pl.kind === 'alert' ? ALERT_MS : PULSE_MS));
    for (const pl of st.pulses) {
      const m = st.markers.find((x) => x.team.id === pl.teamId);
      if (!m) continue;
      if (pl.kind === 'alert') {
        const age = now - pl.start;
        const fade = Math.min(1, (ALERT_MS - age) / 2000);
        // A new ring every 1.2 s, each expanding over 2.4 s.
        for (let k = 0; k < 3; k++) {
          const tt = ((age / 2400 + k / 3) % 1 + 1) % 1;
          ctx.beginPath();
          ctx.arc(m.sx, m.sy, Math.max(m.r * zr, 6) + tt * 70, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 59, 48, ${(1 - tt) * 0.95 * fade})`;
          ctx.lineWidth = 3 - tt * 2;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(m.sx, m.sy, Math.max(m.r * zr, 6) + 4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 59, 48, ${0.9 * fade})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        continue;
      }
      const t = (now - pl.start) / PULSE_MS;
      for (const lag of [0, 0.25]) {
        const tt = t - lag;
        if (tt < 0) continue;
        ctx.beginPath();
        ctx.arc(m.sx, m.sy, m.r * zr + tt * 40, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 216, 138, ${(1 - tt) * 0.9})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Watchlist: diamond frame. Village rivals: dashed ring. Shapes, not just colour.
    for (const m of st.markers) {
      if (!inView(m, 30) || m === home) continue;
      const vis = p.isVisible(m.team);
      if (!vis) continue;
      const base = Math.max(m.team.gitlabPath && m.commits ? m.r * zr : 3 * zr, 3);
      if (m.team.subscribed) {
        const d = base + 6;
        ctx.beginPath();
        ctx.moveTo(m.sx, m.sy - d);
        ctx.lineTo(m.sx + d, m.sy);
        ctx.lineTo(m.sx, m.sy + d);
        ctx.lineTo(m.sx - d, m.sy);
        ctx.closePath();
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (m.team.sameVillage) {
        ctx.beginPath();
        ctx.arc(m.sx, m.sy, base + 4, 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(70, 224, 200, 0.7)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Home team: crosshair reticle (shape, not just color, marks it).
    if (home) {
      const r = Math.max(home.r * zr, 4) + 6;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(home.sx, home.sy, r, 0, Math.PI * 2);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(home.sx + dx * (r - 3), home.sy + dy * (r - 3));
        ctx.lineTo(home.sx + dx * (r + 7), home.sy + dy * (r + 7));
      }
      ctx.stroke();
    }

    // Selected / hovered: corner brackets.
    for (const [m, color] of [
      [hovered, C.ink],
      [selected, C.accent],
    ] as const) {
      if (!m) continue;
      const r = Math.max(m.r * zr, 4) + 9;
      const L = 5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const cx = m.sx + sx * r;
        const cy = m.sy + sy * r;
        ctx.moveTo(cx, cy - sy * L);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx - sx * L, cy);
      }
      ctx.stroke();
    }

    st.overlayDirty = false;
  }

  // Mount: canvases, zoom, geometry, render loop.
  useEffect(() => {
    const st = s.current;
    const wrap = wrapRef.current!;
    const overlay = overlayRef.current!;
    const base = baseRef.current!;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      st.w = rect.width;
      st.h = rect.height;
      st.dpr = window.devicePixelRatio || 1;
      for (const c of [base, overlay]) {
        c.width = Math.round(st.w * st.dpr);
        c.height = Math.round(st.h * st.dpr);
        c.style.width = `${st.w}px`;
        c.style.height = `${st.h}px`;
      }
      st.projection = geoEqualEarth().fitExtent(
        [
          [16, 16],
          [st.w - 16, st.h - 16],
        ],
        INHABITED,
      );
      st.zoom?.translateExtent([
        [-st.w * 0.25, -st.h * 0.25],
        [st.w * 1.25, st.h * 1.25],
      ]);
      projectMarkers();
      st.baseDirty = true;
    };

    const zoom = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([1, 80])
      .on('zoom', (e: { transform: ZoomTransform }) => {
        st.transform = e.transform;
        updateScreen();
        st.baseDirty = true;
        st.hoverId = null;
        st.props.onHover(null, 0, 0);
      });
    st.zoom = zoom;
    select(overlay).call(zoom).on('dblclick.zoom', null);

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    loadGeo(world110Url).then((g) => {
      st.geoLow = g;
      st.baseDirty = true;
      // Higher-resolution coastlines for zoomed-in views, fetched after first paint.
      return loadGeo(world50Url).then((h) => {
        st.geoHigh = h;
        st.baseDirty = true;
      });
    });

    const pick = (ev: MouseEvent) => {
      const rect = overlay.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const zr = Math.min(1.8, 1 + Math.log2(st.transform.k) * 0.35);
      const m = st.tree?.find(x, y, 22);
      if (!m) return undefined;
      const hitR = Math.max(m.r * zr, 4) + 5;
      return Math.hypot(m.sx - x, m.sy - y) <= hitR ? m : undefined;
    };

    const onMove = (ev: MouseEvent) => {
      if (ev.buttons) return;
      const m = pick(ev);
      const id = m?.team.id ?? null;
      overlay.style.cursor = m ? 'pointer' : 'grab';
      if (id !== st.hoverId) {
        st.hoverId = id;
        st.overlayDirty = true;
      }
      st.props.onHover(m?.team ?? null, ev.clientX, ev.clientY);
    };
    const onLeave = () => {
      st.hoverId = null;
      st.overlayDirty = true;
      st.props.onHover(null, 0, 0);
    };
    const onClick = (ev: MouseEvent) => st.props.onSelect(pick(ev)?.team ?? null);
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseleave', onLeave);
    overlay.addEventListener('click', onClick);

    let raf = 0;
    const loop = () => {
      if (st.baseDirty) drawBase();
      if (st.overlayDirty || st.pulses.length) drawOverlay(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      overlay.removeEventListener('mousemove', onMove);
      overlay.removeEventListener('mouseleave', onLeave);
      overlay.removeEventListener('click', onClick);
      select(overlay).on('.zoom', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data / selection / filter changes.
  useEffect(() => {
    projectMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.teams]);

  useEffect(() => {
    s.current.overlayDirty = true;
  }, [props.selectedId, props.isVisible, props.homeSlug]);

  useEffect(() => {
    // Leaving replay: restore live values.
    if (!props.override) projectMarkers();
    s.current.overlayDirty = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.override]);

  useImperativeHandle(ref, () => ({
    flyTo(teamId, scale = 7) {
      const st = s.current;
      const m = st.markers.find((x) => x.team.id === teamId);
      if (!m || !st.zoom || !overlayRef.current) return;
      const k = Math.max(scale, st.transform.k);
      const t = zoomIdentity.translate(st.w / 2, st.h / 2).scale(k).translate(-m.bx, -m.by);
      select(overlayRef.current).transition().duration(1100).call(st.zoom.transform, t);
    },
    pulse(teamId, kind = 'commit') {
      s.current.pulses.push({ teamId, start: performance.now(), kind });
    },
    resetView() {
      const st = s.current;
      if (!st.zoom || !overlayRef.current) return;
      select(overlayRef.current).transition().duration(800).call(st.zoom.transform, zoomIdentity);
    },
  }));

  return (
    <div ref={wrapRef} className="map-wrap">
      <canvas ref={baseRef} className="map-layer" />
      <canvas ref={overlayRef} className="map-layer map-interactive" />
    </div>
  );
});
