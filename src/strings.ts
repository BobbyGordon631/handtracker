import { lengthToPitch, makePitch, stringDecay } from './music';

export const MAX_STRINGS = 16;
/** Each string renders as a polyline of SEGMENTS+1 points. */
export const SEGMENTS = 40;
export const POINTS = SEGMENTS + 1;

/** Per-string retrigger cooldown, so one swipe = one pluck. */
export const PLUCK_COOLDOWN_MS = 80;
/** Fingers that just placed a string sit on its ends; ignore plucks briefly. */
const NEW_STRING_GRACE_MS = 300;
/** Ignore crossings this close to the anchored ends (fraction of length). */
const END_MARGIN = 0.03;
const FADE_TIME = 0.6;
const SNAP_FADE_TIME = 0.18;
/** A freshly placed string brightens from the translucent draft look over this long (s). */
const APPEAR_TIME = 0.3;
/** Only the middle of a string can be grabbed: pinching near an end is for drawing a new string from there. */
const GRAB_U_MIN = 0.15;
const LN_1000 = Math.log(1000);

let nextId = 1;

export class HarpString {
  readonly id = nextId++;
  ax = 0;
  ay = 0;
  bx = 0;
  by = 0;
  length = 1;
  readonly pitch = makePitch();
  /** Effective T60 (s) shared with the audio engine. */
  decay = 3;
  /** Amplitude e-folding time (s): T60 / ln(1000). */
  tau = 0.5;
  hue = 200;

  // Vibration (standing wave) state
  amp = 0;
  pluckTime = -1e9; // seconds (performance clock)
  visFreq = 8; // Hz. Real string frequencies would alias at 60 fps, so we use a slowed-down one.
  h1 = 1; // fundamental weight
  h2 = 0.3; // 2nd harmonic weight

  glow = 0; // extra brightness after a pluck, decays
  labelAlpha = 0;
  alpha = 1;
  state: 'alive' | 'fading' | 'snapping' = 'alive';
  dead = false;
  lastPluckMs = -1e9;
  createdMs = 0;
  isDraft = false;

  /** 0 → 1 over the first moments after it's placed (fade-in from the draft look). */
  appear = 1;
  /** A hand is about to pinch this string (it would grab it). Animated toward hoverTarget. */
  hover = 0;
  hoverTarget = 0;

  grabbed = false;
  /** Grab point (screen px) and where along the string it was grabbed (0..1). */
  gx = 0;
  gy = 0;
  gu = 0.5;
  /** How close a grabbed string is to snapping, 0..1. */
  tension = 0;

  /**
   * Set the end points and retune. `prefer` keeps that MIDI note if it's still
   * nearly as close as the nearest one (see lengthToPitch).
   */
  setEnds(ax: number, ay: number, bx: number, by: number, diag: number, prefer = -1): void {
    this.ax = ax;
    this.ay = ay;
    this.bx = bx;
    this.by = by;
    this.length = Math.max(1, Math.hypot(bx - ax, by - ay));
    this.retune(diag, prefer);
  }

  retune(diag: number, prefer = -1): void {
    lengthToPitch(this.length, diag, this.pitch, prefer);
    this.decay = stringDecay(this.pitch.freq);
    this.tau = this.decay / LN_1000;
    // low = warm red-orange (15°), high = cool blue-violet (270°)
    this.hue = 15 + 255 * this.pitch.t;
    this.visFreq = 6 + 10 * this.pitch.t;
  }

  get midX(): number {
    return (this.ax + this.bx) / 2;
  }
  get midY(): number {
    return (this.ay + this.by) / 2;
  }
}

/** Perpendicular displacement (px) of a string at parameter u ∈ [0,1] and time `now` (s). */
export function displacementAt(s: HarpString, u: number, now: number): number {
  let d = 0;
  const t = now - s.pluckTime;
  if (s.amp !== 0 && t >= 0) {
    // Decaying standing wave: fundamental + a little 2nd harmonic. Same τ as the audio.
    const env = s.amp * Math.exp(-t / s.tau);
    if (Math.abs(env) > 0.03) {
      const w = 2 * Math.PI * s.visFreq * t;
      d = env * (s.h1 * Math.sin(Math.PI * u) * Math.cos(w) + s.h2 * Math.sin(2 * Math.PI * u) * Math.cos(2 * w + 0.7));
    }
  }
  if (s.isDraft) d += 2.5 * Math.sin(Math.PI * u) * Math.sin(now * 7 + u * 4); // live draft shimmers
  return d;
}

