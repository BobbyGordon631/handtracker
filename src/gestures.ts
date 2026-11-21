import { settings } from './settings';
import { LM, type HandTracker, type TrackedHand } from './tracking';

// ─────────────────────────────────────────────────────────────────────────────
// Gesture thresholds. All distances are normalised by hand size
// (wrist → middle knuckle, in px) so they work near or far from the camera.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pinch hysteresis: a pinch STARTS when thumb–index distance ÷ hand size drops
 * below settings.pinchThreshold (default 0.32) and only ENDS once it rises above
 * threshold × 1.45 (≈ 0.46). The dead band stops a pinch flickering on/off when
 * the fingers hover right at the threshold.
 */
export const PINCH_RELEASE_FACTOR = 1.45;

/** Finger counts as extended if wrist→tip is this much longer than wrist→PIP joint. */
const FINGER_EXTENDED_RATIO = 1.2;
/** Thumb counts as out if thumb tip is at least this far (× hand size) from the index knuckle. */
const THUMB_OUT_RATIO = 0.5;
/** Palm must stay within this radius (× hand size) of where the hold started. */
const PALM_STILL_RADIUS = 0.35;
/** Hold an open palm still this long to clear everything. */
export const PALM_HOLD_MS = 1500;
/** Don't show the progress ring for brief open-palm moments. */
export const PALM_SHOW_MS = 200;

/** Fingertip indices in TIP_LM order: thumb, index, middle, ring, pinky. */
export const TIP_LM = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP] as const;
export const TIP_INDEX = 1;

function extended(h: TrackedHand, tip: number, pip: number): boolean {
  const wx = h.x(LM.WRIST);
  const wy = h.y(LM.WRIST);
  return Math.hypot(h.x(tip) - wx, h.y(tip) - wy) > Math.hypot(h.x(pip) - wx, h.y(pip) - wy) * FINGER_EXTENDED_RATIO;
}

/** How many camera frames back to look for a "stable" pinch point on release. */
const PINCH_HISTORY = 3;

export class HandGesture {
  present = false;
  /** True when this frame carries a fresh detection (not a grace-period hold). */
  fresh = false;
  scale = 100;

  pinching = false;
  pinchStarted = false; // edge: this frame
  pinchEnded = false; // edge: this frame (NOT fired when tracking is lost)
  pinchRatio = 1;
  pinchX = 0;
  pinchY = 0;
  /**
   * Pinch point from a couple of frames ago. Opening the fingers to release a
   * pinch drags the midpoint for a frame or two before the release registers;
   * committing with this value keeps the string where the user meant it.
   */
  stableX = 0;
  stableY = 0;
  private histX = new Float32Array(PINCH_HISTORY);
  private histY = new Float32Array(PINCH_HISTORY);
  private histN = 0;

  open = false;
  palmX = 0;
  palmY = 0;
  holdProgress = 0;
  holdFired = false;
  private holdStart = 0;
  private anchorX = 0;
  private anchorY = 0;
  /** After a clear, the palm must close or leave before it can clear again. */
  private latched = false;

  readonly tipX = new Float32Array(5);
  readonly tipY = new Float32Array(5);
  readonly prevX = new Float32Array(5);
  readonly prevY = new Float32Array(5);
  /** Fingertip speed in screen diagonals per second. */
  readonly speed = new Float32Array(5);

  /** Time of this hand's last fresh detection, so speed spans any frames it was missing. */
  private lastFreshMs = 0;

