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

/**
 * How many consecutive camera frames a hand may go undetected before we treat
 * it as gone. ~5 frames ≈ 170 ms at 30 fps: long enough to ride out a dropped
 * detection mid-gesture, short enough that a hand that really left doesn't
 * leave a ghost behind. While in grace the hand's last pose is frozen.
 */
export const GRACE_FRAMES = 5;

// ─────────────────────────────────────────────────────────────────────────────
// One Euro filter (Casiez et al. 2012): a low-pass filter whose cutoff rises
// with speed. Still hands → heavy smoothing (no jitter); fast hands → light
// smoothing (no lag). Operates in screen pixels.
// ─────────────────────────────────────────────────────────────────────────────
export class OneEuroFilter {
  minCutoff = 1.2;
  beta = 0.012;
  dCutoff = 1.0;
  private x = 0;
  private dx = 0;
  private primed = false;

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset(): void {
    this.primed = false;
  }

  filter(value: number, dt: number): number {
    if (!this.primed) {
      this.primed = true;
      this.x = value;
      this.dx = 0;
      return value;
    }
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(cutoff, dt) * (value - this.x);
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
  missed = 0;
  /** 'Left' | 'Right' from the subject's point of view. */
  label = '';
  /** 21 smoothed landmarks in screen px, interleaved x,y. */
  readonly lm = new Float32Array(42);
  /** 21 unsmoothed landmarks in screen px (for debug view). */
  readonly raw = new Float32Array(42);
  /** Hand size in px: wrist → middle-finger knuckle. Used to normalise gestures. */
  scale = 100;
  readonly filters: OneEuroFilter[] = Array.from({ length: 42 }, () => new OneEuroFilter());

  constructor(readonly slot: number) {}

  x(i: number): number {
    return this.lm[i * 2];
  }
  y(i: number): number {
    return this.lm[i * 2 + 1];
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
  private viewW = 1;
  private viewH = 1;
  private vidW = 0;
  private vidH = 0;

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
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
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
    for (const hand of this.hands) for (const f of hand.filters) f.reset();
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

  /**
   * Run detection if the camera has produced a new frame. Returns true when the
   * hands were updated this call.
   */
  detect(nowMs: number): boolean {
    const lm = this.landmarker;
    const v = this.video;
    if (!lm || v.readyState < 2) return false;
    if (v.currentTime === this.lastVideoTime) return false; // same frame as last time: skip
    this.lastVideoTime = v.currentTime;
    if (v.videoWidth !== this.vidW || v.videoHeight !== this.vidH) this.updateCover();

    const ts = Math.max(nowMs, this.lastTs + 1); // MediaPipe needs strictly increasing timestamps
    this.lastTs = ts;
    const res = lm.detectForVideo(v, ts);

    const dt = this.lastDetectMs ? (nowMs - this.lastDetectMs) / 1000 : 1 / 30;
    this.lastDetectMs = nowMs;
    this.detectDt = Math.min(0.25, Math.max(1 / 240, dt));
    this.detectFps += (1 / this.detectDt - this.detectFps) * 0.1;
    this.lastResult = res.landmarks;

    // ── Match detections to our two persistent hand slots ───────────────────
    // MediaPipe's output order isn't stable, so we keep identities by nearest
    // wrist position (plus a handedness tiebreaker).
    const n = Math.min(res.landmarks.length, 2);
    let d0 = -1; // detection index assigned to slot 0
    let d1 = -1;
    if (n === 1) {
      if (this.cost(0, res.landmarks[0], this.labelOf(res, 0)) <= this.cost(1, res.landmarks[0], this.labelOf(res, 0))) d0 = 0;
      else d1 = 0;
    } else if (n === 2) {
      const a =
        this.cost(0, res.landmarks[0], this.labelOf(res, 0)) + this.cost(1, res.landmarks[1], this.labelOf(res, 1));
      const b =
        this.cost(0, res.landmarks[1], this.labelOf(res, 1)) + this.cost(1, res.landmarks[0], this.labelOf(res, 0));
      if (a <= b) {
        d0 = 0;
        d1 = 1;
      } else {
        d0 = 1;
        d1 = 0;
      }
    }
    this.applyTo(this.hands[0], d0 >= 0 ? res.landmarks[d0] : null, d0 >= 0 ? this.labelOf(res, d0) : '');
    this.applyTo(this.hands[1], d1 >= 0 ? res.landmarks[d1] : null, d1 >= 0 ? this.labelOf(res, d1) : '');
    return true;
  }

  private labelOf(res: { handedness: { categoryName: string }[][] }, i: number): string {
    return res.handedness[i]?.[0]?.categoryName ?? '';
  }

  private cost(slot: number, det: NormalizedLandmark[], label: string): number {
    const h = this.hands[slot];
    const mismatch = h.label && label && h.label !== label ? 1 : 0;
    if (!h.alive) return 400 + mismatch * 100;
    const wx = this.toScreenX(det[LM.WRIST].x);
    const wy = this.toScreenY(det[LM.WRIST].y);
    return Math.hypot(wx - h.x(LM.WRIST), wy - h.y(LM.WRIST)) + mismatch * 250;
  }

  private applyTo(h: TrackedHand, det: NormalizedLandmark[] | null, label: string): void {
    if (!det) {
      h.visible = false;
      h.justAppeared = false;
      if (h.alive && ++h.missed > GRACE_FRAMES) h.alive = false;
      return;
    }
    h.justAppeared = !h.alive;
    if (h.justAppeared) for (const f of h.filters) f.reset();
    const dt = this.detectDt;
    const minCutoff = settings.minCutoff;
    const beta = settings.beta;
    for (let i = 0; i < 21; i++) {
      const sx = this.toScreenX(det[i].x);
      const sy = this.toScreenY(det[i].y);
      h.raw[i * 2] = sx;
      h.raw[i * 2 + 1] = sy;
      const fx = h.filters[i * 2];
      const fy = h.filters[i * 2 + 1];
      fx.minCutoff = fy.minCutoff = minCutoff;
      fx.beta = fy.beta = beta;
      h.lm[i * 2] = fx.filter(sx, dt);
      h.lm[i * 2 + 1] = fy.filter(sy, dt);
    }
    h.scale = Math.max(20, Math.hypot(h.x(LM.MIDDLE_MCP) - h.x(LM.WRIST), h.y(LM.MIDDLE_MCP) - h.y(LM.WRIST)));
    h.alive = true;
    h.visible = true;
    h.missed = 0;
    h.label = label;
  }
}
