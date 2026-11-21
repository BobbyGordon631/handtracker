import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { settings } from './settings';

// Keep in sync with the installed @mediapipe/tasks-vision version (package.json).
export const MEDIAPIPE_VERSION = '1.2.3';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** MediaPipe hand landmark indices we use. */
export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
} as const;

/** Wrist + the four knuckles: the rigid part of the hand. Its centre and speed drive matching and smoothing. */
export const PALM_LM = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const;

/**
 * How long (ms) a hand may go undetected before we treat it as gone. Long
 * enough to ride out dropped detections (fast motion blurs the hand and
 * MediaPipe loses it for a frame or two), short enough that a hand that really
 * left doesn't leave a ghost behind.
 */
export const GRACE_MS = 220;
/** Longer grace while the hand is pinching (drawing or holding a string): losing it there costs the user work. */
export const GRACE_PINCH_MS = 450;
/** A newly seen hand must be detected in this many consecutive frames before it counts. Filters out one-frame phantom hands. */
const CONFIRM_FRAMES = 2;
/**
 * A detection this far (× hand size) from where we predicted the hand would be
 * is held back for one frame as a likely glitch (MediaPipe sometimes snaps a
 * hand's landmarks onto the other hand or onto background clutter). If the next
 * frame agrees with it, the hand really moved and we accept it.
 */
const JUMP_SCALE = 3;
/** Two detections whose palms are closer than this (× hand size) are the same hand detected twice. */
const DUPLICATE_SCALE = 0.6;
/**
 * Render-time prediction. Camera frames arrive at ~30 fps but we draw at the
 * display rate, so between frames we extrapolate along each landmark's
 * velocity. The lead eases toward this many seconds rather than growing
 * linearly, so a hand that stops (or drops out) never overshoots far.
 */
const PREDICT_TAU = 0.035;
/** Never extrapolate further than this (× hand size), whatever the velocity. */
const PREDICT_MAX_SCALE = 0.4;
/**
 * When a new frame arrives, the gap between where we drew the hand and where it
 * really is closes with this time constant (s) instead of jumping. Keeps motion
 * continuous without adding steady-state lag.
 */
const CORRECT_TAU = 0.03;
/** MediaPipe's depth is noisier than x/y, so it counts for this much in 3D distances. */
export const Z_WEIGHT = 0.6;

// ─────────────────────────────────────────────────────────────────────────────
// One Euro filter (Casiez et al. 2012), applied to a whole hand at once.
//
// A One Euro filter is a low-pass whose cutoff rises with speed: still hands
// get heavy smoothing (no jitter), fast hands light smoothing (no lag). Running
// an independent filter per coordinate (as before) has two problems:
//   • x and y of the same point get different cutoffs, so a horizontal swipe
//     left the vertical axis heavily smoothed and the path skewed;
//   • fingers and wrist get different amounts of lag during a fast move, which
//     warps the hand's shape — enough to make a pinch flicker on or off.
// Here each landmark's cutoff comes from max(its own 2D speed, the palm's
// speed), so the whole hand moves as one while fingers that move relative to
// the palm (closing a pinch) still respond quickly.
// ─────────────────────────────────────────────────────────────────────────────
export class HandFilter {
  dCutoff = 1.5;
  /** Filtered x, y, z per landmark (px). */
  readonly x = new Float32Array(63);
  private dx = new Float32Array(63);
  private primed = false;

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset(): void {
    this.primed = false;
  }

  filter(raw: Float32Array, dt: number, minCutoff: number, beta: number): Float32Array {
    if (!this.primed) {
      this.primed = true;
      this.x.set(raw);
      this.dx.fill(0);
      return this.x;
    }
    const ad = HandFilter.alpha(this.dCutoff, dt);
    for (let k = 0; k < 63; k++) {
      this.dx[k] += ad * ((raw[k] - this.x[k]) / dt - this.dx[k]);
    }
    let palmSpeed = 0;
    for (const i of PALM_LM) palmSpeed += Math.hypot(this.dx[i * 3], this.dx[i * 3 + 1]);
    palmSpeed /= PALM_LM.length;
    for (let i = 0; i < 21; i++) {
      const o = i * 3;
      const speed = Math.max(palmSpeed, Math.hypot(this.dx[o], this.dx[o + 1]));
      const a = HandFilter.alpha(minCutoff + beta * speed, dt);
      this.x[o] += a * (raw[o] - this.x[o]);
      this.x[o + 1] += a * (raw[o + 1] - this.x[o + 1]);
      this.x[o + 2] += a * (raw[o + 2] - this.x[o + 2]);
    }
    return this.x;
  }
}

