import type { AudioEngine } from './audio';
import { TIP_INDEX, type GestureEngine, type HandGesture } from './gestures';
import type { ParticleSystem } from './particles';
import { settings } from './settings';
import { HarpString, type StringManager } from './strings';

// ─────────────────────────────────────────────────────────────────────────────
// Interaction thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Strings shorter than this fraction of the screen diagonal are discarded on release (accidental pinches). */
const MIN_STRING_OF_DIAGONAL = 0.04;
/** Fingertip speed (diagonals/s) below which crossing a string doesn't pluck it — filters out jitter. */
const MIN_PLUCK_SPEED = 0.12;
/** Fingertip speed (diagonals/s) that counts as a full-velocity pluck. */
const FULL_VELOCITY_SPEED = 3.0;
/** Minimum fingertip movement (px) between frames to test for crossings. */
const MIN_MOVE_PX = 2;
/** A flick that passes within this many px of a string (without crossing) still sparks it. */
const FLICK_NEAR_PX = 28;
/** Pinch within this radius of a string's midpoint (px, or 0.6 × hand size if larger) to grab it. */
const GRAB_RADIUS_PX = 34;
/** Pull a grabbed string's middle this far (px, or 30% of its length if larger) to snap it. */
const SNAP_PULL_PX = 80;

const IDLE = 0;
const DRAFT = 1;
const GRAB = 2;
const CONSUMED = 3; // still pinching, but the pinch already did its job; wait for release

const PLUCK_TIPS_INDEX: readonly number[] = [TIP_INDEX];
const PLUCK_TIPS_ALL: readonly number[] = [0, 1, 2, 3, 4];

export interface View {
  width: number;
  height: number;
  diag: number;
}

export class Controller {
  /** The live string being drawn (rendered translucent, not yet in the manager). */
  readonly draft = new HarpString();
  draftActive = false;
  private draftA = -1; // hand that started the draft
  private draftB = -1; // second hand in two-hand mode, else -1
  private anchorX = 0; // one-hand mode: fixed start point
  private anchorY = 0;

  private busy = [IDLE, IDLE];
  private grab: (HarpString | null)[] = [null, null];
  private nearOut = { u: 0 };

  constructor(
    private gestures: GestureEngine,
    private strings: StringManager,
    private audio: AudioEngine,
    private particles: ParticleSystem,
    private view: View,
  ) {
    this.draft.isDraft = true;
  }

  get minLength(): number {
    return this.view.diag * MIN_STRING_OF_DIAGONAL;
  }

