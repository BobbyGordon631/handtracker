import { settings } from './settings';
import { LM, PALM_LM, Z_WEIGHT, type HandTracker, type TrackedHand } from './tracking';

// ─────────────────────────────────────────────────────────────────────────────
// Gesture thresholds. All distances are normalised by hand size
// (wrist → middle knuckle, in px) so they work near or far from the camera.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pinch hysteresis: a pinch STARTS when thumb–index distance ÷ hand size drops
 * below settings.pinchThreshold (default 0.32) and only ENDS once it rises above
 * threshold × 1.45. The dead band stops a pinch flickering on/off when the
 * fingers hover right at the threshold. Distances are 3D, so a thumb that is
 * merely *behind* the index finger from the camera's view doesn't count.
 */
export const PINCH_RELEASE_FACTOR = 1.45;
/** A pinch must stay closed for this many camera frames before it starts… */
const PINCH_CONFIRM_FRAMES = 2;
/** …unless it's decisively closed (below threshold × this), which starts it at once. */
const PINCH_DECISIVE = 0.65;
/** Likewise a release must persist this many frames (one noisy frame shouldn't drop a string you're drawing)… */
const RELEASE_CONFIRM_FRAMES = 2;
/** …unless the fingers are clearly apart (above release threshold × this). */
const RELEASE_DECISIVE = 1.35;
/**
 * Palm speed (screen diagonals / s) above which a closing pinch is ignored. A
 * hand sweeping this fast is strumming or just moving, not deliberately
 * starting a string or grabbing one. The fingers must open again before that
 * pinch can count, so slowing down at the end of a strum doesn't start one.
 */
const PINCH_MAX_START_SPEED = 0.9;
/** On release, the pinch point is taken from the last frame where the fingers were still this closed (× threshold). */
const PINCH_FIRM_FACTOR = 1.1;
/** Camera frames of pinch history kept for picking the release point. */
const PINCH_HISTORY = 6;

/** Finger counts as extended if wrist→tip is this much longer than wrist→PIP joint. */
const FINGER_EXTENDED_RATIO = 1.1;

// Fingers crossed (index over middle) → clear all strings.
/** The index tip must sit at least this far (× hand size) past the middle tip, toward the pinky side. */
const CROSS_MARGIN = 0.06;
/** Index→pinky knuckle span must be at least this (× hand size), i.e. the palm roughly faces the camera, or the test is unreliable. */
const CROSS_MIN_PALM_WIDTH = 0.3;
/** Brief misreads shorter than this don't restart the hold. */
const CROSS_DROPOUT_MS = 220;
/** Hand must stay within this radius (× hand size) of where the hold started. */
const CROSS_STILL_RADIUS = 0.6;
/** Hold crossed fingers this long to clear everything. */
export const CROSS_HOLD_MS = 1000;
/** Don't show the progress ring for brief crossings. */
export const CROSS_SHOW_MS = 150;

/** Fingertip indices in TIP_LM order: thumb, index, middle, ring, pinky. */
export const TIP_LM = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP] as const;
export const TIP_INDEX = 1;

function extended(h: TrackedHand, tip: number, pip: number): boolean {
  const wx = h.x(LM.WRIST);
  const wy = h.y(LM.WRIST);
  return Math.hypot(h.x(tip) - wx, h.y(tip) - wy) > Math.hypot(h.x(pip) - wx, h.y(pip) - wy) * FINGER_EXTENDED_RATIO;
}

/**
 * 3D distance between two landmarks from the *unsmoothed* detection. Smoothing
 * delays a quick pinch by a frame or more; the confirmation frames and
 * hysteresis already reject the extra noise.
 */
function rawDist3(h: TrackedHand, a: number, b: number): number {
  const r = h.raw;
  return Math.hypot(r[a * 2] - r[b * 2], r[a * 2 + 1] - r[b * 2 + 1], (h.rawZ[a] - h.rawZ[b]) * Z_WEIGHT);
}

/**
 * Index and middle fingers crossed. In the image that means the index tip has
 * swapped sides with the middle tip: measured along the knuckle line (index
 * knuckle → pinky knuckle), the index tip normally sits on the index side of
 * the middle tip. This works for either hand, palm or back towards the camera,
 * and any rotation, because the axis comes from the hand itself.
 */
function fingersCrossed(h: TrackedHand): boolean {
  if (!extended(h, LM.INDEX_TIP, LM.INDEX_PIP) || !extended(h, LM.MIDDLE_TIP, LM.MIDDLE_PIP)) return false;
  let ax = h.x(LM.PINKY_MCP) - h.x(LM.INDEX_MCP);
  let ay = h.y(LM.PINKY_MCP) - h.y(LM.INDEX_MCP);
  const w = Math.hypot(ax, ay);
  if (w < CROSS_MIN_PALM_WIDTH * h.scale) return false;
  ax /= w;
  ay /= w;
  const c = ((h.x(LM.INDEX_TIP) - h.x(LM.MIDDLE_TIP)) * ax + (h.y(LM.INDEX_TIP) - h.y(LM.MIDDLE_TIP)) * ay) / h.scale;
  return c > CROSS_MARGIN;
}

