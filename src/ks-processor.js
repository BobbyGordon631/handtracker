/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */
// ─────────────────────────────────────────────────────────────────────────────
// Karplus–Strong plucked-string synth (with the Jaffe–Smith extensions),
// running on the audio thread.
//
// Each voice is a delay line one period long, fed back through a fractional-
// delay allpass, a one-zero low-pass and a loop gain g < 1:
//
//    excitation ─▶(+)─▶[ delay N ]─▶[ allpass Δ ]─▶[ (1−S)·x + S·x₋₁ ]─▶[ ×g ]─┬─▶ out
//                  ▲                                                         │
//                  └─────────────────────────────────────────────────────────┘
//
//  • Pitch:  loop delay N + Δ + (low-pass phase delay ≈ S) = sampleRate / f.
//            The allpass gives the fractional part without adding damping.
//  • Decay:  the per-period gain for a T60 decay is 10^(−3 / (T60·f)). We divide
//            out the low-pass's gain at f, so the fundamental decays with exactly
//            the requested T60 (the main thread uses the same T60 for the visual
//            vibration envelope). The classic S = ½ averager loses too much per
//            period on high notes, so S shrinks there to keep long sustains possible.
//  • Timbre: the excitation is a triangle (initial pluck shape, peaked at the
//            pluck position) mixed with noise, low-passed by "brightness".
//            Flicks add a short noise click on top for a percussive attack.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_VOICES = 24;
const MIN_FREQ = 25;
const G_MAX = 0.99995;

/** Loop design for frequency f and decay t60 at sample rate sr. Mirrored in audio.ts (fallback synth). */
function ksDesign(f, t60, sr) {
  const w = (2 * Math.PI * f) / sr;
  const need = Math.pow(10, -3 / (Math.max(0.05, t60) * f)); // per-period gain for this T60
  // One-zero low-pass |H|² = 1 − 2S(1−S)(1 − cos w). Largest S ≤ ½ whose loss still fits.
  const target = Math.min(1, need / G_MAX);
  const q = Math.min(0.25, (1 - target * target) / (2 * (1 - Math.cos(w)) || 1e-9));
  const S = Math.max(0.02, (1 - Math.sqrt(Math.max(0, 1 - 4 * q))) / 2);
  const H = Math.sqrt(1 - 2 * S * (1 - S) * (1 - Math.cos(w)));
  const g = Math.min(G_MAX, need / H);
  // Exact phase delay of the low-pass at w, then split the rest into integer N + allpass Δ ∈ [0.1, 1.1).
  const lpDelay = Math.atan2(S * Math.sin(w), 1 - S + S * Math.cos(w)) / w;
  const rest = sr / f - lpDelay;
  const N = Math.max(2, Math.floor(rest - 0.1));
  const D = rest - N;
  const C = (1 - D) / (1 + D);
  return { N, C, S, g };
}

class Voice {
  constructor(sr) {
    this.size = Math.ceil(sr / MIN_FREQ) + 8;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.active = false;
    this.id = -1;
    this.N = 100;
    this.C = 0;
    this.S = 0.5;
    this.g = 0.99;
    this.apX = 0; // allpass state
    this.apY = 0;
    this.prev = 0; // low-pass state
    this.gl = 0.707;
    this.gr = 0.707;
    this.peak = 0;
    this.age = 0;
    this.click = 0;
    this.clickDecay = 0;
  }
}

class KSProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(sampleRate));
    this.exc = new Float32Array(Math.ceil(sampleRate / MIN_FREQ) + 8);
    this.queue = [];
    this.seed = 0x9e3779b9;
    this.dcxL = 0;
    this.dcyL = 0;
    this.dcxR = 0;
    this.dcyR = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === 'pluck') this.queue.push(m);
    };
  }

  // xorshift32 → [-1, 1)
  rand() {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 2147483648 - 1;
  }

  allocate(id) {
    let quietest = null;
    let free = null;
    for (const v of this.voices) {
      if (v.active && v.id === id) return { v, reuse: true };
      if (!v.active && !free) free = v;
      if (v.active && (!quietest || v.peak < quietest.peak)) quietest = v;
    }
    return { v: free || quietest, reuse: false };
  }

  start(m) {
    const sr = sampleRate;
    const f = Math.max(MIN_FREQ, Math.min(sr / 8, m.freq));
    const { v, reuse } = this.allocate(m.id);
    if (!v) return;

    if (!reuse) {
      v.buf.fill(0);
      v.prev = v.apX = v.apY = 0;
      v.w = 0;
    }
    const d = ksDesign(f, m.t60, sr);
    v.active = true;
    v.id = m.id;
    v.N = d.N;
    v.C = d.C;
    v.S = d.S;
    v.g = d.g;
    v.age = 0;
    const a = ((Math.max(-1, Math.min(1, m.pan)) + 1) * Math.PI) / 4; // equal-power pan
    v.gl = Math.cos(a);
    v.gr = Math.sin(a);

    // ── Excitation: one period's worth, added into the not-yet-read part of the
    // delay line (so re-plucking a ringing string adds energy, like a real one).
    const N = v.N;
    const e = this.exc;
    const vel = Math.max(0, Math.min(1, m.vel));
    const bright = Math.max(0, Math.min(1, m.bright));
    const pos = Math.max(0.08, Math.min(0.92, m.pos));
    const peakIdx = Math.max(1, Math.min(N - 2, pos * N));
    const noiseMix = 0.25 + 0.5 * bright;
    let mean = 0;
    for (let k = 0; k < N; k++) {
      const tri = k < peakIdx ? k / peakIdx : (N - k) / (N - peakIdx);
      e[k] = tri * (1 - noiseMix) + this.rand() * noiseMix;
      mean += e[k];
    }
    mean /= N;
    // One-pole low-pass, twice: darker for soft plucks, brighter for hard ones.
    const lp = 0.08 + 0.9 * Math.pow(bright, 1.5);
    let y1 = 0;
    let y2 = 0;
    let peak = 1e-6;
    for (let k = 0; k < N; k++) {
      y1 += lp * (e[k] - mean - y1);
      y2 += lp * (y1 - y2);
      e[k] = y2;
      peak = Math.max(peak, Math.abs(y2));
    }
    const amp = (0.38 * Math.pow(vel, 1.2)) / peak;
    for (let k = 0; k < N; k++) {
      let idx = v.w - N + k;
      if (idx < 0) idx += v.size;
      v.buf[idx] += e[k] * amp;
    }

    if (m.flick) {
      v.click = 0.22 * vel;
      v.clickDecay = Math.exp(-1 / (0.004 * sr)); // ~4 ms click
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out.length > 1 ? out[1] : null;
    const n = L.length;

    if (this.queue.length) {
      const due = currentTime + n / sampleRate;
      for (let i = 0; i < this.queue.length; ) {
        if (this.queue[i].when <= due) {
          this.start(this.queue[i]);
          this.queue.splice(i, 1);
        } else i++;
      }
    }

    L.fill(0);
    if (R) R.fill(0);

    for (const v of this.voices) {
      if (!v.active) continue;
      const buf = v.buf;
      const size = v.size;
      const N = v.N;
      const C = v.C;
      const S1 = 1 - v.S;
      const S = v.S;
      const g = v.g;
      let w = v.w;
      let apX = v.apX;
      let apY = v.apY;
      let prev = v.prev;
      let blockPeak = 0;
      for (let s = 0; s < n; s++) {
        let ri = w - N;
        if (ri < 0) ri += size;
        const x = buf[ri];
        const a = C * x + apX - C * apY; // first-order allpass (fractional delay)
        apX = x;
        apY = a;
        const f = g * (S1 * a + S * prev); // one-zero low-pass + loop gain
        prev = a;
        buf[w] = f;
        if (++w >= size) w = 0;
        let o = f;
        if (v.click > 1e-4) {
          o += this.rand() * v.click;
          v.click *= v.clickDecay;
        }
        L[s] += o * v.gl;
        if (R) R[s] += o * v.gr;
        const af = f < 0 ? -f : f;
        if (af > blockPeak) blockPeak = af;
      }
      v.w = w;
      v.apX = apX;
      v.apY = apY;
      v.prev = prev;
      v.peak = blockPeak;
      v.age += n;
      if (v.age > sampleRate * 0.1 && blockPeak < 3e-5) v.active = false;
    }

    // DC blocker
    for (let s = 0; s < n; s++) {
      const xl = L[s];
      this.dcyL = xl - this.dcxL + 0.995 * this.dcyL;
      this.dcxL = xl;
      L[s] = this.dcyL;
      if (R) {
        const xr = R[s];
        this.dcyR = xr - this.dcxR + 0.995 * this.dcyR;
        this.dcxR = xr;
        R[s] = this.dcyR;
      }
    }
    return true;
  }
}

registerProcessor('ks-pluck', KSProcessor);
