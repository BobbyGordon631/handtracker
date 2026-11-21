# Air Harp

Draw glowing strings of light in midair with your hands, then play them like a harp. Your webcam tracks your hands. A string's length sets its pitch: shorter strings play higher notes.

It runs in the browser using MediaPipe hand tracking, Three.js with bloom for the visuals, and a Karplus–Strong plucked-string synth in an AudioWorklet. Nothing is uploaded: the video stays on your machine.

## Run it

```bash
npm install
npm run dev        # opens http://localhost:5173
```

Click **Tap to begin** and allow camera access. The camera only works in a secure context, which means `localhost` or `https://`.

It's built for Chrome and Safari on M-series Macs. The hand model (about 7.5 MB) loads from Google's CDN the first time you open the page.

## Gesture cheat sheet

| Do this | Result |
| --- | --- |
| **Pinch** (thumb + index) **with both hands**, pull apart, release either one | Places a string between your hands |
| **Pinch with one hand**, drag, release | Places a string from where you pinched to where you let go |
| While drawing | A see-through draft string follows your hands. Its note shows above it, and a soft preview tone slides between notes |
| **Swipe your index finger** through a string | Plucks it. Faster swipes are louder and brighter |
| **Sweep across several strings** | Strums them, in the order your finger crossed them |
| **Flick** fast through or just past a string | Sparks race along it and spray off the ends, with a sharper pluck |
| **Pinch a string's middle** and pull it away | The string snaps and is deleted. Let go early and it springs back and rings |
| **Hold an open palm still** for 1.5 s | Clears every string. A ring around your palm fills up as you hold |
| `C` / `Z` / `H` | Clear all / undo the last string / show or hide settings |

You can have up to 16 strings. Drawing a 17th fades out the oldest one.

## How pitch works

Real strings follow Mersenne's law: at fixed tension, frequency is inversely proportional to length.

```
f = f_ref · (L_ref / L)
```

`L_ref` is 60% of the screen diagonal, and a string that long plays the lowest note of the range (C3 by default). Halving the length raises the pitch an octave. On a 1470×956 MacBook screen, that means:

| Length | Note |
| --- | --- |
| ~1050 px | C3 |
| ~525 px | C4 |
| ~260 px | C5 |
| ~130 px | C6 |

Strings longer or shorter than that range are clamped to its ends. Every pitch is then snapped to the nearest note of the selected scale, so any string you draw is in key. Each placed string logs its length and note to the browser console.

## Settings (`H`)

| Folder | Settings |
| --- | --- |
| Music | Scale (pentatonic major/minor, major, minor, chromatic, Japanese in-sen), root note, lowest octave, octave range |
| Sound | Volume, reverb mix, string decay time (the visual vibration fades on the same curve) |
| Look | Bloom strength and radius, camera brightness |
| Tracking | Pinch threshold, One Euro filter `minCutoff` and `beta`, flick speed, pluck with all fingers, debug view (21 landmarks per hand plus FPS) |

### Tuning tracking

If tracking feels off, these are the settings to adjust:

- **Jittery when your hands are still:** lower `1€ minCutoff`, for example to 0.6.
- **Laggy when you move fast:** raise `1€ beta`, for example to 0.03.
- **Pinches don't register:** raise `pinch threshold`.
- **Pinches trigger by accident:** lower `pinch threshold`.
- **Watch the raw numbers:** turn on the debug view. It shows the smoothed landmarks over the raw ones, plus each hand's pinch ratio and fingertip speed.

## Deploy

```bash
npm run build      # outputs static files to dist/
```

`dist/` is a plain static site with relative paths, so any static host works:

- **Vercel:** `npx vercel` (framework: Vite, output: `dist`)
- **Netlify:** `npx netlify deploy --prod --dir=dist`, or drag `dist/` onto app.netlify.com/drop
- **GitHub Pages / Cloudflare Pages / S3:** upload `dist/`

These hosts all serve over HTTPS, which the camera requires.

## Code map

| File | What it does |
| --- | --- |
| `src/tracking.ts` | Webcam, MediaPipe HandLandmarker, One Euro smoothing, mirrored cover-fit mapping to screen pixels, hand identity, and a ~170 ms grace period for dropped frames |
| `src/gestures.ts` | Pinch with hysteresis, fingertip velocity, open-palm hold (thresholds are commented at the top) |
| `src/interaction.ts` | The draw / grab / pluck / flick / clear state machine |
| `src/strings.ts` | String model, standing-wave vibration, segment-intersection crossing tests |
| `src/music.ts` | Length → pitch math, scales, quantization |
| `src/audio.ts` + `src/ks-processor.js` | Karplus–Strong synth (AudioWorklet with a buffer fallback), reverb, limiter, preview tone |
| `src/particles.ts` | Pooled spark particles that ride strings or fly free |
| `src/render.ts` | Three.js orthographic scene, ribbon strings, bloom, webcam composite |
| `src/main.ts` | Wiring, main loop, debug overlay, keyboard |

In dev builds, the console exposes `airHarp` for testing without hands. For example, `airHarp.addString(300, 200, 900, 600)` places a string and `airHarp.pluck(0, 1, true)` flick-plucks it.