/** Fill `out` with POINTS (x,y) pairs describing the string's current shape. */
export function computePoints(s: HarpString, now: number, out: Float32Array): void {
  const { ax, ay, bx, by } = s;
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / L;
  const ny = dx / L;
  if (s.grabbed) {
    // Pulled at gu: two straight pieces meeting at the grab point. Near breaking
    // point it starts to tremble, so you can feel the snap coming.
    const tr = Math.max(0, s.tension - 0.55) * 7 * Math.sin(now * 83) * Math.sin(now * 37 + 1.3);
    const gx = s.gx + nx * tr;
    const gy = s.gy + ny * tr;
    // Put a vertex exactly on the grab point so the corner stays sharp.
    const iG = Math.min(SEGMENTS - 2, Math.max(2, Math.round(s.gu * SEGMENTS)));
    for (let i = 0; i < POINTS; i++) {
      if (i <= iG) {
        const k = i / iG;
        out[i * 2] = ax + (gx - ax) * k;
        out[i * 2 + 1] = ay + (gy - ay) * k;
      } else {
        const k = (i - iG) / (SEGMENTS - iG);
        out[i * 2] = gx + (bx - gx) * k;
        out[i * 2 + 1] = gy + (by - gy) * k;
      }
    }
    return;
  }
  for (let i = 0; i < POINTS; i++) {
    const u = i / SEGMENTS;
    const d = displacementAt(s, u, now);
    out[i * 2] = ax + dx * u + nx * d;
    out[i * 2 + 1] = ay + dy * u + ny * d;
  }
}

/** Point on the string at u (with vibration). Used by spark particles riding the string. */
export function pointOn(s: HarpString, u: number, now: number, out: { x: number; y: number }): void {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const L = Math.max(1, Math.hypot(dx, dy));
  const d = s.grabbed ? 0 : displacementAt(s, u, now);
  out.x = s.ax + dx * u + (-dy / L) * d;
  out.y = s.ay + dy * u + (dx / L) * d;
}

export interface Hit {
  s: HarpString;
  /** Where along the finger's movement the crossing happened (0..1). Orders a strum. */
  t: number;
  /** Where along the string it was crossed (0..1). */
  u: number;
}

/**
 * Segment–segment intersection of P0→P1 (finger) and A→B (string).
 * Solves P0 + t·r = A + u·s via 2D cross products. Returns false if parallel.
 */
function intersect(
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  out: { t: number; u: number },
): boolean {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = bx - ax;
  const sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return false;
  const qx = ax - p0x;
  const qy = ay - p0y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return false;
  out.t = t;
  out.u = u;
  return true;
}

function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * k), py - (ay + dy * k));
}

export class StringManager {
  /** All strings, including ones that are fading out. */
  readonly list: HarpString[] = [];
  readonly hits: Hit[] = [];
  private scratch = { t: 0, u: 0 };

  constructor() {
    for (let i = 0; i < MAX_STRINGS + 4; i++) this.hits.push({ s: null as unknown as HarpString, t: 0, u: 0 });
  }

  aliveCount(): number {
    let n = 0;
    for (const s of this.list) if (s.state === 'alive') n++;
    return n;
  }

  /** Lock a new string in place. Returns the string evicted to stay under the cap, if any. */
  add(s: HarpString, nowMs: number): HarpString | null {
    s.createdMs = nowMs;
    s.isDraft = false;
    s.appear = 0;
    this.list.push(s);
    if (this.aliveCount() > MAX_STRINGS) {
      const oldest = this.list.find((x) => x.state === 'alive');
      if (oldest) {
        this.fade(oldest);
        return oldest;
      }
    }
    return null;
  }

  fade(s: HarpString): void {
    if (s.state === 'alive') s.state = 'fading';
    s.grabbed = false;
    s.tension = 0;
  }

  snap(s: HarpString): void {
    s.state = 'snapping';
    s.grabbed = false;
    s.tension = 0;
  }

