import ksProcessorUrl from './ks-processor.js?url';
import { settings } from './settings';

const G_MAX = 0.99995;

/**
 * Karplus–Strong loop design (mirrors ksDesign() in ks-processor.js; see the
 * notes there). Returns integer delay N, allpass coefficient C for the
 * fractional part, low-pass weight S, and loop gain g giving the requested T60.
 */
function ksDesign(f: number, t60: number, sr: number) {
  const w = (2 * Math.PI * f) / sr;
  const need = Math.pow(10, -3 / (Math.max(0.05, t60) * f));
  const target = Math.min(1, need / G_MAX);
  const q = Math.min(0.25, (1 - target * target) / (2 * (1 - Math.cos(w)) || 1e-9));
  const S = Math.max(0.02, (1 - Math.sqrt(Math.max(0, 1 - 4 * q))) / 2);
  const H = Math.sqrt(1 - 2 * S * (1 - S) * (1 - Math.cos(w)));
  const g = Math.min(G_MAX, need / H);
  const lpDelay = Math.atan2(S * Math.sin(w), 1 - S + S * Math.cos(w)) / w;
  const rest = sr / f - lpDelay;
  const N = Math.max(2, Math.floor(rest - 0.1));
  const D = rest - N;
  return { N, C: (1 - D) / (1 + D), S, g };
}

export interface PluckOptions {
  /** String id, so re-plucking a ringing string reuses its voice (adds energy, like a real string). */
  id: number;
  freq: number;
  /** 0..1, from fingertip speed. */
  velocity: number;
  /** 0..1, where along the string it was plucked. */
  position: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** Seconds to T60 (shared with visuals). */
  decay: number;
  flick?: boolean;
  /** Seconds from now (strum ordering). */
  delay?: number;
}