  update(h: TrackedHand, fresh: boolean, nowMs: number, diag: number, clearArmed: boolean): void {
    this.pinchStarted = false;
    this.pinchEnded = false;
    this.holdFired = false;
    this.present = h.alive;
    this.fresh = fresh && h.visible;

    if (!this.present) {
      // Lost for good. The interaction controller cancels any draft for us;
      // we deliberately don't fire pinchEnded so no string gets committed.
      this.pinching = false;
      this.open = false;
      this.holdProgress = 0;
      this.latched = false;
      this.histN = 0;
      return;
    }

    if (this.fresh) {
      this.scale = h.scale;
      const dt = h.justAppeared || !this.lastFreshMs ? 1 / 30 : Math.max(1 / 240, (nowMs - this.lastFreshMs) / 1000);
      this.lastFreshMs = nowMs;

      // Fingertips + velocity
      for (let k = 0; k < 5; k++) {
        const x = h.x(TIP_LM[k]);
        const y = h.y(TIP_LM[k]);
        if (h.justAppeared) {
          this.prevX[k] = x;
          this.prevY[k] = y;
        } else {
          this.prevX[k] = this.tipX[k];
          this.prevY[k] = this.tipY[k];
        }
        this.tipX[k] = x;
        this.tipY[k] = y;
        this.speed[k] = Math.hypot(x - this.prevX[k], y - this.prevY[k]) / dt / diag;
      }

      // Pinch with hysteresis
      const tx = h.x(LM.THUMB_TIP);
      const ty = h.y(LM.THUMB_TIP);
      const ix = h.x(LM.INDEX_TIP);
      const iy = h.y(LM.INDEX_TIP);
      this.pinchRatio = Math.hypot(tx - ix, ty - iy) / h.scale;
      const on = settings.pinchThreshold;
      const off = on * PINCH_RELEASE_FACTOR;
      if (h.justAppeared) this.pinching = false; // never inherit a pinch across a re-acquire
      if (!this.pinching && this.pinchRatio < on) {
        this.pinching = true;
        this.pinchStarted = true;
        this.histN = 0;
      } else if (this.pinching && this.pinchRatio > off) {
        this.pinching = false;
        this.pinchEnded = true;
      }
      this.pinchX = (tx + ix) / 2;
      this.pinchY = (ty + iy) / 2;

      // Stable pinch point = oldest entry of a short history
      if (this.pinching || this.pinchEnded) {
        if (!this.pinchEnded) {
          for (let k = PINCH_HISTORY - 1; k > 0; k--) {
            this.histX[k] = this.histX[k - 1];
            this.histY[k] = this.histY[k - 1];
          }
          this.histX[0] = this.pinchX;
          this.histY[0] = this.pinchY;
          this.histN = Math.min(PINCH_HISTORY, this.histN + 1);
        }
        const k = Math.max(0, this.histN - 1);
        this.stableX = this.histN ? this.histX[k] : this.pinchX;
        this.stableY = this.histN ? this.histY[k] : this.pinchY;
      }

      // Open palm: four fingers extended, thumb out, not pinching
      const wx = h.x(LM.WRIST);
      const wy = h.y(LM.WRIST);
      this.open =
        !this.pinching &&
        extended(h, LM.INDEX_TIP, LM.INDEX_PIP) &&
        extended(h, LM.MIDDLE_TIP, LM.MIDDLE_PIP) &&
        extended(h, LM.RING_TIP, LM.RING_PIP) &&
        extended(h, LM.PINKY_TIP, LM.PINKY_PIP) &&
        Math.hypot(tx - h.x(LM.INDEX_MCP), ty - h.y(LM.INDEX_MCP)) > THUMB_OUT_RATIO * h.scale;

      this.palmX = (wx + h.x(LM.INDEX_MCP) + h.x(LM.MIDDLE_MCP) + h.x(LM.RING_MCP) + h.x(LM.PINKY_MCP)) / 5;
      this.palmY = (wy + h.y(LM.INDEX_MCP) + h.y(LM.MIDDLE_MCP) + h.y(LM.RING_MCP) + h.y(LM.PINKY_MCP)) / 5;

      if (!this.open) {
        this.latched = false;
        this.holdStart = 0;
      } else if (
        this.holdStart === 0 ||
        Math.hypot(this.palmX - this.anchorX, this.palmY - this.anchorY) > PALM_STILL_RADIUS * h.scale
      ) {
        // Started opening, or moved too much: restart the hold timer here.
        this.holdStart = nowMs;
        this.anchorX = this.palmX;
        this.anchorY = this.palmY;
      }
    }

    // Progress runs every render frame so the ring animates smoothly.
    if (this.open && clearArmed && !this.latched && this.holdStart > 0) {
      const held = nowMs - this.holdStart;
      this.holdProgress = held < PALM_SHOW_MS ? 0 : Math.min(1, (held - PALM_SHOW_MS) / (PALM_HOLD_MS - PALM_SHOW_MS));
      if (held >= PALM_HOLD_MS) {
        this.holdFired = true;
        this.latched = true;
        this.holdProgress = 0;
      }
    } else {
      this.holdProgress = 0;
    }
  }
}

export class GestureEngine {
  readonly hands: [HandGesture, HandGesture] = [new HandGesture(), new HandGesture()];

  update(tracker: HandTracker, fresh: boolean, nowMs: number, diag: number, clearArmed: boolean): void {
    for (let i = 0; i < 2; i++) {
      this.hands[i].update(tracker.hands[i], fresh, nowMs, diag, clearArmed);
    }
  }
}
