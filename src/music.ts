import { NOTE_NAMES, SCALES, settings } from './settings';

// ─────────────────────────────────────────────────────────────────────────────
// Pitch math
//
// An ideal string under fixed tension and density obeys Mersenne's law: its
// fundamental frequency is inversely proportional to its vibrating length.
//
//     f = f_ref · (L_ref / L)
//
// We pick the reference so that a string L_ref long plays the LOWEST note of the
// selected range (default C3). L_ref is a fraction of the screen diagonal, so the
// instrument feels the same on any display size. Halving the length raises the
// pitch an octave, so a 3-octave range spans lengths L_ref … L_ref/8:
//
//     MacBook 1470×956 px → diagonal ≈ 1754 px → L_ref ≈ 1050 px (C3)
//                                              → L_ref/8 ≈ 131 px (C6)
//
// Lengths outside that window are clamped to the range ends, then the frequency
// is snapped to the nearest note of the chosen scale so everything is in key.
// ─────────────────────────────────────────────────────────────────────────────

/** Fraction of the screen diagonal at which a string plays the lowest note in the range. */
export const REF_LENGTH_OF_DIAGONAL = 0.6;

export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f: number): number => 69 + 12 * Math.log2(f / 440);

// Precomputed so the per-frame draft label doesn't allocate strings.
const MIDI_NAMES: string[] = [];
for (let m = 0; m < 128; m++) MIDI_NAMES.push(NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1));
export const midiToName = (m: number): string => MIDI_NAMES[Math.max(0, Math.min(127, m))];

let scaleNotes: number[] = [];
let lowMidi = 48;
let highMidi = 84;

/** Rebuild the allowed-note table from the current settings. Call after any music setting changes. */
export function refreshScale(): void {
  const root = Math.max(0, NOTE_NAMES.indexOf(settings.root as (typeof NOTE_NAMES)[number]));
  lowMidi = 12 * (settings.lowOctave + 1) + root; // MIDI 60 = C4, so C3 = 48
  highMidi = lowMidi + 12 * settings.octaves;
  const intervals = SCALES[settings.scale] ?? SCALES['Pentatonic major'];
  scaleNotes = [];
  for (let m = lowMidi; m <= highMidi; m++) {
    if (intervals.includes((m - lowMidi) % 12)) scaleNotes.push(m);
  }
}
refreshScale();

export const getRange = () => ({ lowMidi, highMidi, notes: scaleNotes });

export interface Pitch {
  /** Unquantized (but clamped) frequency from the length formula. */
  rawFreq: number;
  /** Quantized MIDI note. */
  midi: number;
  /** Quantized frequency in Hz. */
  freq: number;
  name: string;
  /** 0 = lowest note of range, 1 = highest (drives colour + visual vibration speed). */
  t: number;
}

export const makePitch = (): Pitch => ({ rawFreq: 0, midi: 0, freq: 0, name: '', t: 0 });

/**
 * How much closer (in semitones) a neighbouring note must be before we leave the
 * `prefer` note. Stops the draft's note flickering between two neighbours when
 * the hand hovers at the boundary, and makes the placed string keep the note
 * the draft was showing.
 */
const NOTE_HYSTERESIS = 0.3;

/**
 * Length (px) → quantized pitch. Writes into `out` (no allocation). If `prefer`
 * is a note of the current scale, it's kept unless another note is clearly closer.
 */
export function lengthToPitch(lengthPx: number, diagPx: number, out: Pitch, prefer = -1): Pitch {
  const lRef = REF_LENGTH_OF_DIAGONAL * diagPx;
  const fRef = midiToFreq(lowMidi);
  const fMax = midiToFreq(highMidi);

  // f = f_ref · L_ref / L, clamped to the playable range.
  let f = fRef * (lRef / Math.max(lengthPx, 1));
  f = Math.min(fMax, Math.max(fRef, f));

  // Snap to the nearest scale degree (in semitone space, so "nearest" is perceptual).
  const mFloat = freqToMidi(f);
  let best = scaleNotes[0];
  let bestD = Infinity;
  for (let i = 0; i < scaleNotes.length; i++) {
    const d = Math.abs(scaleNotes[i] - mFloat);
    if (d < bestD) {
      bestD = d;
      best = scaleNotes[i];
    }
  }
  if (prefer !== best && scaleNotes.includes(prefer) && Math.abs(prefer - mFloat) < bestD + NOTE_HYSTERESIS) {
    best = prefer;
  }

  out.rawFreq = f;
  out.midi = best;
  out.freq = midiToFreq(best);
  out.name = midiToName(best);
  out.t = highMidi > lowMidi ? (best - lowMidi) / (highMidi - lowMidi) : 0;
  return out;
}

/** Inverse of the formula: the length that would play exactly `midi` (unquantized). */
export function pitchToLength(midi: number, diagPx: number): number {
  return (REF_LENGTH_OF_DIAGONAL * diagPx * midiToFreq(lowMidi)) / midiToFreq(midi);
}

/**
 * Effective T60 (s) for a string: the base decay setting, a little shorter for
 * high notes and longer for low ones, like a real harp. Shared by the audio
 * engine and the vibration visuals so sight and sound fade together.
 */
export function stringDecay(freq: number): number {
  const k = Math.pow(220 / freq, 0.25);
  return settings.decay * Math.min(1.3, Math.max(0.6, k));
}