/**
 * Signal flow:
 *
 *   KS voices ─┬──────────────▶ dry ──┐
 *              └─▶ convolver ─▶ wet ──┴─▶ bus ─▶ limiter ─▶ destination
 *   preview osc ─▶ lowpass ─▶ gain ─┘ (into both dry + reverb)
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  ready = false;
  usingWorklet = false;

  private voices!: GainNode; // voice sum (worklet output or fallback sources)
  private dry!: GainNode;
  private wet!: GainNode;
  private bus!: GainNode;
  private worklet: AudioWorkletNode | null = null;

  private previewOsc!: OscillatorNode;
  private previewGain!: GainNode;
  private previewOn = false;
  private previewFreq = 0;

  /**
   * Must be called from a user gesture (click). The AudioContext is created
   * synchronously, before the first await, so browsers allow it to start.
   */
  async init(): Promise<void> {
    if (this.ctx) return;
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    void ctx.resume();

    // Master chain
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);

    this.bus = ctx.createGain();
    this.bus.connect(limiter);

    // Tame the top end a touch so noisy excitations don't get harsh.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 9000;
    tone.Q.value = 0.5;

    this.voices = ctx.createGain();
    this.voices.connect(tone);

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(3.2, 2.6);
    tone.connect(this.dry).connect(this.bus);
    tone.connect(reverb).connect(this.wet).connect(this.bus);

    // Preview tone (while drawing): soft triangle with gentle vibrato.
    this.previewOsc = ctx.createOscillator();
    this.previewOsc.type = 'triangle';
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 6; // cents
    vib.connect(vibDepth).connect(this.previewOsc.detune);
    const previewLp = ctx.createBiquadFilter();
    previewLp.type = 'lowpass';
    previewLp.frequency.value = 1600;
    this.previewGain = ctx.createGain();
    this.previewGain.gain.value = 0;
    this.previewOsc.connect(previewLp).connect(this.previewGain).connect(tone);
    this.previewOsc.start();
    vib.start();

    this.applySettings();

    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule(ksProcessorUrl);
        this.worklet = new AudioWorkletNode(ctx, 'ks-pluck', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.worklet.connect(this.voices);
        this.usingWorklet = true;
      } catch (err) {
        console.warn('[audio] AudioWorklet unavailable, using buffer fallback', err);
      }
    }
    this.ready = true;
    console.info(`[audio] ready · ${ctx.sampleRate} Hz · ${this.usingWorklet ? 'AudioWorklet' : 'fallback'} synth`);
  }

  applySettings(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const mix = settings.reverbMix;
    // Equal-power crossfade between dry and wet.
    this.dry.gain.setTargetAtTime(Math.cos((mix * Math.PI) / 2), t, 0.05);
    this.wet.gain.setTargetAtTime(Math.sin((mix * Math.PI) / 2) * 1.4, t, 0.05);
    this.bus.gain.setTargetAtTime(settings.volume, t, 0.05);
  }

  pluck(o: PluckOptions): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const flick = !!o.flick;
    // Harder plucks are brighter; flicks are brightest.
    const bright = flick ? 1 : 0.25 + 0.6 * o.velocity;
    const when = ctx.currentTime + (o.delay ?? 0);
    if (this.worklet) {
      this.worklet.port.postMessage({
        type: 'pluck',
        id: o.id,
        freq: o.freq,
        vel: o.velocity,
        bright,
        pos: o.position,
        t60: o.decay,
        pan: o.pan,
        flick,
        when,
      });
    } else {
      this.fallbackPluck(o.freq, o.velocity, bright, o.position, o.decay, o.pan, flick, when);
    }
  }

  /** Percussive "snap" for breaking a string. */
  snap(pan: number): void {
    this.pluck({ id: -1, freq: 1400, velocity: 0.9, position: 0.1, pan, decay: 0.25, flick: true });
    this.pluck({ id: -2, freq: 97, velocity: 0.5, position: 0.2, pan, decay: 0.6 });
  }

  /** Call every frame while drawing. Slides (portamento) between quantized notes. */
  preview(active: boolean, freq: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready) return;
    const t = ctx.currentTime;
    if (active) {
      if (!this.previewOn) {
        this.previewOn = true;
        this.previewOsc.frequency.cancelScheduledValues(t);
        this.previewOsc.frequency.setValueAtTime(freq, t);
        this.previewGain.gain.cancelScheduledValues(t);
        this.previewGain.gain.setTargetAtTime(0.045, t, 0.06);
      } else if (freq !== this.previewFreq) {
        this.previewOsc.frequency.setTargetAtTime(freq, t, 0.035);
      }
      this.previewFreq = freq;
    } else if (this.previewOn) {
      this.previewOn = false;
      this.previewGain.gain.cancelScheduledValues(t);
      this.previewGain.gain.setTargetAtTime(0, t, 0.08);
    }
  }

  /** Synthetic stereo hall impulse: exponentially decaying noise that darkens over time. */
  private makeImpulse(seconds: number, t60: number): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const len = Math.floor(seconds * sr);
    const buf = ctx.createBuffer(2, len, sr);
    const predelay = Math.floor(0.012 * sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = predelay; i < len; i++) {
        const t = (i - predelay) / sr;
        const env = Math.pow(10, (-3 * t) / t60);
        // Low-pass cutoff falls over time → high frequencies die first, like a real room.
        const k = 0.9 - 0.75 * Math.min(1, t / seconds);
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * env;
      }
    }
    return buf;
  }

  /**
   * Fallback for browsers without AudioWorklet: the same Karplus–Strong loop
   * (noise burst through a tuned feedback delay + low-pass filter), computed
   * up front into an AudioBuffer. A live DelayNode loop can't be used because
   * Web Audio forces ≥128-sample delay in feedback cycles, capping pitch at
   * ~375 Hz.
   */
  private fallbackPluck(
    freq: number,
    vel: number,
    bright: number,
    pos: number,
    t60: number,
    pan: number,
    flick: boolean,
    when: number,
  ): void {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const dur = Math.min(6, t60 * 1.1);
    const len = Math.floor(dur * sr);
    const buffer = ctx.createBuffer(1, len, sr);
    const out = buffer.getChannelData(0);

    const { N, C, S, g } = ksDesign(freq, t60, sr);
    const size = N + 1;
    const line = new Float32Array(size);

    // Excitation: one period, triangle pluck shape + noise, low-passed by brightness
    const peakIdx = Math.max(1, Math.min(N - 2, pos * N));
    const noiseMix = 0.25 + 0.5 * bright;
    const lpk = 0.08 + 0.9 * Math.pow(bright, 1.5);
    let y1 = 0;
    let peak = 1e-6;
    for (let k = 0; k < N; k++) {
      const tri = k < peakIdx ? k / peakIdx : (N - k) / (N - peakIdx);
      y1 += lpk * (tri * (1 - noiseMix) + (Math.random() * 2 - 1) * noiseMix - y1);
      line[k] = y1;
      peak = Math.max(peak, Math.abs(y1));
    }
    let mean = 0;
    for (let k = 0; k < N; k++) mean += line[k];
    mean /= N;
    const amp = (0.38 * Math.pow(vel, 1.2)) / peak;
    for (let k = 0; k < N; k++) line[k] = (line[k] - mean) * amp;

    // Loop: delay N → allpass (fractional delay) → one-zero low-pass × g → write back.
    let w = N;
    let apX = 0;
    let apY = 0;
    let prev = 0;
    let click = flick ? 0.22 * vel : 0;
    const clickDecay = Math.exp(-1 / (0.004 * sr));
    for (let i = 0; i < len; i++) {
      let ri = w - N;
      if (ri < 0) ri += size;
      const x = line[ri];
      const a = C * x + apX - C * apY;
      apX = x;
      apY = a;
      const f = g * ((1 - S) * a + S * prev);
      prev = a;
      line[w] = f;
      if (++w >= size) w = 0;
      out[i] = f + (click > 1e-4 ? (Math.random() * 2 - 1) * click : 0);
      click *= clickDecay;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(p).connect(this.voices);
    } else {
      src.connect(this.voices);
    }
    src.start(when);
  }
}