export class TrackedHand {
  /** True while detected or within the grace period. */
  alive = false;
  /** True only if the hand was detected in the most recent camera frame. */
  visible = false;
  /** True on the first frame after (re)acquiring the hand. */
  justAppeared = false;
  /** True on a frame where the hand jumped somewhere new (confirmed over two frames): don't treat the jump as motion. */
  teleported = false;
  /** 'Left' | 'Right' from the subject's point of view. */
  label = '';
  /** 21 smoothed landmarks at the last camera frame, screen px, interleaved x,y. Gesture logic reads these. */
  readonly lm = new Float32Array(42);
  /** Smoothed depth per landmark, in the same px units as x (MediaPipe's z is relative to the wrist). */
  readonly z = new Float32Array(21);
  /** Velocity of each smoothed landmark, px/s, interleaved x,y. */
  readonly vel = new Float32Array(42);
  /** Render-rate landmarks: last frame + short prediction + fading correction. Visuals read these. */
  readonly disp = new Float32Array(42);
  /** 21 unsmoothed landmarks in screen px (debug view, and pinch detection, which needs speed over smoothness). */
  readonly raw = new Float32Array(42);
  /** Unsmoothed depth per landmark, same units as z. */
  readonly rawZ = new Float32Array(21);
  private corr = new Float32Array(42);
  private prev = new Float32Array(42);
  /** Hand size in px: wrist → middle-finger knuckle, in 3D so it doesn't shrink when the hand tilts. */
  scale = 100;
  /** performance.now() of the last accepted camera frame. */
  sampleMs = 0;
  /** Seconds between this hand's last two accepted frames (video clock). */
  sampleDt = 1 / 30;
  sampleClock = 0;
  /** Set by the gesture layer each frame: extends the grace period while the hand is pinching. */
  holdOn = false;
  // New-hand confirmation
  pending = 0;
  pendX = 0;
  pendY = 0;
  // Glitch rejection
  jumpPending = false;
  jumpX = 0;
  jumpY = 0;
  readonly filter = new HandFilter();

  constructor(readonly slot: number) {}

  x(i: number): number {
    return this.lm[i * 2];
  }
  y(i: number): number {
    return this.lm[i * 2 + 1];
  }
  /** Display (render-rate) position of landmark i. */
  dx(i: number): number {
    return this.disp[i * 2];
  }
  dy(i: number): number {
    return this.disp[i * 2 + 1];
  }

  palmX(): number {
    let s = 0;
    for (const i of PALM_LM) s += this.lm[i * 2];
    return s / PALM_LM.length;
  }
  palmY(): number {
    let s = 0;
    for (const i of PALM_LM) s += this.lm[i * 2 + 1];
    return s / PALM_LM.length;
  }
  palmVX(): number {
    let s = 0;
    for (const i of PALM_LM) s += this.vel[i * 2];
    return s / PALM_LM.length;
  }
  palmVY(): number {
    let s = 0;
    for (const i of PALM_LM) s += this.vel[i * 2 + 1];
    return s / PALM_LM.length;
  }

  /** Recompute render positions for this display frame. */
  updateDisplay(nowMs: number, dt: number): void {
    if (!this.alive) return;
    const t = Math.max(0, (nowMs - this.sampleMs) / 1000);
    const lead = PREDICT_TAU * (1 - Math.exp(-t / PREDICT_TAU));
    // Cap the extrapolation by the palm's predicted travel so a huge velocity spike can't fling the drawing.
    const pvx = this.palmVX() * lead;
    const pvy = this.palmVY() * lead;
    const travel = Math.hypot(pvx, pvy);
    const cap = PREDICT_MAX_SCALE * this.scale;
    const k = travel > cap ? (lead * cap) / travel : lead;
    const decay = Math.exp(-dt / CORRECT_TAU);
    for (let j = 0; j < 42; j++) {
      this.corr[j] *= decay;
      this.disp[j] = this.lm[j] + this.vel[j] * k + this.corr[j];
    }
  }

