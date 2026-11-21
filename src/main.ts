import './style.css';
import { HandLandmarker } from '@mediapipe/tasks-vision';
import { AudioEngine } from './audio';
import { GestureEngine, TIP_INDEX } from './gestures';
import { Controller, type View } from './interaction';
import { refreshScale } from './music';
import { ParticleSystem } from './particles';
import { Renderer } from './render';
import { createGui, settings } from './settings';
import { HarpString, POINTS, StringManager, computePoints } from './strings';
import { CameraError, HandTracker } from './tracking';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');
const video = $<HTMLVideoElement>('cam');
const debugCanvas = $<HTMLCanvasElement>('debug');
const debugCtx = debugCanvas.getContext('2d')!;
const fpsEl = $('fps');
const overlay = $('overlay');
const startBtn = $<HTMLButtonElement>('start');
const statusEl = $('status');
const errorEl = $('error');

// ── Core objects ─────────────────────────────────────────────────────────────
const view: View = { width: window.innerWidth, height: window.innerHeight, diag: 1 };
const renderer = new Renderer(app, $('labels'));
const tracker = new HandTracker(video);
const audio = new AudioEngine();
const strings = new StringManager();
const particles = new ParticleSystem();
renderer.addPoints(particles.points, particles.material);
const gestures = new GestureEngine();
const controller = new Controller(gestures, strings, audio, particles, view);
const scratch = new Float32Array(POINTS * 2);

const gui = createGui({
  onMusicChange() {
    refreshScale();
    strings.retuneAll(view.diag);
  },
  onSoundChange: () => audio.applySettings(),
  onLookChange: () => renderer.applySettings(),
  onDebugChange() {
    debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
    fpsEl.textContent = '';
  },
});

// Start fetching the model right away so it's ready by the time the user clicks.
let modelError: unknown = null;
const modelReady = tracker.loadModel().catch((e) => {
  modelError = e;
  console.error('[tracking] model failed to load', e);
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const sx = w / view.width;
  const sy = h / view.height;
  view.width = w;
  view.height = h;
  view.diag = Math.hypot(w, h);
  renderer.resize(w, h);
  tracker.setViewport(w, h);
  if (sx !== 1 || sy !== 1) strings.rescale(sx, sy, view.diag);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  debugCanvas.width = w * dpr;
  debugCanvas.height = h * dpr;
  debugCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ── Start / errors ───────────────────────────────────────────────────────────
function showError(title: string, msg: string): void {
  overlay.hidden = true;
  $('error-title').textContent = title;
  $('error-msg').textContent = msg;
  errorEl.hidden = false;
}

function cameraErrorText(e: unknown): [string, string] {
  if (e instanceof CameraError) {
    switch (e.kind) {
      case 'denied':
        return [
          'Camera access denied',
          'Air Harp needs your camera to see your hands. Allow camera access for this site (click the camera icon in the address bar, or check System Settings → Privacy & Security → Camera), then try again.',
        ];
      case 'notfound':
        return ['No camera found', 'Connect a webcam and try again.'];
      case 'inuse':
        return ['Camera busy', 'Another app is using the camera. Close it and try again.'];
      case 'insecure':
        return ['Secure context required', e.message];
      default:
        return ['Camera error', e.message];
    }
  }
  return ['Camera error', String(e)];
}

$('retry').addEventListener('click', () => location.reload());

let running = false;
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  // Audio must start inside the click handler (before any await) to satisfy autoplay rules.
  const audioReady = audio.init().catch((e) => console.error('[audio] init failed', e));

  statusEl.textContent = 'Waiting for camera…';
  try {
    await tracker.startCamera();
  } catch (e) {
    showError(...cameraErrorText(e));
    return;
  }
  renderer.setVideo(video);
  resize();

  if (!tracker.ready) statusEl.textContent = 'Loading hand-tracking model…';
  await modelReady;
  if (!tracker.ready) {
    showError('Hand tracking failed to load', `Check your connection and reload. (${String(modelError)})`);
    return;
  }
  await audioReady;
  console.info(`[tracking] HandLandmarker ready (${tracker.delegate} delegate)`);

  overlay.hidden = true;
  if (!running) {
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
});

// ── Keyboard ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement)?.closest?.('.lil-gui')) return;
  const k = e.key.toLowerCase();
  if (k === 'h') {
    if (gui._hidden) gui.show();
    else gui.hide();
  } else if (k === 'c') controller.clearAll();
  else if (k === 'z') controller.undo();
});

// ── Dev console hook (stripped from production builds) ───────────────────────
// e.g. airHarp.addString(300, 200, 900, 600); airHarp.pluck(0, 1, true)
if (import.meta.env.DEV) {
  Object.assign(window, {
    airHarp: {
      settings,
      strings,
      tracker,
      audio,
      gestures,
      controller,
      addString(ax: number, ay: number, bx: number, by: number) {
        const s = new HarpString();
        s.setEnds(ax, ay, bx, by, view.diag);
        strings.add(s, performance.now() - 1000);
        return `${s.pitch.name} ${s.pitch.freq.toFixed(1)} Hz`;
      },
      pluck(i: number, velocity = 0.8, flick = false) {
        const s = strings.list[i];
        if (!s) return;
        strings.pluck(s, velocity, 0.4, performance.now() / 1000, flick);
        audio.pluck({ id: s.id, freq: s.pitch.freq, velocity, position: 0.4, pan: 0, decay: s.decay, flick });
        if (flick) particles.sparksAlong(s, 0.4, velocity);
      },
      clear: () => controller.clearAll(),
    },
  });
}

