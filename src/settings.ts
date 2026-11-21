import GUI from 'lil-gui';

/** Scale intervals in semitones above the root. */
export const SCALES: Record<string, readonly number[]> = {
  'Pentatonic major': [0, 2, 4, 7, 9],
  'Pentatonic minor': [0, 3, 5, 7, 10],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'Japanese in-sen': [0, 1, 5, 7, 10],
};

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Live, mutable settings. Modules read from this every frame, so GUI changes apply instantly. */
export const settings = {
  // Music
  scale: 'Pentatonic major',
  root: 'C' as string,
  lowOctave: 3, // lowest note = root in this octave (C3)
  octaves: 3, // range span → C3..C6

  // Sound
  volume: 0.8,
  reverbMix: 0.35,
  decay: 3.5, // seconds until a string has faded by 60 dB (T60)

  // Look
  bloomStrength: 1.35,
  bloomRadius: 0.55,
  cameraBrightness: 0.25,

  // Tracking / gestures
  pinchThreshold: 0.32, // thumb–index distance ÷ hand size to START a pinch (release at ×1.45)
  minCutoff: 1.2, // One Euro: Hz. Lower = smoother when still, but laggier.
  beta: 0.012, // One Euro: speed coefficient. Higher = less lag on fast moves.
  flickSpeed: 2.6, // fingertip speed (screen diagonals / s) that counts as a flick
  pluckAllFingers: false,

  debug: false,
};

export type Settings = typeof settings;

export interface GuiHooks {
  onMusicChange(): void;
  onSoundChange(): void;
  onLookChange(): void;
  onDebugChange(): void;
}

export function createGui(h: GuiHooks): GUI {
  const gui = new GUI({ title: 'Air Harp · settings (H)' });

  const music = gui.addFolder('Music');
  music.add(settings, 'scale', Object.keys(SCALES)).onChange(h.onMusicChange);
  music.add(settings, 'root', [...NOTE_NAMES]).name('root note').onChange(h.onMusicChange);
  music.add(settings, 'lowOctave', 1, 5, 1).name('lowest octave').onChange(h.onMusicChange);
  music.add(settings, 'octaves', 1, 4, 1).name('octave range').onChange(h.onMusicChange);

  const sound = gui.addFolder('Sound');
  sound.add(settings, 'volume', 0, 1, 0.01).onChange(h.onSoundChange);
  sound.add(settings, 'reverbMix', 0, 1, 0.01).name('reverb mix').onChange(h.onSoundChange);
  // Decay also changes the visual vibration envelope, so it retunes the strings.
  sound.add(settings, 'decay', 0.5, 8, 0.1).name('string decay (s)').onChange(h.onMusicChange);

  const look = gui.addFolder('Look');
  look.add(settings, 'bloomStrength', 0, 3, 0.01).name('bloom strength').onChange(h.onLookChange);
  look.add(settings, 'bloomRadius', 0, 1, 0.01).name('bloom radius').onChange(h.onLookChange);
  look.add(settings, 'cameraBrightness', 0, 1, 0.01).name('camera brightness').onChange(h.onLookChange);

  const track = gui.addFolder('Tracking');
  track.add(settings, 'pinchThreshold', 0.12, 0.6, 0.01).name('pinch threshold');
  track.add(settings, 'minCutoff', 0.05, 5, 0.01).name('1€ minCutoff');
  track.add(settings, 'beta', 0, 0.1, 0.001).name('1€ beta');
  track.add(settings, 'flickSpeed', 0.8, 6, 0.1).name('flick speed');
  track.add(settings, 'pluckAllFingers').name('pluck with all fingers');
  track.add(settings, 'debug').name('show debug landmarks').onChange(h.onDebugChange);

  gui.hide();
  return gui;
}
