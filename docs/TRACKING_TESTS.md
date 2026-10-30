# Tracking test procedure

Repeatable checks for image tracking and planar alignment, on real phones and
in the automated simulator.

## Real devices (Android Chrome, iPhone Safari)

Open the experience with the debug overlay and the alignment wireframe:

```
https://web-ar-studio-lovat.vercel.app/ar/<id>?debug&wire=1
```

- The **green wireframe** is the exact target rectangle (with one diagonal) on
  the tracked anchor. If it sits on the printed edges, MindAR's pose is right.
  If the wireframe is right but the content is not, the problem is in the
  content placement.
- Debug lines:
  - `tracker / view fps, delay`
  - `wobble` (still) and `jerk` (moving)
  - `match avg% min% n` (template points matched, of those that should be visible)
  - `fov … (measured …)` (camera calibration)
  - `TRACKING / LOST / DETECTING`, anchor `pos`/`rot`, and the last state changes

Print the target (matte paper, flat, even light). Hold the phone **upright
(portrait)** for one pass and **sideways** for a second pass. For each row,
record *stable*, *wireframe on edges*, *drift*, *jitter* and *recovery*:

| # | Test | How |
|---|------|-----|
| 1 | Front-facing | Phone parallel to the print, ~40 cm |
| 2 | 15° | Tilt the phone ~15° left/right and up/down |
| 3 | 30° | Same, ~30° |
| 4 | 45° | Same, ~45°. In the first seconds the camera calibrates: \`fov … (measured …)\` appears and is applied once |
| 5 | 60° | Same, ~60° (MindAR's practical limit; lock may drop) |
| 6 | Distances | 20 cm (close-up / one corner) → 1 m |
| 7 | Slow movement | Slow arc around the print |
| 8 | Fast movement | Quick pans; content may hide briefly but must never sit off the print |
| 9 | Occlusion | Cover part of the print with a hand for 2 s |
| 10 | Loss / reacquisition | Point away for 3 s, come back; the wireframe must re-lock on the edges |

Expected: the wireframe stays on the printed edges (within a few px) in 1–7 and
9. In 8 and 10, the content hides rather than showing at a wrong position, and
re-locks in about 1 s.

## Automated (headless Chrome, simulated cameras)

The scripts live in the session scratchpad (`e2e/`). They use Chrome's fake
camera with generated `.y4m` feeds:

- Pinhole camera with a known field of view at ~45° (`gen-pinhole.cjs`).
- Slow approach (`gen-approach.cjs`).
- Phone rotation (`gen-rotfeed.cjs`), corner tour, steep angle, handheld noise, fast pan.

Main metrics:

- `edge-gap.mjs`: average gap in px between the magenta test overlay
  (\`aligntest\` experience) and the printed edges.
- `lag-test.mjs`: misalignment during fast motion.
- `partial.mjs`: share of time locked.
- `stability.mjs`: wobble when still, re-lock time.
- `gallery-test.mjs`: correct artwork per frame.

Debug-only switches for A/B tests:

| Switch | Effect |
|---|---|
| \`fov=<deg>\` | Fixed camera FOV (0 = MindAR default) |
| \`stall=1\` | Pauses the tracker 0.6 s every 3 s |
| \`staleHide=0\` | Old freeze-last-pose behaviour |
| \`noise=<deg>\` | Injects tracker noise |
| \`fit=0\` | Causal smoothing only |
| \`gyro=1\` | Experimental gyroscope fusion |
| \`minTrack=<0..1>\` | Anti-drift gate threshold |
| \`drift=1\` | Knocks the pose off every 3 s |

Latest results (simulated, see README "Tracking behaviour"):

- Edge gap at ~45°:
  - 0.8 px auto-calibrated
  - 10.5 px with MindAR's default lens model
  - 0.0 px head-on
- Tracker stalls: 0 doubled-image frames (content hides) vs 3 with the old freeze.
- Locked share: corners 96%, steep angle 98%, handheld 98%.
