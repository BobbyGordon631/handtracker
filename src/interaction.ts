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
/** Pinch within this many px of a string's middle section (or 0.4 × hand size if larger) to grab it. */
const GRAB_RADIUS_PX = 26;
const GRAB_RADIUS_SCALE = 0.4;
/** Pull a grabbed string this far from its rest line (px, or 22% of its length if larger) to snap it. */
const SNAP_PULL_PX = 75;
const SNAP_PULL_OF_LENGTH = 0.22;
/**
 * The second hand's pinch only joins a one-hand draft (turning it into a
 * two-hand string) if it comes this soon after the first, or while the draft is
 * still too short to place. Later, the other hand pinching is an independent
 * action and must not yank the string you're drawing over to it.
 */
const TWO_HAND_WINDOW_MS = 600;
/** Opening the fingers after a pinch moves the index tip; don't let that pluck for this long. */
const PLUCK_AFTER_RELEASE_MS = 200;
/** Fingers closer than threshold × this start showing what a pinch would do (highlight the string it would grab). */
const HOVER_RATIO = 2.0;
/** Cap (px) on the spring-back swing when you let go of a pulled string. */
const MAX_RELEASE_AMP = 60;

const IDLE = 0;
const DRAFT = 1;
const GRAB = 2;
const CONSUMED = 3; // still pinching, but the pinch already did its job; wait for release