export class HandGesture {
  present = false;
  /** True when this frame carries a fresh detection (not a grace-period hold). */
  fresh = false;
  scale = 100;

  pinching = false;
  pinchStarted = false; // edge: this frame
  pinchEnded = false; // edge: this frame (NOT fired when tracking is lost)
  pinchRatio = 1;
  /** Pinch point at the last camera frame (smoothed). */
  pinchX = 0;
  pinchY = 0;
  /**
   * Unsmoothed pinch point at the last camera frame: exactly where the fingers
   * met. Smoothed and display positions trail a quickly closing thumb, so a
   * pinch's start point (string anchor, grab test) uses this instead.
   */
  rawPinchX = 0;
  rawPinchY = 0;
  /**
   * Where the pinch really was when it let go. Opening the fingers drags the
   * thumb–index midpoint for a frame or two before the release registers, so
   * this is the point from the last frame the fingers were still firmly closed.
   */
  stableX = 0;
  stableY = 0;
  /** performance.now() of the last pinch release, so the opening fingers don't pluck. */
  releasedMs = -1e9;
  /** Fingers are closing toward a pinch that hasn't started (yet). Plucks are suppressed. */
  closing = false;
  private below = 0;
  private above = 0;
  /** A closing pinch was disqualified (hand moving fast); wait for the fingers to open. */
  private blocked = false;
  private histX = new Float32Array(PINCH_HISTORY);
  private histY = new Float32Array(PINCH_HISTORY);
  private histR = new Float32Array(PINCH_HISTORY);
  private histN = 0;

  crossed = false;
  palmX = 0;
  palmY = 0;
  /** Palm speed in screen diagonals per second. */
  palmSpeed = 0;
  holdProgress = 0;
  holdFired = false;
  private crossSeenMs = -1e9;
  private holdStart = 0;
  private anchorX = 0;
  private anchorY = 0;
  /** After a clear, the fingers must uncross before it can clear again. */
  private latched = false;

  readonly tipX = new Float32Array(5);
  readonly tipY = new Float32Array(5);
  readonly prevX = new Float32Array(5);
  readonly prevY = new Float32Array(5);
  /** Fingertip speed in screen diagonals per second. */
  readonly speed = new Float32Array(5);

  // Render-rate (display) positions: smooth at the screen's refresh rate. Use for visuals and live drawing.
  readonly dTipX = new Float32Array(5);
  readonly dTipY = new Float32Array(5);
  dPinchX = 0;
  dPinchY = 0;
  dPalmX = 0;
  dPalmY = 0;
  /** 0 → 1 as the hand pinches, animated for the fingertip visuals. */
  pinchVis = 0;

  update(h: TrackedHand, fresh: boolean, nowMs: number, dt: number, diag: number, clearArmed: boolean): void {
    this.pinchStarted = false;
    this.pinchEnded = false;
    this.holdFired = false;
    this.present = h.alive;
    this.fresh = fresh && h.visible;

    if (!this.present) {
      // Lost for good. The interaction controller cancels any draft for us;
      // we deliberately don't fire pinchEnded so no string gets committed.
      this.pinching = false;
      this.closing = false;
      this.crossed = false;
      this.holdProgress = 0;
      this.holdStart = 0;
      this.latched = false;
      this.histN = 0;
      this.below = this.above = 0;
      this.blocked = false;
      this.pinchVis = 0;
      h.holdOn = false;
      return;
    }

    if (this.fresh) {
      this.scale = h.scale;
      const sdt = h.sampleDt;
      const restart = h.justAppeared || h.teleported;

      // Fingertips + velocity
      for (let k = 0; k < 5; k++) {
        const x = h.x(TIP_LM[k]);
        const y = h.y(TIP_LM[k]);
        if (restart) {
          this.prevX[k] = x;
          this.prevY[k] = y;
        } else {
          this.prevX[k] = this.tipX[k];
          this.prevY[k] = this.tipY[k];
        }
        this.tipX[k] = x;
        this.tipY[k] = y;
        this.speed[k] = Math.hypot(x - this.prevX[k], y - this.prevY[k]) / sdt / diag;
      }
      this.palmX = h.palmX();
      this.palmY = h.palmY();
      this.palmSpeed = Math.hypot(h.palmVX(), h.palmVY()) / diag;

      this.updatePinch(h, nowMs);
      this.updateCrossed(h, nowMs);
    }

    // ── Render-rate values ───────────────────────────────────────────────────
    for (let k = 0; k < 5; k++) {
      this.dTipX[k] = h.dx(TIP_LM[k]);
      this.dTipY[k] = h.dy(TIP_LM[k]);
    }
    this.dPinchX = (this.dTipX[0] + this.dTipX[1]) / 2;
    this.dPinchY = (this.dTipY[0] + this.dTipY[1]) / 2;
    let px = 0;
    let py = 0;
    for (const i of PALM_LM) {
      px += h.dx(i);
      py += h.dy(i);
    }
    this.dPalmX = px / PALM_LM.length;
    this.dPalmY = py / PALM_LM.length;
    this.pinchVis += ((this.pinching ? 1 : 0) - this.pinchVis) * (1 - Math.exp(-dt * 22));
    h.holdOn = this.pinching;

    // Progress runs every render frame so the ring animates smoothly.
    if (this.crossed && clearArmed && !this.latched && this.holdStart > 0) {
      const held = nowMs - this.holdStart;
      this.holdProgress =
        held < CROSS_SHOW_MS ? 0 : Math.min(1, (held - CROSS_SHOW_MS) / (CROSS_HOLD_MS - CROSS_SHOW_MS));
      if (held >= CROSS_HOLD_MS) {
        this.holdFired = true;
        this.latched = true;
        this.holdProgress = 0;
      }
    } else {
      this.holdProgress = 0;
    }
  }