// ── Main loop ────────────────────────────────────────────────────────────────
let lastFrame = 0;
let renderFps = 60;

function frame(): void {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const dt = Math.min(0.1, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  if (dt > 0) renderFps += (1 / dt - renderFps) * 0.05;
  const now = nowMs / 1000;

  const fresh = tracker.detect(nowMs);
  renderer.setCover(tracker.coverX, tracker.coverY);
  gestures.update(tracker, fresh, nowMs, view.diag, strings.aliveCount() > 0);
  controller.update(nowMs);
  strings.update(dt);
  particles.update(dt, now);

  draw(now);
  if (settings.debug) drawDebug();
}

function draw(now: number): void {
  renderer.beginFrame();

  for (const s of strings.list) {
    computePoints(s, now, scratch);
    // Pluck glow brightens the string and thickens it slightly.
    renderer.drawString(scratch, 4.5 + s.glow * 0.6, s.hue, 1 + s.glow * 0.55, s.alpha);
    renderer.sprite(s.ax, s.ay, 9, s.hue, 0.7, 0.7, 0.9 * s.alpha);
    renderer.sprite(s.bx, s.by, 9, s.hue, 0.7, 0.7, 0.9 * s.alpha);
    if (s.labelAlpha > 0) labelFor(s.pitch.name, s.ax, s.ay, s.bx, s.by, s.labelAlpha * 0.55 * s.alpha, s.hue);
  }

  const d = controller.draft;
  if (controller.draftActive && d.length >= controller.minLength) {
    computePoints(d, now, scratch);
    renderer.drawString(scratch, 4, d.hue, 0.9, 0.55);
    labelFor(d.pitch.name, d.ax, d.ay, d.bx, d.by, 0.75, d.hue);
  }

  // Fingertip dots: thumb + index per hand (plus other tips when they can pluck).
  for (let i = 0; i < 2; i++) {
    const g = gestures.hands[i];
    if (!g.present) {
      renderer.palmRing(i, 0, 0, 0, 0);
      continue;
    }
    const dim = g.fresh || tracker.hands[i].visible ? 1 : 0.4; // dim during the grace period
    if (g.pinching) {
      renderer.sprite(g.pinchX, g.pinchY, 22, 45, 0.6, 0.8, 1.6 * dim);
    } else {
      renderer.sprite(g.tipX[0], g.tipY[0], 12, 190, 0.8, 0.75, 0.9 * dim);
      renderer.sprite(g.tipX[TIP_INDEX], g.tipY[TIP_INDEX], 14, 190, 0.6, 0.85, 1.2 * dim);
      if (settings.pluckAllFingers) {
        for (let k = 2; k < 5; k++) renderer.sprite(g.tipX[k], g.tipY[k], 10, 190, 0.8, 0.75, 0.7 * dim);
      }
    }
    renderer.palmRing(i, g.palmX, g.palmY, g.scale * 1.6, g.holdProgress);
  }

  renderer.endFrame();
}

/** Note name, offset to one side of the string's midpoint. */
function labelFor(text: string, ax: number, ay: number, bx: number, by: number, alpha: number, hue: number): void {
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy) || 1;
  let nx = -dy / L;
  let ny = dx / L;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  } // always above the string
  renderer.labels.add(text, (ax + bx) / 2 + nx * 22, (ay + by) / 2 + ny * 22, alpha, hue);
}

function drawDebug(): void {
  const ctx = debugCtx;
  ctx.clearRect(0, 0, view.width, view.height);
  const conns = HandLandmarker.HAND_CONNECTIONS;
  for (let i = 0; i < 2; i++) {
    const h = tracker.hands[i];
    if (!h.alive) continue;
    ctx.strokeStyle = i === 0 ? 'rgba(120,220,255,0.6)' : 'rgba(255,180,120,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const c of conns) {
      ctx.moveTo(h.x(c.start), h.y(c.start));
      ctx.lineTo(h.x(c.end), h.y(c.end));
    }
    ctx.stroke();
    for (let j = 0; j < 21; j++) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; // raw
      ctx.fillRect(h.raw[j * 2] - 1.5, h.raw[j * 2 + 1] - 1.5, 3, 3);
      ctx.fillStyle = i === 0 ? '#7fe3ff' : '#ffb478'; // smoothed
      ctx.beginPath();
      ctx.arc(h.x(j), h.y(j), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const g = gestures.hands[i];
    ctx.fillStyle = '#fff';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(
      `${h.label || '?'} pinch ${g.pinchRatio.toFixed(2)}${g.pinching ? ' ●' : ''}${g.open ? ' open' : ''} v ${g.speed[TIP_INDEX].toFixed(2)}${h.visible ? '' : ' (grace)'}`,
      h.x(0) + 10,
      h.y(0) + 16,
    );
  }
  fpsEl.textContent = `${renderFps.toFixed(0)} fps · tracking ${tracker.detectFps.toFixed(0)} fps (${tracker.delegate}) · ${strings.aliveCount()} strings · audio ${audio.usingWorklet ? 'worklet' : 'fallback'}`;
}