  /** Called with freshly filtered landmarks. `snap` skips velocity and correction (new hand or confirmed teleport). */
  commit(filtered: Float32Array, dt: number, nowMs: number, clock: number, snap: boolean): void {
    this.prev.set(this.lm);
    for (let i = 0; i < 21; i++) {
      this.lm[i * 2] = filtered[i * 3];
      this.lm[i * 2 + 1] = filtered[i * 3 + 1];
      this.z[i] = filtered[i * 3 + 2];
    }
    if (snap) {
      this.vel.fill(0);
      this.corr.fill(0);
      this.disp.set(this.lm);
    } else {
      for (let j = 0; j < 42; j++) {
        const inst = (this.lm[j] - this.prev[j]) / dt;
        this.vel[j] += 0.6 * (inst - this.vel[j]);
        // Where we drew it last frame minus where it is now: fades out in updateDisplay.
        this.corr[j] = this.disp[j] - this.lm[j];
      }
    }
    const w = LM.WRIST;
    const m = LM.MIDDLE_MCP;
    const s = Math.max(
      20,
      Math.hypot(this.x(m) - this.x(w), this.y(m) - this.y(w), (this.z[m] - this.z[w]) * Z_WEIGHT),
    );
    this.scale = snap ? s : this.scale + 0.35 * (s - this.scale);
    this.sampleMs = nowMs;
    this.sampleDt = dt;
    this.sampleClock = clock;
  }
}

export type CameraErrorKind = 'denied' | 'notfound' | 'inuse' | 'insecure' | 'other';

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
  }
}

interface Det {
  lm: NormalizedLandmark[];
  label: string;
  score: number;
  cx: number; // palm centre, screen px
  cy: number;
  size: number; // rough hand size, screen px
}

export class HandTracker {
  readonly hands: [TrackedHand, TrackedHand] = [new TrackedHand(0), new TrackedHand(1)];
  landmarker: HandLandmarker | null = null;
  delegate: 'GPU' | 'CPU' = 'GPU';
  /** Seconds between the last two processed camera frames. */
  detectDt = 1 / 30;
  detectFps = 0;
  /** Normalized landmarks from the last result, for the debug overlay. */
  lastResult: NormalizedLandmark[][] = [];

  private lastVideoTime = -1;
  private lastTs = 0;
  private lastDetectMs = 0;
  /** Monotonic camera-frame clock (s), driven by the video's own timestamps where they're sane. */
  private clock = 0;
  private viewW = 1;
  private viewH = 1;
  private vidW = 0;
  private vidH = 0;
  private buf = new Float32Array(63);
  private dets: Det[] = [];

  // object-fit: cover mapping (see updateCover)
  private dispW = 1;
  private dispH = 1;
  private offX = 0;
  private offY = 0;

  constructor(readonly video: HTMLVideoElement) {}

  get ready(): boolean {
    return this.landmarker !== null;
  }