/** What a hand is doing, for the visuals. */
export const HandMode = { Idle: 0, Draw: 1, Grab: 2 } as const;
export type HandMode = (typeof HandMode)[keyof typeof HandMode];

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
  private draftStartMs = 0;
  private anchorX = 0; // one-hand mode: fixed start point
  private anchorY = 0;

  private busy = [IDLE, IDLE];
  private grab: (HarpString | null)[] = [null, null];
  /** The string each idle hand would grab if it pinched now (drives the highlight and the pinch-dot colour). */
  readonly hover: (HarpString | null)[] = [null, null];
  private nearOut = { u: 0 };
  private grabOut = { u: 0 };

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

  mode(i: number): HandMode {
    const b = this.busy[i];
    return b === DRAFT ? HandMode.Draw : b === GRAB ? HandMode.Grab : HandMode.Idle;
  }

  update(nowMs: number): void {
    const g = this.gestures.hands;

    // 1. Hands lost past the grace period: cancel whatever they were doing (never commit).
    for (let i = 0; i < 2; i++) if (!g[i].present && this.busy[i] !== IDLE) this.onLost(i);
    // 2. Releases
    for (let i = 0; i < 2; i++) if (g[i].pinchEnded) this.onRelease(i, nowMs);
    // 3. New pinches
    for (let i = 0; i < 2; i++) if (g[i].pinchStarted) this.onPinch(i, nowMs);
    // 4. Live updates
    this.updateDraft();
    this.updateGrabs();
    this.updateHover(nowMs);
    // 5. Plucks, from free hands on fresh camera frames. A hand that is closing
    //    toward a pinch, or just opened one, is busy with its fingers, not strumming.
    for (let i = 0; i < 2; i++) {
      const h = g[i];
      if (!h.fresh || this.busy[i] !== IDLE || h.pinching || h.closing) continue;
      if (nowMs - h.releasedMs < PLUCK_AFTER_RELEASE_MS) continue;
      this.pluckWith(h, nowMs);
    }
    // 6. Fingers-crossed hold
    for (let i = 0; i < 2; i++) {
      if (g[i].holdFired) {
        this.particles.burst(g[i].dPalmX, g[i].dPalmY, 46, 520, 190);
        this.clearAll();
      }
    }
  }

  private grabRadius(g: HandGesture): number {
    return Math.max(GRAB_RADIUS_PX, g.scale * GRAB_RADIUS_SCALE);
  }

  /** Would a pinch by hand i now turn the other hand's fresh one-hand draft into a two-hand string? */
  private wouldJoinDraft(i: number, nowMs: number): boolean {
    return (
      this.draftActive &&
      this.draftB < 0 &&
      this.draftA === 1 - i &&
      (nowMs - this.draftStartMs < TWO_HAND_WINDOW_MS || this.draft.length < this.minLength)
    );
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  private onPinch(i: number, nowMs: number): void {
    const g = this.gestures.hands[i];

    if (this.wouldJoinDraft(i, nowMs)) {
      this.draftB = i;
      this.busy[i] = DRAFT;
      return;
    }

    // Pinching on a string's middle section grabs it (to pull and break it).
    // Test where the fingers actually met, then where the highlight was drawn,
    // so a string that lit up is always the one you get.
    const s =
      this.strings.nearestGrabbable(g.rawPinchX, g.rawPinchY, this.grabRadius(g), this.grabOut) ??
      (this.hover[i] && this.strings.nearestGrabbable(g.dPinchX, g.dPinchY, this.grabRadius(g), this.grabOut));
    if (s) {
      s.grabbed = true;
      s.gu = this.grabOut.u;
      s.gx = g.dPinchX;
      s.gy = g.dPinchY;
      s.tension = 0;
      this.grab[i] = s;
      this.busy[i] = GRAB;
      return;
    }

    if (!this.draftActive) {
      this.draftActive = true;
      this.draftA = i;
      this.draftB = -1;
      this.draftStartMs = nowMs;
      this.anchorX = g.rawPinchX;
      this.anchorY = g.rawPinchY;
      this.draft.setEnds(this.anchorX, this.anchorY, this.anchorX, this.anchorY, this.view.diag);
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
    const prefer = this.draft.pitch.midi;
    if (this.draftB >= 0) {
      const b = g[this.draftB];
      this.draft.setEnds(a.dPinchX, a.dPinchY, b.dPinchX, b.dPinchY, this.view.diag, prefer);
    } else {
      this.draft.setEnds(this.anchorX, this.anchorY, a.dPinchX, a.dPinchY, this.view.diag, prefer);
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
      bx = o.dPinchX;
      by = o.dPinchY;
      this.busy[other] = CONSUMED; // still pinched; must release before starting anything new
    } else {
      ax = this.anchorX;
      ay = this.anchorY;
      bx = r.stableX;
      by = r.stableY;
    }
    const shownMidi = this.draft.pitch.midi;
    this.endDraft();

    if (Math.hypot(bx - ax, by - ay) < this.minLength) return;
    const s = new HarpString();
    // Keep the note the draft was showing unless the final length is clearly a different one.
    s.setEnds(ax, ay, bx, by, this.view.diag, shownMidi);
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
      if (s) {
        s.grabbed = false;
        s.tension = 0;
      }
      this.grab[i] = null;
    }
  }

  // ── Grab / snap ────────────────────────────────────────────────────────────

  /** Rest point of the string at its grab position. */
  private restX(s: HarpString): number {
    return s.ax + (s.bx - s.ax) * s.gu;
  }
  private restY(s: HarpString): number {
    return s.ay + (s.by - s.ay) * s.gu;
  }

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
      s.gx = g.dPinchX;
      s.gy = g.dPinchY;
      const pull = Math.hypot(s.gx - this.restX(s), s.gy - this.restY(s));
      const limit = Math.max(SNAP_PULL_PX, s.length * SNAP_PULL_OF_LENGTH);
      s.tension = Math.min(1, pull / limit);
      if (pull > limit) {
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

  /** Let go before it snapped: it springs back from where you held it, and rings. */
  private releaseGrab(i: number, nowMs: number): void {
    const s = this.grab[i];
    this.grab[i] = null;
    if (!s) return;
    const rx = this.restX(s);
    const ry = this.restY(s);
    const pull = Math.hypot(s.gx - rx, s.gy - ry);
    s.grabbed = false;
    s.tension = 0;
    if (s.state !== 'alive') return;
    const vel = Math.min(1, Math.max(0.2, pull / 100));
    this.strings.pluck(s, vel, s.gu, nowMs / 1000, false);
    // Start the standing wave at the displacement you were holding (signed, along
    // the string's normal) so it swings back through rest instead of teleporting.
    const L = Math.max(1, s.length);
    const signed = ((s.gx - rx) * -(s.by - s.ay)) / L + ((s.gy - ry) * (s.bx - s.ax)) / L;
    const shape = s.h1 * Math.sin(Math.PI * s.gu) + s.h2 * Math.sin(2 * Math.PI * s.gu) * Math.cos(0.7);
    if (Math.abs(shape) > 0.2) s.amp = Math.max(-MAX_RELEASE_AMP, Math.min(MAX_RELEASE_AMP, signed / shape));
    s.lastPluckMs = nowMs;
    this.audio.pluck({ id: s.id, freq: s.pitch.freq, velocity: vel, position: s.gu, pan: this.pan(s), decay: s.decay });
  }

  /**
   * Show intent before it happens: as an idle hand's thumb and index close in
   * on a string's middle, that string lights up (and the pinch dot turns red),
   * so you can tell "this pinch will grab" from "this pinch will draw".
   */
  private updateHover(nowMs: number): void {
    for (const s of this.strings.list) s.hoverTarget = 0;
    const on = settings.pinchThreshold;
    for (let i = 0; i < 2; i++) {
      this.hover[i] = null;
      const g = this.gestures.hands[i];
      if (this.busy[i] === GRAB) {
        const s = this.grab[i];
        if (s) s.hoverTarget = 1;
        continue;
      }
      if (!g.present || this.busy[i] !== IDLE || g.pinching) continue;
      const r = g.pinchRatio;
      if (r > on * HOVER_RATIO || this.wouldJoinDraft(i, nowMs)) continue;
      const s = this.strings.nearestGrabbable(g.dPinchX, g.dPinchY, this.grabRadius(g), this.grabOut);
      if (!s) continue;
      const t = Math.min(1, Math.max(0, (on * HOVER_RATIO - r) / (on * (HOVER_RATIO - 1))));
      s.hoverTarget = Math.max(s.hoverTarget, 0.25 + 0.75 * t);
      this.hover[i] = s;
    }
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
      this.hover[i] = null;
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