  update(nowMs: number): void {
    const g = this.gestures.hands;

    // 1. Hands lost past the grace period: cancel whatever they were doing (never commit).
    for (let i = 0; i < 2; i++) if (!g[i].present && this.busy[i] !== IDLE) this.onLost(i);
    // 2. Releases
    for (let i = 0; i < 2; i++) if (g[i].pinchEnded) this.onRelease(i, nowMs);
    // 3. New pinches
    for (let i = 0; i < 2; i++) if (g[i].pinchStarted) this.onPinch(i);
    // 4. Live updates
    this.updateDraft();
    this.updateGrabs();
    // 5. Plucks, from free (non-pinching) hands on fresh camera frames
    for (let i = 0; i < 2; i++) {
      if (g[i].fresh && this.busy[i] === IDLE && !g[i].pinching) this.pluckWith(g[i], nowMs);
    }
    // 6. Open-palm hold
    for (let i = 0; i < 2; i++) if (g[i].holdFired) this.clearAll();
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  private onPinch(i: number): void {
    const g = this.gestures.hands[i];
    const other = 1 - i;

    // Other hand is drawing one-handed → this pinch upgrades it to a two-hand string.
    if (this.draftActive && this.draftB < 0 && this.draftA === other) {
      this.draftB = i;
      this.busy[i] = DRAFT;
      return;
    }

    // Pinching near a string's midpoint grabs it.
    const s = this.strings.nearestMidpoint(g.pinchX, g.pinchY, Math.max(GRAB_RADIUS_PX, g.scale * 0.6));
    if (s) {
      s.grabbed = true;
      s.gx = g.pinchX;
      s.gy = g.pinchY;
      this.grab[i] = s;
      this.busy[i] = GRAB;
      return;
    }

    if (!this.draftActive) {
      this.draftActive = true;
      this.draftA = i;
      this.draftB = -1;
      this.anchorX = g.pinchX;
      this.anchorY = g.pinchY;
      this.draft.setEnds(g.pinchX, g.pinchY, g.pinchX, g.pinchY, this.view.diag);
      this.busy[i] = DRAFT;
      return;
    }
    this.busy[i] = CONSUMED;
  }

  private updateDraft(): void {
    if (!this.draftActive) {
      this.audio.preview(false, 0);
      return;
    }
    const g = this.gestures.hands;
    const a = g[this.draftA];
    if (this.draftB >= 0) {
      const b = g[this.draftB];
      this.draft.setEnds(a.pinchX, a.pinchY, b.pinchX, b.pinchY, this.view.diag);
    } else {
      this.draft.setEnds(this.anchorX, this.anchorY, a.pinchX, a.pinchY, this.view.diag);
    }
    const longEnough = this.draft.length >= this.minLength;
    this.audio.preview(longEnough, this.draft.pitch.freq);
  }

  private onRelease(i: number, nowMs: number): void {
    const state = this.busy[i];
    this.busy[i] = IDLE;
    if (state === DRAFT) this.commitDraft(i, nowMs);
    else if (state === GRAB) this.releaseGrab(i, nowMs);
  }

  private commitDraft(releasing: number, nowMs: number): void {
    const g = this.gestures.hands;
    const r = g[releasing];
    let ax: number, ay: number, bx: number, by: number;
    if (this.draftB >= 0) {
      // Two-hand: the releasing hand uses its pre-release (stable) point; the other its live point.
      const other = releasing === this.draftA ? this.draftB : this.draftA;
      const o = g[other];
      ax = r.stableX;
      ay = r.stableY;
      bx = o.pinchX;
      by = o.pinchY;
      this.busy[other] = CONSUMED; // still pinched; must release before starting anything new
    } else {
      ax = this.anchorX;
      ay = this.anchorY;
      bx = r.stableX;
      by = r.stableY;
    }
    this.endDraft();

    if (Math.hypot(bx - ax, by - ay) < this.minLength) return;
    const s = new HarpString();
    s.setEnds(ax, ay, bx, by, this.view.diag);
    const evicted = this.strings.add(s, nowMs);
    if (evicted) this.particles.dissolve(evicted);

    // Soft confirmation pluck so you hear the note you just placed.
    this.strings.pluck(s, 0.35, 0.5, nowMs / 1000, false);
    this.audio.pluck({ id: s.id, freq: s.pitch.freq, velocity: 0.35, position: 0.5, pan: this.pan(s), decay: s.decay });
    console.info(
      `[string] #${s.id} length ${s.length.toFixed(0)}px → ${s.pitch.name} ` +
        `(${s.pitch.freq.toFixed(1)} Hz, raw ${s.pitch.rawFreq.toFixed(1)} Hz) · ${this.strings.aliveCount()} strings`,
    );
  }

  private endDraft(): void {
    this.draftActive = false;
    this.draftA = this.draftB = -1;
    this.audio.preview(false, 0);
  }

  private onLost(i: number): void {
    const state = this.busy[i];
    this.busy[i] = IDLE;
    if (state === DRAFT) {
      // Tracking dropped mid-draw: cancel rather than commit a phantom string.
      const other = this.draftA === i ? this.draftB : this.draftA;
      if (other >= 0 && this.busy[other] === DRAFT) this.busy[other] = CONSUMED;
      this.endDraft();
    } else if (state === GRAB) {
      const s = this.grab[i];
      if (s) s.grabbed = false;
      this.grab[i] = null;
    }
  }

  // ── Grab / snap ────────────────────────────────────────────────────────────

  private updateGrabs(): void {
    for (let i = 0; i < 2; i++) {
      const s = this.grab[i];
      if (!s || this.busy[i] !== GRAB) continue;
      if (s.state !== 'alive') {
        this.grab[i] = null;
        this.busy[i] = CONSUMED;
        continue;
      }
      const g = this.gestures.hands[i];
      s.gx = g.pinchX;
      s.gy = g.pinchY;
      const pull = Math.hypot(s.gx - s.midX, s.gy - s.midY);
      if (pull > Math.max(SNAP_PULL_PX, s.length * 0.3)) {
        // Pulled too far: it snaps.
        this.strings.snap(s);
        this.particles.dissolve(s, true);
        this.particles.burst(s.gx, s.gy, 30, 500, s.hue);
        this.audio.snap(this.pan(s));
        this.grab[i] = null;
        this.busy[i] = CONSUMED;
      }
    }
  }

  /** Let go before it snapped: it springs back and rings. */
  private releaseGrab(i: number, nowMs: number): void {
    const s = this.grab[i];
    this.grab[i] = null;
    if (!s) return;
    const pull = Math.hypot(s.gx - s.midX, s.gy - s.midY);
    s.grabbed = false;
    if (s.state !== 'alive') return;
    const vel = Math.min(1, Math.max(0.2, pull / 100));
    this.strings.pluck(s, vel, 0.5, nowMs / 1000, false);
    s.lastPluckMs = nowMs;
    this.audio.pluck({ id: s.id, freq: s.pitch.freq, velocity: vel, position: 0.5, pan: this.pan(s), decay: s.decay });
  }

  // ── Plucking ───────────────────────────────────────────────────────────────

  private pluckWith(g: HandGesture, nowMs: number): void {
    const tips = settings.pluckAllFingers ? PLUCK_TIPS_ALL : PLUCK_TIPS_INDEX;
    for (let t = 0; t < tips.length; t++) {
      const k = tips[t];
      const x0 = g.prevX[k];
      const y0 = g.prevY[k];
      const x1 = g.tipX[k];
      const y1 = g.tipY[k];
      if (Math.hypot(x1 - x0, y1 - y0) < MIN_MOVE_PX) continue;
      const speed = g.speed[k];
      if (speed < MIN_PLUCK_SPEED) continue;
      const flick = speed >= settings.flickSpeed;
      const vel = Math.min(1, Math.max(0.15, speed / FULL_VELOCITY_SPEED));

      // Every string crossed between last frame and this one, in the order the
      // finger met them. A fast sweep across several = a strum.
      const n = this.strings.findCrossings(x0, y0, x1, y1, nowMs);
      for (let h = 0; h < n; h++) {
        const hit = this.strings.hits[h];
        // Spread the strum over the camera frame interval in crossing order.
        const delay = hit.t * Math.min(0.05, 1 / 30);
        this.trigger(hit.s, hit.u, vel, delay, flick, nowMs);
      }
      if (n === 0 && flick) {
        const s = this.strings.nearestToPath(x0, y0, x1, y1, FLICK_NEAR_PX, nowMs, this.nearOut);
        if (s) this.trigger(s, this.nearOut.u, vel, 0, true, nowMs);
      }
    }
  }

  private trigger(s: HarpString, u: number, vel: number, delay: number, flick: boolean, nowMs: number): void {
    s.lastPluckMs = nowMs;
    this.strings.pluck(s, vel, u, nowMs / 1000 + delay, flick);
    this.audio.pluck({ id: s.id, freq: s.pitch.freq, velocity: vel, position: u, pan: this.pan(s), decay: s.decay, flick, delay });
    if (flick) this.particles.sparksAlong(s, u, vel);
  }

  // ── Clearing ───────────────────────────────────────────────────────────────

  clearAll(): void {
    for (const s of this.strings.list) if (s.state === 'alive') this.particles.dissolve(s);
    this.strings.fadeAll();
    for (let i = 0; i < 2; i++) {
      if (this.busy[i] === GRAB) this.busy[i] = CONSUMED;
      this.grab[i] = null;
    }
  }

  undo(): void {
    const s = this.strings.undo();
    if (s) this.particles.dissolve(s);
  }

  private pan(s: HarpString): number {
    return ((s.midX / this.view.width) * 2 - 1) * 0.7;
  }
}