  async loadModel(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO' as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      // Lower presence/tracking thresholds keep MediaPipe in its cheap tracking
      // mode through motion blur instead of dropping the hand and re-detecting.
      // Phantom hands this might let through are filtered by CONFIRM_FRAMES.
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.45,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[tracking] GPU delegate failed, falling back to CPU', err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
      this.delegate = 'CPU';
    }
  }

  async startCamera(): Promise<void> {
    if (!window.isSecureContext) {
      throw new CameraError('insecure', 'The camera needs a secure context. Open the app via https:// or http://localhost.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('notfound', 'This browser does not support camera access.');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CameraError('denied', 'Camera permission was denied.');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        throw new CameraError('notfound', 'No camera was found.');
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        throw new CameraError('inuse', 'The camera is in use by another app.');
      }
      throw new CameraError('other', `Could not start the camera (${name ?? e}).`);
    }
    this.video.srcObject = stream;
    await new Promise<void>((resolve) => {
      if (this.video.readyState >= 2) resolve();
      else this.video.onloadeddata = () => resolve();
    });
    await this.video.play();
    this.updateCover();
  }

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.updateCover();
    for (const hand of this.hands) hand.filter.reset();
  }

  /**
   * object-fit: cover math. The video is scaled uniformly so it fills the
   * viewport, then centred; whichever axis overflows is cropped equally on
   * both sides. The render shader uses the same numbers (coverX/coverY).
   */
  private updateCover(): void {
    this.vidW = this.video.videoWidth || 1280;
    this.vidH = this.video.videoHeight || 720;
    const s = Math.max(this.viewW / this.vidW, this.viewH / this.vidH);
    this.dispW = this.vidW * s;
    this.dispH = this.vidH * s;
    this.offX = (this.viewW - this.dispW) / 2; // ≤ 0 when cropped horizontally
    this.offY = (this.viewH - this.dispH) / 2;
  }

  /** Displayed video size as a fraction of the viewport (≥ 1 on the cropped axis). */
  get coverX(): number {
    return this.dispW / this.viewW;
  }
  get coverY(): number {
    return this.dispH / this.viewH;
  }

  /** Normalized landmark (video space, un-mirrored) → screen px in the mirrored view. */
  toScreenX(nx: number): number {
    return this.offX + (1 - nx) * this.dispW;
  }
  toScreenY(ny: number): number {
    return this.offY + ny * this.dispH;
  }

  /** Advance both hands' render positions. Call once per display frame, after detect(). */
  updateDisplay(nowMs: number, dt: number): void {
    for (const h of this.hands) h.updateDisplay(nowMs, dt);
  }

  /**
   * Run detection if the camera has produced a new frame. Returns true when the
   * hands were updated this call.
   */
  detect(nowMs: number): boolean {
    const lm = this.landmarker;
    const v = this.video;
    if (!lm || v.readyState < 2) return false;
    if (v.currentTime === this.lastVideoTime) return false; // same frame as last time: skip
    const videoDt = v.currentTime - this.lastVideoTime;
    const firstFrame = this.lastVideoTime < 0;
    this.lastVideoTime = v.currentTime;
    if (v.videoWidth !== this.vidW || v.videoHeight !== this.vidH) this.updateCover();

    const ts = Math.max(nowMs, this.lastTs + 1); // MediaPipe needs strictly increasing timestamps
    this.lastTs = ts;
    const res = lm.detectForVideo(v, ts);

    // Frame interval. The render loop only notices a new frame on its next tick,
    // so wall-clock deltas jitter by up to a display frame (±50% at 30 fps) —
    // which made fingertip speeds noisy. The video's own timestamps are exact.
    const wallDt = this.lastDetectMs ? (nowMs - this.lastDetectMs) / 1000 : 1 / 30;
    this.lastDetectMs = nowMs;
    const dt = !firstFrame && videoDt >= 1 / 240 && videoDt <= 0.5 ? videoDt : wallDt;
    this.detectDt = Math.min(0.25, Math.max(1 / 240, dt));
    this.clock += this.detectDt;
    this.detectFps += (1 / this.detectDt - this.detectFps) * 0.1;
    this.lastResult = res.landmarks;

    // ── Collect detections ──────────────────────────────────────────────────
    const dets = this.dets;
    dets.length = 0;
    for (let i = 0; i < res.landmarks.length && i < 2; i++) {
      const l = res.landmarks[i];
      let cx = 0;
      let cy = 0;
      for (const j of PALM_LM) {
        cx += this.toScreenX(l[j].x);
        cy += this.toScreenY(l[j].y);
      }
      const cat = res.handedness[i]?.[0];
      dets.push({
        lm: l,
        label: cat?.categoryName ?? '',
        score: cat?.score ?? 0,
        cx: cx / PALM_LM.length,
        cy: cy / PALM_LM.length,
        size: Math.hypot(
          (l[LM.MIDDLE_MCP].x - l[LM.WRIST].x) * this.dispW,
          (l[LM.MIDDLE_MCP].y - l[LM.WRIST].y) * this.dispH,
        ),
      });
    }
    // The same hand detected twice (happens when hands overlap or one is half
    // out of frame) would spawn a second hand right on top of the first.
    if (dets.length === 2) {
      const [a, b] = dets;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < DUPLICATE_SCALE * Math.max(a.size, b.size, 20)) {
        dets.splice(a.score >= b.score ? 1 : 0, 1);
      }
    }

    // ── Match detections to our two persistent hand slots ───────────────────
    // MediaPipe's output order isn't stable, so we keep identities by nearest
    // predicted palm position (plus a handedness tiebreaker).
    let d0: Det | null = null;
    let d1: Det | null = null;
    if (dets.length === 1) {
      if (this.cost(0, dets[0], nowMs) <= this.cost(1, dets[0], nowMs)) d0 = dets[0];
      else d1 = dets[0];
    } else if (dets.length === 2) {
      const a = this.cost(0, dets[0], nowMs) + this.cost(1, dets[1], nowMs);
      const b = this.cost(0, dets[1], nowMs) + this.cost(1, dets[0], nowMs);
      if (a <= b) {
        d0 = dets[0];
        d1 = dets[1];
      } else {
        d0 = dets[1];
        d1 = dets[0];
      }
    }
    this.applyTo(this.hands[0], d0, nowMs);
    this.applyTo(this.hands[1], d1, nowMs);
    return true;
  }

  private cost(slot: number, d: Det, nowMs: number): number {
    const h = this.hands[slot];
    const mismatch = h.label && d.label && h.label !== d.label ? 1 : 0;
    if (!h.alive) return 400 + mismatch * 100;
    const lead = Math.min(0.1, (nowMs - h.sampleMs) / 1000);
    const px = h.palmX() + h.palmVX() * lead;
    const py = h.palmY() + h.palmVY() * lead;
    return Math.hypot(d.cx - px, d.cy - py) + mismatch * 250;
  }

  private miss(h: TrackedHand, nowMs: number): void {
    h.visible = false;
    h.justAppeared = false;
    h.teleported = false;
    if (!h.alive) {
      h.pending = 0;
      return;
    }
    if (nowMs - h.sampleMs > (h.holdOn ? GRACE_PINCH_MS : GRACE_MS)) {
      h.alive = false;
      h.jumpPending = false;
      h.pending = 0;
    }
  }

  private applyTo(h: TrackedHand, d: Det | null, nowMs: number): void {
    if (!d) {
      this.miss(h, nowMs);
      return;
    }

    let snap = false;
    if (!h.alive) {
      // New hand: wait for a second consecutive sighting in roughly the same place.
      const near = h.pending > 0 && Math.hypot(d.cx - h.pendX, d.cy - h.pendY) < Math.max(d.size * 2, 60);
      h.pending = near ? h.pending + 1 : 1;
      h.pendX = d.cx;
      h.pendY = d.cy;
      h.visible = false;
      h.justAppeared = false;
      h.teleported = false;
      if (h.pending < CONFIRM_FRAMES) return;
      snap = true;
    } else {
      // Glitch check against where we expected the hand to be.
      const lead = Math.min(0.1, (nowMs - h.sampleMs) / 1000);
      const err = Math.hypot(d.cx - (h.palmX() + h.palmVX() * lead), d.cy - (h.palmY() + h.palmVY() * lead));
      if (err > JUMP_SCALE * h.scale) {
        const agrees = h.jumpPending && Math.hypot(d.cx - h.jumpX, d.cy - h.jumpY) < Math.max(h.scale, 40);
        if (!agrees) {
          h.jumpPending = true;
          h.jumpX = d.cx;
          h.jumpY = d.cy;
          this.miss(h, nowMs);
          return;
        }
        snap = true; // two frames agree: it really moved there
      }
      h.jumpPending = false;
    }

    const buf = this.buf;
    for (let i = 0; i < 21; i++) {
      const sx = this.toScreenX(d.lm[i].x);
      const sy = this.toScreenY(d.lm[i].y);
      h.raw[i * 2] = sx;
      h.raw[i * 2 + 1] = sy;
      buf[i * 3] = sx;
      buf[i * 3 + 1] = sy;
      buf[i * 3 + 2] = h.rawZ[i] = d.lm[i].z * this.dispW; // MediaPipe: z is on roughly the same scale as x
    }
    if (snap) h.filter.reset();
    const dt = snap ? this.detectDt : Math.min(0.25, Math.max(1 / 240, this.clock - h.sampleClock));
    const filtered = h.filter.filter(buf, dt, settings.minCutoff, settings.beta);
    h.commit(filtered, dt, nowMs, this.clock, snap);

    h.justAppeared = !h.alive;
    h.teleported = snap && h.alive;
    h.alive = true;
    h.visible = true;
    h.pending = 0;
    h.label = d.label;
  }
}