  /** Fade the most recently added string. */
  undo(): HarpString | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].state === 'alive') {
        this.fade(this.list[i]);
        return this.list[i];
      }
    }
    return null;
  }

  fadeAll(): void {
    for (const s of this.list) this.fade(s);
  }

  /** Start the visual vibration. `startSec` may be slightly in the future (strum ordering). */
  pluck(s: HarpString, velocity: number, u: number, startSec: number, flick: boolean): void {
    s.amp = velocity * Math.min(30, Math.max(5, s.length * 0.05)) * (flick ? 1.3 : 1);
    s.pluckTime = startSec;
    // Plucking off-centre excites the 2nd harmonic more; this also shifts the bulge toward the finger.
    s.h1 = Math.max(0.5, Math.sin(Math.PI * u));
    s.h2 = 0.45 * Math.sin(2 * Math.PI * u);
    s.glow = Math.min(2.2, s.glow + 0.5 + 1.0 * velocity + (flick ? 0.7 : 0));
    s.labelAlpha = 1;
  }

  update(dt: number): void {
    const hoverK = 1 - Math.exp(-dt * 14);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      s.glow *= Math.exp(-dt / Math.max(0.25, s.tau * 0.6));
      s.appear = Math.min(1, s.appear + dt / APPEAR_TIME);
      s.hover += ((s.state === 'alive' ? s.hoverTarget : 0) - s.hover) * hoverK;
      s.labelAlpha = Math.max(0, s.labelAlpha - dt / 1.5);
      if (s.state === 'fading') s.alpha -= dt / FADE_TIME;
      else if (s.state === 'snapping') s.alpha -= dt / SNAP_FADE_TIME;
      if (s.alpha <= 0) {
        s.dead = true;
        this.list.splice(i, 1);
      }
    }
  }

  /**
   * Which locked strings did the finger cross moving from P0 to P1?
   * Fills this.hits sorted by crossing order and returns the count.
   */
  findCrossings(p0x: number, p0y: number, p1x: number, p1y: number, nowMs: number): number {
    let n = 0;
    for (const s of this.list) {
      if (s.state !== 'alive' || s.grabbed) continue;
      if (nowMs - s.createdMs < NEW_STRING_GRACE_MS) continue;
      if (nowMs - s.lastPluckMs < PLUCK_COOLDOWN_MS) continue;
      if (!intersect(p0x, p0y, p1x, p1y, s.ax, s.ay, s.bx, s.by, this.scratch)) continue;
      if (this.scratch.u < END_MARGIN || this.scratch.u > 1 - END_MARGIN) continue;
      if (n >= this.hits.length) break;
      const h = this.hits[n++];
      h.s = s;
      h.t = this.scratch.t;
      h.u = this.scratch.u;
    }
    // Insertion sort by t (tiny n, no allocation)
    for (let i = 1; i < n; i++) {
      const cur = this.hits[i];
      let j = i - 1;
      while (j >= 0 && this.hits[j].t > cur.t) {
        this.hits[j + 1] = this.hits[j];
        j--;
      }
      this.hits[j + 1] = cur;
    }
    return n;
  }

  /**
   * Nearest pluckable string within `maxDist` px of the finger path (for flicks
   * that whip past a string without quite crossing it). Writes u into `out`.
   */
  nearestToPath(
    p0x: number,
    p0y: number,
    p1x: number,
    p1y: number,
    maxDist: number,
    nowMs: number,
    out: { u: number },
  ): HarpString | null {
    let best: HarpString | null = null;
    let bestD = maxDist;
    for (const s of this.list) {
      if (s.state !== 'alive' || s.grabbed) continue;
      if (nowMs - s.createdMs < NEW_STRING_GRACE_MS || nowMs - s.lastPluckMs < PLUCK_COOLDOWN_MS) continue;
      const d = Math.min(
        pointSegDist(p1x, p1y, s.ax, s.ay, s.bx, s.by),
        pointSegDist(p0x, p0y, s.ax, s.ay, s.bx, s.by),
        pointSegDist(s.ax, s.ay, p0x, p0y, p1x, p1y),
        pointSegDist(s.bx, s.by, p0x, p0y, p1x, p1y),
      );
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      const dx = best.bx - best.ax;
      const dy = best.by - best.ay;
      const l2 = dx * dx + dy * dy || 1;
      out.u = Math.max(0.05, Math.min(0.95, ((p1x - best.ax) * dx + (p1y - best.ay) * dy) / l2));
    }
    return best;
  }

  /**
   * The alive string closest to (x, y), within maxDist px of it, measured
   * anywhere along its middle section (GRAB_U_MIN … 1 − GRAB_U_MIN). Writes
   * where along the string into out.u.
   */
  nearestGrabbable(x: number, y: number, maxDist: number, out: { u: number }): HarpString | null {
    let best: HarpString | null = null;
    let bestD = maxDist;
    for (const s of this.list) {
      if (s.state !== 'alive' || s.grabbed) continue;
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const l2 = dx * dx + dy * dy || 1;
      const u = ((x - s.ax) * dx + (y - s.ay) * dy) / l2;
      if (u < GRAB_U_MIN || u > 1 - GRAB_U_MIN) continue;
      const d = Math.hypot(x - (s.ax + dx * u), y - (s.ay + dy * u));
      if (d < bestD) {
        bestD = d;
        best = s;
        out.u = u;
      }
    }
    return best;
  }

  retuneAll(diag: number): void {
    for (const s of this.list) s.retune(diag);
  }

  /** Keep strings in the same relative place (and on the same note, if still close) when the window resizes. */
  rescale(sx: number, sy: number, diag: number): void {
    for (const s of this.list) s.setEnds(s.ax * sx, s.ay * sy, s.bx * sx, s.by * sy, diag, s.pitch.midi);
  }
}
