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
| **Pinch with one hand**, drag, release | Places a string from where you pinched to where you let go. Your other hand can join in to make it a two-hand string, but only in the first ~0.6 s; after that it can't pull the string away from you |
| While drawing | A see-through draft string follows your hands. Its note shows above it, and a soft preview tone slides between notes |
| **Swipe your index finger** through a string | Plucks it. Faster swipes are louder and brighter |
| **Sweep across several strings** | Strums them, in the order your finger crossed them |
| **Flick** fast through or just past a string | Sparks race along it and spray off the ends, with a sharper pluck |
| **Pinch on a string** (anywhere along its middle) and pull it away | As your fingers close on a string it lights up and your fingertip dots turn red, so you know the pinch will grab it rather than draw. Pull it and it heats toward white and trembles, then snaps and is deleted. Let go early and it swings back from where you held it and rings |
| Move or strum fast | A pinch that closes while your hand is moving fast is ignored, so strumming and waving around don't start strings or grab them by accident. Pinch with your hand still (or slow) to draw or grab |
| **Cross your fingers** (index over middle) and hold for 1 s | Clears every string. A ring around your hand fills up as you hold. Either hand, palm or back facing the camera |
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

Strings longer or shorter than that range are clamped to its ends. Every pitch is then snapped to the nearest note of the selected scale, so any string you draw is in key. Each placed string logs its length and note to the browser console. The default scale is **C major**, so every natural note (C D E F G A B) can come up; the pentatonic scales leave out two of them (F and B in C pentatonic major). Pick *Chromatic* in settings to get the sharps too.

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
- **Laggy when you move fast:** raise `1€ beta`, for example to 0.04.
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
| `src/tracking.ts` | Webcam, MediaPipe HandLandmarker, whole-hand One Euro smoothing, render-rate prediction between camera frames, glitch / duplicate / phantom-hand rejection, mirrored cover-fit mapping to screen pixels, hand identity, and a grace period for dropped frames (longer while pinching) |
| `src/gestures.ts` | Pinch (3D, with hysteresis, confirmation frames and a fast-motion gate), fingertip velocity, fingers-crossed hold (thresholds are commented at the top) |
| `src/interaction.ts` | The draw / grab / pluck / flick / clear state machine, plus the grab highlight |
| `src/strings.ts` | String model, standing-wave vibration, segment-intersection crossing tests |
| `src/music.ts` | Length → pitch math, scales, quantization |
| `src/audio.ts` + `src/ks-processor.js` | Karplus–Strong synth (AudioWorklet with a buffer fallback), reverb, limiter, preview tone |
| `src/particles.ts` | Pooled spark particles that ride strings or fly free |
| `src/render.ts` | Three.js orthographic scene, ribbon strings, bloom, webcam composite |
| `src/main.ts` | Wiring, main loop, debug overlay, keyboard |

In dev builds, the console exposes `airHarp` for testing without hands. For example, `airHarp.addString(300, 200, 900, 600)` places a string and `airHarp.pluck(0, 1, true)` flick-plucks it.

### Live site

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds the app and publishes it with GitHub Pages. This is a project repo under the `BobbyGordon631` account, whose Pages site uses the custom domain kksolve.com, so it's served at **https://kksolve.com/handtracker/**.