  private updatePinch(h: TrackedHand, nowMs: number): void {
    const r = rawDist3(h, LM.THUMB_TIP, LM.INDEX_TIP) / h.scale;
    this.pinchRatio = r;
    this.pinchX = (h.x(LM.THUMB_TIP) + h.x(LM.INDEX_TIP)) / 2;
    this.pinchY = (h.y(LM.THUMB_TIP) + h.y(LM.INDEX_TIP)) / 2;
    this.rawPinchX = (h.raw[LM.THUMB_TIP * 2] + h.raw[LM.INDEX_TIP * 2]) / 2;
    this.rawPinchY = (h.raw[LM.THUMB_TIP * 2 + 1] + h.raw[LM.INDEX_TIP * 2 + 1]) / 2;
    const on = settings.pinchThreshold;
    const off = on * PINCH_RELEASE_FACTOR;

    if (h.justAppeared) {
      // Never inherit a pinch across a re-acquire.
      this.pinching = false;
      this.below = this.above = 0;
      this.blocked = false;
    }

    if (!this.pinching) {
      if (r >= on) {
        this.below = 0;
        this.blocked = false;
      } else {
        this.below++;
        if (this.palmSpeed > PINCH_MAX_START_SPEED) this.blocked = true;
        if (!this.blocked && (this.below >= PINCH_CONFIRM_FRAMES || r < on * PINCH_DECISIVE)) {
          this.pinching = true;
          this.pinchStarted = true;
          this.above = 0;
          this.histN = 0;
        }
      }
      this.closing = !this.pinching && r < on;
    } else {
      this.above = r > off ? this.above + 1 : 0;
      if (this.above >= RELEASE_CONFIRM_FRAMES || r > off * RELEASE_DECISIVE) {
        this.pinching = false;
        this.pinchEnded = true;
        this.releasedMs = nowMs;
        this.below = 0;
      }
      this.closing = false;
    }

    if (this.pinching || this.pinchEnded) {
      // Newest first.
      for (let k = PINCH_HISTORY - 1; k > 0; k--) {
        this.histX[k] = this.histX[k - 1];
        this.histY[k] = this.histY[k - 1];
        this.histR[k] = this.histR[k - 1];
      }
      this.histX[0] = this.pinchX;
      this.histY[0] = this.pinchY;
      this.histR[0] = r;
      this.histN = Math.min(PINCH_HISTORY, this.histN + 1);
      // Most recent frame where the fingers were still firmly closed; else the oldest we have.
      let k = this.histN - 1;
      for (let j = 0; j < this.histN; j++) {
        if (this.histR[j] < on * PINCH_FIRM_FACTOR) {
          k = j;
          break;
        }
      }
      this.stableX = this.histX[k];
      this.stableY = this.histY[k];
    }
  }

  private updateCrossed(h: TrackedHand, nowMs: number): void {
    if (!this.pinching && fingersCrossed(h)) this.crossSeenMs = nowMs;
    const wasCrossed = this.crossed;
    this.crossed = nowMs - this.crossSeenMs < CROSS_DROPOUT_MS;
    if (!this.crossed) {
      this.latched = false;
      this.holdStart = 0;
      return;
    }
    if (
      !wasCrossed ||
      this.holdStart === 0 ||
      Math.hypot(this.palmX - this.anchorX, this.palmY - this.anchorY) > CROSS_STILL_RADIUS * h.scale
    ) {
      // Just crossed, or moved too much: restart the hold timer here.
      this.holdStart = nowMs;
      this.anchorX = this.palmX;
      this.anchorY = this.palmY;
    }
  }
}

export class GestureEngine {
  readonly hands: [HandGesture, HandGesture] = [new HandGesture(), new HandGesture()];

  update(tracker: HandTracker, fresh: boolean, nowMs: number, dt: number, diag: number, clearArmed: boolean): void {
    for (let i = 0; i < 2; i++) {
      this.hands[i].update(tracker.hands[i], fresh, nowMs, dt, diag, clearArmed);
    }
  }
}
