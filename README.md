# WebAR Studio

Create **image-tracked WebAR experiences** and share them with a **QR code**, with no app install. An admin uploads a poster, product or packaging image, attaches a video, image or 3D model, and gets a QR code. Visitors scan it and see the content anchored to the real printed image through their phone's camera.

The flow reproduces the reference video (`WhatsApp Video 2026-10-28 at 1.53.18 PM.mp4`):

| Reference video | This app |
| --- | --- |
| QR code printed on the poster | Per-experience QR code (PNG download) containing the real public URL |
| Branded web page with logo, "AR EXPERIENCE" tagline and a red **PRELOADING** bar | `/ar/:id` splash: brand header, hero image, real byte-level preloading progress |
| Camera view with a slim brand header | Full-screen camera with brand header and guidance (no scan frame: any part of the image is recognised) |
| Animated video overlay locked onto the poster | Video/image/GLB anchored to the tracked target (MindAR) |
| Pulsing red dots on the product; tapping reveals labels ("STRONG SHOULDER") | Configurable hotspots: tap a dot to show its label, anchored on the target |

## Tech stack

- **React 19 + Vite 7**, React Router 7, CSS Modules plus a small global design system
- **three.js r186** for rendering
- **MindAR 1.2.5** image tracking (`Controller` + `Compiler`). This is real feature-based tracking that runs in the browser with TensorFlow.js. Nothing is simulated.
- **qrcode.react** for QR generation
- **Node + Express 5 + Multer** for the API, storage of uploads, and serving the built app

> Vite 7 is used rather than Vite 8 because npm 10.8 (bundled with Node 20.19) crashes resolving Vite 8's peer set (`Cannot read properties of null (reading 'edgesOut')`). On npm ≥ 11 you can upgrade.

## Quick start

Requirements: Node.js **≥ 20.19**.

```bash
npm install
cp .env.example .env        # optional for local dev
npm run dev                 # API on :8787 + Vite on :5173 (proxied)
```

Open <http://localhost:5173/admin>, create an experience, and use **Open** in the QR panel. On a desktop with a webcam, hold a printed copy, or a phone showing the target image, up to the camera.

| Script | What it does |
| --- | --- |
| `npm run dev` | API (`node --watch`) + Vite dev server with `/api` and `/uploads` proxied |
| `npm run build` | Production build into `dist/` |
| `npm start` | Production server: API, uploads and the built SPA on `PORT` |
| `npm run preview` | Vite preview of `dist/` (needs the API running separately) |

### Testing on a phone during development

Mobile browsers only allow the camera on **HTTPS**, and QR codes must point to an address the phone can reach.

**Option A: LAN with a self-signed certificate**
```bash
# .env
VITE_DEV_HTTPS=true
VITE_PUBLIC_APP_URL=https://<your-computer-LAN-IP>:5173
```
Run `npm run dev`, then scan the QR code. The phone will warn about the certificate once; accept it.

**Option B: HTTPS tunnel** (recommended, since it needs no certificate warnings)
```bash
cloudflared tunnel --url http://localhost:5173     # or: ngrok http 5173
# .env → VITE_PUBLIC_APP_URL=https://<tunnel-host>
```
Vite may need the tunnel host allowed: add `server.allowedHosts: ['<tunnel-host>']` in `vite.config.js`.

The admin sidebar and QR panel show whether the QR base URL is **Public HTTPS**, **LAN**, **Local only** or **Not HTTPS**, so you never print a QR code that can't work.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `VITE_PUBLIC_APP_URL` | frontend (build time) | Public **HTTPS** base URL encoded into QR codes, e.g. `https://ar.example.com`. If empty, the current browser origin is used and the admin flags it. |
| `VITE_API_BASE_URL` | frontend (build time) | API origin if it differs from the frontend origin. Leave empty when `npm start` serves both (recommended). |
| `VITE_DEV_HTTPS` | dev server | `true` serves Vite over HTTPS with a self-signed certificate for LAN phone testing. |
| `PORT` | server | API/app port (default `8787`). In dev, Vite proxies to it. |
| `ADMIN_TOKEN` | server | Shared secret for all admin operations. **Required in production**: with `NODE_ENV=production` and no token, admin endpoints return 503. In development, empty means the admin API is open. |
| `DATA_DIR` | server | Where `experiences.json` and uploads are stored (default `./server/data`). Must be persistent storage in production. |
| `CORS_ORIGINS` | server | Comma-separated origins allowed to call `/api` cross-origin (only with `VITE_API_BASE_URL`). |
| `MAX_UPLOAD_MB` | server | Max size per uploaded file (default `60`). |

`VITE_*` values are compiled into the bundle, so **rebuild after changing them**.

## Deployment

### Vercel (static, read-only showcase): https://web-ar-studio-lovat.vercel.app

Vercel cannot run the Express upload server: it has no persistent disk and no long-running process. So the Vercel site is a **read-only showcase** of published experiences:

1. Create or edit experiences locally (`npm run dev`).
2. Run `npm run export:static`. This copies every **published** experience and its files into `public/static-data/` and `public/uploads/`.
3. Commit and push. Vercel builds with `npm run build` and serves everything statically.

On Vercel (`VERCEL=1` at build time) the app reads `/static-data` instead of `/api`. The AR pages and QR codes work fully; the admin is browse-only. `vercel.json` rewrites every app route to `index.html`, so refreshing or opening deep links (`/admin/...`, `/ar/:id`, QR links) works. `.env.production` sets `VITE_PUBLIC_APP_URL` to the Vercel domain so QR codes point there.

To create and edit experiences online, deploy the Node server instead (below), or move storage to a hosted backend (e.g. Supabase/S3 plus a database).

### Node server

Any Node host with persistent disk and HTTPS works (a VPS behind Caddy/Nginx, Render, Railway or Fly.io with a volume, etc.):

```bash
npm ci
VITE_PUBLIC_APP_URL=https://ar.example.com npm run build
NODE_ENV=production ADMIN_TOKEN=<long-random-secret> DATA_DIR=/var/lib/webar PORT=8787 npm start
```

- Terminate **HTTPS** at your proxy or platform. The camera does not work on plain HTTP.
- Mount `DATA_DIR` on a persistent volume, or uploads are lost on redeploy.
- Purely static/serverless hosts (Vercel, Netlify static) cannot run the upload server as-is. See *Production recommendations*.
- `/uploads/*` files have unique names and are served `immutable` (1 year), with `Access-Control-Allow-Origin: *` (needed for WebGL textures) and a sandboxing CSP. Range requests are supported for video.

## How it works

### Routes

| Route | Purpose |
| --- | --- |
| `/admin` | Dashboard: stats, experience cards, empty/loading/error states |
| `/admin/experiences/new` | Create experience |
| `/admin/experiences/:id` | Edit, QR code, publish/unpublish, delete |
| `/ar/:id` | Public QR landing page and AR session |
| `/gallery` | **Gallery**: one link / QR code that recognises every published artwork (`?ids=a,b,c` picks and orders them) |

### Gallery: one QR code for many artworks

Like Kivicube's collections, the dashboard shows a **Gallery QR code** once two or more experiences are published. Visitors scan it once and can then walk from artwork to artwork: whichever artwork is in the camera shows its own content (video, image or 3D, with its hotspots), and the header switches to that artwork's brand.

- The compiled targets of all published experiences are merged in the browser into one tracking file (`src/ar/mergeTargets.js`; a `.mind` file is msgpack `{ v, dataList }`, one entry per image). Nothing has to be recompiled when an experience is added.
- One image is tracked at a time. The session reports which image it follows (`targetIndex`) and which image the frame on screen belongs to (`displayTarget`); only that artwork's content is visible.
- All content is preloaded before **Start AR**, so switching artworks is instant. Detection time grows slightly with the number of artworks; keep a gallery to a few dozen images.
- Public endpoint: `GET /api/public/experiences` (published only). On Vercel the static `index.json` is used.

### Target compilation (required by MindAR)

MindAR **cannot track a raw image**. It needs a compiled `.mind` file containing feature descriptors (for detection) and tracking templates. When the admin selects a target image:

1. The image is validated (JPG/PNG/WebP, ≤ 15 MB, shortest side ≥ 300 px) and downscaled to at most 1024 px (faster compile, and no loss: MindAR tracks on a 256 px pyramid).
2. MindAR's own `Compiler` runs **in the admin's browser** (TensorFlow.js + a web worker). It takes about 3–5 s.
3. The result is graded (**Good / Fair / Poor**) from the number of feature and tracking points plus image contrast and aspect ratio. Detected tracking points are drawn over the image, and warnings explain how to improve a weak target.
4. The image **and** its `.mind` file are uploaded together and stored with the experience. The server refuses a new target image without its compiled data.

### AR session (`src/ar/ImageTrackingSession.js`)

The app uses MindAR's low-level **`Controller`** (the actual tracking engine) with its own three.js renderer, instead of the `MindARThree` helper. The helper imports `sRGBEncoding`, which was removed in three r162. It also injects its own UI into `<body>`, swallows camera errors, and never removes its resize listener. The session:

- requests the camera **only after the user taps Start AR**, with specific messages for denied permission, no camera, camera in use, insecure context, in-app browsers, and missing WebGL
- matches the three.js camera projection to MindAR's, and fits the video to cover the screen
- anchors content in target space (1 unit = target width, origin at the centre, +Z out of the image)
- reports found/lost events. On loss, content hides, video pauses, and the UI says "Move your camera over the target image".
- rebuilds the tracker if the camera stream dimensions change (device rotation)
- allows **one session at a time** (a module-level lock)
- **cleans up fully** on stop or unmount: camera tracks stopped, tracking loop drained before the worker is disposed and terminated, WebGL context released, textures/geometries/videos disposed, listeners removed

### Tracking behaviour

- **Smooth view, content fixed to the print (delayed, frame-exact display).** Every camera frame is snapshotted once, in its `requestVideoFrameCallback`. The same snapshot feeds the tracker (downscaled) and a 12-frame GPU ring buffer. The view plays the ring back at camera frame rate, delayed by just enough that the tracker has analysed a frame at or after the one on screen (adaptive: about 70 ms on a fast device, about 200 ms on a heavily loaded one). Each displayed frame gets its pose **interpolated** between the tracked frames around it, so content is never ahead of or behind the image. Fast whip-pan misalignment: **mean 3.5 px** (tracker at about 24 fps) and **6.5 px, median 1 px** (about 11 fps). For comparison, live video with pose prediction gave 8–44 px, and showing only tracker-analysed frames was aligned but choppy. Uploading the `<video>` straight to WebGL is avoided because it can deliver a different frame than the snapshot (measured 50–90 px of slip). Without `requestVideoFrameCallback` (or with `?debug&live=1`) the live video with pose prediction is used. The `?debug` overlay shows view fps and delay. On a device whose main thread is saturated by tracking, the view rate drops towards the tracker rate.
- **Tracker runs on camera frames, not screen refreshes.** MindAR waited for a screen refresh after every frame and could analyse the same camera frame twice. The loop now starts as soon as the camera delivers a new frame (`requestVideoFrameCallback`), with less wasted work and heat.
- **Instant appearance.** Content shows on the first confirmed tracking frame after recognition.
- **Faster tracking.** The tracker analyses a 960 px copy of the 720p camera frame (MindAR's projection is resolution-independent). This is about 45% less work than 720p and gave the best accuracy under fast motion in tests (vs 720 px and 1280 px).
- **Close-up tracking (Artivive-style).** The overlay stays locked when you walk up to the artwork and only part of it fills the screen:
  - *Tracker tuning* (Vite plugin `mindarTrackingTuning` in `vite.config.js`, MindAR pinned to 1.2.5). Tracking runs on the finer 256 px template level instead of 128 px, with a slightly wider search radius and a 512 px detection window.
  - *Higher-resolution targets*. Images are compiled at up to 2048 px so detection can re-find the target from a close-up. Result: **100% lock** through walk-in, close-up, pan and back-out.
  - Targets compiled before this change still work but should be re-uploaded (Admin → Replace target image).
- **Adaptive tracking level (main wobble fix).** Two trackers run on the same image: MindAR's default 128 px template level when the image is small in view, and the finer 256 px level when it is large (close-up), with hysteresis. Measured on a static, noisy, compressed camera feed at normal distance, always using 256 px (the previous close-up tuning) produced pose noise of p90 **42° / 31% of distance**. The adaptive version gives **6° / 0.26%**, and close-ups stay 100% locked.
- **Gyroscope fusion (self-calibrating).** `src/ar/GyroTracker.js` integrates the phone's `devicemotion` rotation rates. With it, poses are smoothed in a world frame where the artwork's orientation is constant, so rotation is averaged over about 0.45 s. The exact phone rotation from the gyroscope is applied back for each displayed frame. Camera tracking alone has to follow every turn of the phone and so lets its noise through. Devices and browsers differ in axes, signs, screen-orientation handling and sensor latency, so all 8 axis mappings × 7 latencies are integrated in parallel. Each is scored against what the image tracker sees (world-frame spread / camera-frame spread over the last second, in 0.2 s bins). The gyroscope is switched on only when a mapping agrees (score < 0.6; wrong data scored 0.81–0.91), and off again if agreement degrades (> 0.8). Otherwise tracking is camera-only, exactly as before. iOS asks for motion permission on the Start AR tap. Measured on a synthetic phone-rotation feed with matching gyroscope events and tracker noise injected (`?debug&noise=`): wobble while moving **3.2 → 2.6 px** (2° noise) and **4.1 → 3.0 px** (4°). Gyroscope data from the wrong moment was correctly rejected. The `?debug` overlay shows `gyro on/calibrating/off` plus the score; `&gyro=0` disables it.
- **Centred pose smoothing (main wobble fix).** Because the view is shown slightly delayed, tracker results from *after* each displayed frame are already known. Each frame’s pose is a weighted fit over the raw tracker poses before and after it (Gaussian window: 0.3 s when still, 0.07 s when moving fast). The fit is linear while moving, so it follows the motion without lag, and becomes a plain average when still. A causal smoother (the previous approach, still used for the live-video fallback and `?debug&fit=0`) has to follow fast motion and so lets its noise through. Measured with phone-like noise injected into the tracker (`?debug&noise=2`, about 2° per frame): wobble while moving **19 → 7 px** (raw 30–35 px); held still **8.9 → 4.1 px** (raw 12 px). Fast-pan alignment is unchanged (mean about 4 px). The `?debug` overlay shows `jerk`, the wobble while moving.
- **Missed frames.** If the tracker misses a frame (fast motion), prediction continues from the last real measurement instead of freezing the content.
- **Recognition from any part of the image (no scan frame).** You don't need to frame the whole image: a close-up of one corner is enough, and only the content in that part shows (and animates). MindAR's matcher votes for where the image centre lands, but it only accepted votes within ±1.2 frame sizes of the frame's *top-left* corner. Close-ups of the top-left and bottom-left of an image (centre beyond the right or bottom edge) were therefore never recognised. The build-time tuning patches this inside MindAR's web worker so the range extends two frame sizes past every edge. On a simulated corner-to-corner tour (about 40% of the poster in view, starting on a corner) the share of time locked rose from **28% to 82%**. The remaining gaps are fast pans between corners, re-found within about 2 s. A steep side angle (40–64°) stays **97% locked**.
- **Faster re-acquisition.** MindAR searches for the image in one square window per frame. The build-time tuning widens it from 256 px (centre only, 9 frames to cover) to 512 px (whole frame in 3 frames).
- **Seamless re-locks.** After the first lock, briefly losing and re-finding the image changes nothing in the UI: no repeated lock-on cue, no status chips. The "Point at the artwork" hint appears only after 1.5 s without the image.
- **Content only appears on the image.** If the image leaves the view, the content hides immediately and a small "Point at the artwork" hint shows (no scan screen). The tracker itself bridges up to 3 missed frames (motion blur). Content is never held or floated where the image isn't.
- **Lock-on cue.** Accent corner brackets snap onto the target when it is recognised.
- **Manual full screen.** The expand button shows the content full screen at any time; tap again to return to the AR view.
- **Diagnostics.** Add `?debug` to an AR link to show the tracker frame rate. For field tuning you can also add `&minCF=…&beta=…` (pose filter), `&proc=…` (analysis resolution) and `&stab=0` (disable pose stabilisation) and `&live=1` (live video with pose prediction instead of the delayed frame-exact view).

### Layered 3D scenes (artwork stays on the wall)

For the most convincing effect, don't cover the whole print with a flat video. Leave the real artwork visible through the camera and add **3D elements that come off it**, like Artivive. Upload a GLB as **3D model** and tick **"Scene is authored in target space"**:

- Units: 1 = image width, origin at the image centre, +X right, +Y up, +Z out of the wall. Nothing is auto-scaled, so the scene lines up with the print.
- Animation clips named `intro` play once when the image is first recognised (e.g. an element lifting off the wall). A clip named `loop` repeats. Other GLBs play their first clip.
- Unlit (`KHR_materials_unlit`) materials keep the artwork's exact colours. Use them for wall patches, glows and light effects. Lit (PBR) materials get studio lighting and filmic tone mapping.
- Hotspots accept an optional `z` (height above the image, in image widths), so markers can sit on 3D parts.
- **3D depth** (admin slider, `content.depth`, 5–100%) presses the model towards the wall. Seen from the front it looks the same, but anything standing out of the wall shifts against the print as the camera moves (parallax) and magnifies tracking noise in proportion to its height. At 25% the CEAT tyre tread stands about 0.055 image widths out instead of 0.22, so it moves 4× less against its printed spot and feels fixed in place. Hotspot `z` values are scaled with it.

The CEAT demo (`demo-assets/ceat/ceat-ar-scene.glb`) is built this way. It contains a feathered clean patch that hides the printed tyre, the same 3D tyre (PBR) lifting off the wall and spinning (shown at 25% depth), a contact shadow, a glow, and light streaks. It is about 54k triangles, 2.1 MB, and was validated with Blender's glTF importer.

### AR content

- **Video**: rendered as a `VideoTexture` plane. It starts muted (autoplay-safe) when the target is found. If the browser still blocks playback, a "Tap to play video" button appears, plus a mute/unmute toggle. *Match target* sizes it exactly over the target, like the reference overlay.
- **Image**: a plane (transparent PNG supported).
- **3D model**: `.glb`, or `.gltf` with embedded data. It is auto-normalised (largest side = 1 target width, centred on the target), its first embedded animation plays, and Draco/Meshopt compression is supported with self-hosted decoders. Studio environment lighting is applied.
- **Placement**: scale, X/Y/Z offset (in target widths) and X/Y/Z rotation, previewed live in a 3D preview in the admin that uses the same rendering code.
- **Hotspots**: click the target in the admin to add one, drag to move. In AR they are pulsing dots; tapping one (raycast) shows its label anchored on the target.

### Data model

```jsonc
{
  "id": "mjdrbpk3u5",
  "name": "Spring poster", "description": "…",
  "status": "published",                       // or "draft" (public link returns 404)
  "brand":   { "name": "", "accentColor": "#e5173f", "logoUrl": null,
               "coverUrl": null },                // optional portrait splash image
  "target":  { "imageUrl": "/uploads/…/target-….jpg", "mindUrl": "/uploads/…/target-….mind",
               "width": 1000, "height": 626, "quality": "good", "featureCount": 1833 },
  "content": { "type": "video", "url": "/uploads/…/content-….mp4", "fileName": "promo.mp4",
               "fit": "target", "loop": true, "startMuted": true, "playAnimations": true },
  "placement": { "scale": 1, "offsetX": 0, "offsetY": 0, "offsetZ": 0,
                 "rotationX": 0, "rotationY": 0, "rotationZ": 0 },
  "hotspots": [{ "id": "a1", "label": "Strong shoulder", "x": 0.42, "y": 0.35 }],
  "createdAt": "…", "updatedAt": "…"
}
```

### API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | none | Reports admin auth mode |
| GET | `/api/public/experiences/:id` | none | Published experiences only |
| GET | `/api/experiences` · `/api/experiences/:id` | admin | |
| POST | `/api/experiences` | admin | multipart: `data` (JSON), `targetImage`, `targetMind`, `content`, `logo?`, `cover?` |
| PUT | `/api/experiences/:id` | admin | Same fields; files optional |
| PATCH | `/api/experiences/:id/status` | admin | `{ "status": "published" \| "draft" }` |
| DELETE | `/api/experiences/:id` | admin | Removes the record and its files |

Admin auth uses `Authorization: Bearer <ADMIN_TOKEN>`. The admin UI prompts for the token when the API returns 401 and keeps it in `localStorage` in that browser.

### Why not localStorage only?

A QR code is scanned on a **different device** from the one the admin used, and localStorage is per browser. So metadata and files live on the small Express server. localStorage holds only the admin token in this app.

## Demo experiences

Seven published demos are stored in `server/data` (local, git-ignored) and exported to `public/` for Vercel. All of them are in the gallery link (`/gallery`). All were compiled with the app's own pipeline and graded **Good**, and all were verified to track with a simulated camera.

| Experience | ID | Target | Content | Hotspots |
| --- | --- | --- | --- | --- |
| Haeckel’s Jellyfish — Living Plate | `ac9tcc25am` | Ernst Haeckel, *Kunstformen der Natur*, plate 8 “Discomedusae” (1904) | **Living video**: the paper turns into the deep sea, the bells pulse and glow with rings of light, the tentacles undulate, plankton drifts through light rays | Desmonema annasethe, Trailing tentacles, Golden bell, Seen from below |
| The Kiss — Living Gold | `h3nk4sbenq` | Gustav Klimt, *The Kiss* (1907–1908) | **Living video**: the gold leaf glitters with twinkling stars and shimmers, a golden sheen sweeps across, gold dust rises, the flower meadow sways | The embrace, Real gold leaf, Flower meadow, Patterned robe |
| Almond Blossoms — Spring Breeze | `b2mvhfw7mq` | Vincent van Gogh, *Almond Blossoms* (1890) | **Living video**: the branches sway in the wind, the brushstroke sky flows, the blossoms glow and petals tumble across the canvas | Almond blossom, Twisting branch, Turquoise sky |
| The Starry Night — Living Painting | `fjyd6wyh65` | Van Gogh, *The Starry Night* (1889) | **Video**: the painting itself animated (rippling sky, colour shimmer), overlaid exactly on the target | Crescent moon, The swirling sky, Cypress tree, Village church |
| The Great Wave — 3D Fox | `kyz99aw9q2` | Hokusai, *The Great Wave off Kanagawa* (c. 1831) | **3D model**: animated Fox (glTF) standing on the waves | The great wave, Mount Fuji, Fishing boats |
| Girl with a Pearl Earring — Explore Vermeer | `z9u7ykh6gs` | Vermeer, *Girl with a Pearl Earring* (c. 1665) | **Image**: Vermeer's *View of Delft* as a floating panel | The pearl, Ultramarine turban, The gaze |

### CEAT Premium Touring Tyre (`vprgcfcwen`)

A tyre-ad experience in the style of the reference video. It has a premium dark UI, a splash hero with a preloading bar, an angled glass header tab, an animated video overlay locked to the poster, and tappable tread hotspots (Wide center rib, Strong shoulder, Wet-grip grooves, Sidewall design).

- **Print or display `demo-assets/ceat/ceat-poster.jpg`** and scan it. That folder also holds the AR video, splash hero, wordmark logo and hotspot coordinates.
- **All artwork is original** and was generated for this demo: a procedural three.js tyre, the layout, and the copy. "CEAT" appears as a plain text wordmark, **not the official CEAT logo**, and the poster copy is placeholder marketing text. Before showing it publicly, replace the logo, poster, splash image and copy with official, licensed CEAT brand assets via **Admin → Manage → Branding / Target image**. The video overlay must be re-rendered to match any new poster.

To try them, open `/ar/<ID>` and point the camera at the painting, either printed or on another screen. Source images: [Haeckel, Discomedusae](https://commons.wikimedia.org/wiki/File:Haeckel_Discomedusae_8.jpg), [Klimt, The Kiss](https://commons.wikimedia.org/wiki/File:The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg), [Van Gogh, Almond Blossoms](https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_Almond_blossom_-_Google_Art_Project.jpg), [Starry Night](https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg), [Great Wave](https://commons.wikimedia.org/wiki/File:Tsunami_by_hokusai_19th_century.jpg), [Pearl Earring](https://commons.wikimedia.org/wiki/File:1665_Girl_with_a_Pearl_Earring.jpg).

**Credits / licences**
- Paintings (Van Gogh, Hokusai, Vermeer incl. *View of Delft*, Klimt) and Haeckel's plate: public domain, via Wikimedia Commons.
- **Living-art videos** (Haeckel, Klimt, Almond Blossoms) were rendered for these demos from the artworks themselves with `demo-assets/living-art/renderer.html` (one WebGL shader preset per artwork; every effect is periodic, so the 8 s videos loop seamlessly). **Edges are locked:** within a 7% band along the border, the effects fade out and the video is the exact artwork, so the overlay's corners and edges never move against the print. Corner patches change by only 1–5 grey levels over a loop (compression noise), down from 23–65 before. The Starry Night video got the same lock as a post-process: a feathered mask composites the original painting over the video's border with `ffmpeg … alphamerge, overlay`. Use the same approach for any uploaded living-art video. No free video of a painting animated from that same painting exists, and a downloaded animation never lines up with a printable image. To make one for a new artwork, add a preset, render 240 frames headless with `renderFrame(t)` and encode with `ffmpeg -framerate 30 -i f_%04d.png -c:v libx264 -crf 28 -pix_fmt yuv420p -movflags +faststart`; then upload the artwork as the target and the video as content (*Fit: match target*).
- Fox model ([Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox)): model by PixelMannen (CC0); rigging & animation by tomkranis (CC BY 4.0); glTF conversion by @AsoboStudio and @scurest (CC BY 4.0). The attribution is in the experience description, which is shown to visitors.

## Target and content guidelines

- **Good targets**: detailed, high-contrast artwork with many corners and textures, roughly 1:1 to 2:1 aspect, printed with a matte finish. **Bad targets**: plain gradients, large flat areas, mostly text, repeating patterns, glossy surfaces.
- Videos: H.264 MP4, ≤ 1080p, ideally the same aspect as the target, a few MB.
- Models: ≤ 10 MB GLB, compressed textures, with a sensible origin.
- iOS Safari requires `playsinline`/muted autoplay; this is handled. Unmuting always needs a tap.

## Source layout

```
server/
  index.js            Express API, uploads, auth, static SPA hosting
  store.js            Atomic JSON-file persistence
  validation.js       Payload sanitisation, file-type rules, public projection
src/
  App.jsx, main.jsx, config.js
  ar/
    ImageTrackingSession.js   Camera + MindAR Controller + three.js renderer
    content.js                Video / image / glTF content builders, lighting
    hotspots.js               Tappable hotspot markers with labels
    environment.js            Capability checks, camera error classification
    loadMindAR.js             Lazy loader for the MindAR engine
  hooks/
    useWebAR.js               AR session lifecycle for React
    useExperiencePreload.js   Asset preloading with combined progress
    useObjectUrl.js
  services/
    apiClient.js, experienceService.js, imageTargetService.js, qrService.js, assetLoader.js
  components/
    admin/   AdminLayout, AdminAuthGate, ExperienceForm, TargetImageField, ContentField,
             PlacementControls, PlacementPreview, HotspotEditor, ExperienceCard
    qr/      QRPanel
    ar/      ARSplash, ARHud, ARMessage, BrandHeader
    common/  Icon, Toast, StateView, FileDrop
  pages/     Dashboard, CreateExperience, ManageExperience, ARExperience, NotFound
  styles/    global.css
```

## Limitations

- **MindAR**: tracks one image target per experience. It does not do world/plane tracking (content can't stay when the target leaves view), and tracking degrades at steep angles, in low light, or when the target fills less than about 15–20% of the frame. Very large posters seen from far away need high-detail artwork.
- **Performance**: tracking runs on the GPU through TensorFlow.js. Older or low-end phones may get low frame rates. TensorFlow.js keeps compiled GPU kernels for the page's lifetime (by design), so repeated sessions on one page reuse them rather than leaking.
- **iOS**: requires Safari, or Chrome on iOS 14.3+. In-app browsers (Instagram, Facebook, TikTok…) often block the camera, so the app detects them and asks users to open the link in the browser.
- **`.gltf` with external `.bin`/textures** is not supported (single-file upload). Use `.glb`.
- **Animated GIFs** are not supported as image content (WebGL shows only the first frame). Use a video.
- The quality grade is a **heuristic** calibrated on test images, not a guarantee.

## Production recommendations

The bundled server is a solid single-instance deployment, but it is **not** a multi-tenant, horizontally scalable system:

- **Storage**: move uploads to object storage (S3, Cloudflare R2, Supabase Storage) behind a CDN, and metadata to a database (PostgreSQL/Supabase). `server/store.js` and `commitFile()` are the two seams to replace.
- **Auth**: replace the shared `ADMIN_TOKEN` with real user accounts (OAuth/SSO, Supabase Auth) and per-user ownership, and add rate limiting on write endpoints.
- **Uploads**: scan files, cap total storage per account, optionally transcode videos server-side (H.264 + multiple bitrates) and optimise GLBs (`gltf-transform`).
- **Analytics**: track scans, starts, time-to-detect and session length.
- **Compilation**: compiling server-side is possible with MindAR's Node compiler (needs the native `canvas` package), if you don't want to rely on the admin's browser.

## What was verified

All of the following ran on this machine against `npm start` (production build) and `npm run dev` (React StrictMode), using headless Chrome with a **fake camera stream** showing a printed target:

- **API**: create, update and delete; validation errors; draft hidden from the public endpoint; token auth (401 without a valid token, 503 in production with no token configured); temp-file cleanup; replaced-file deletion; range requests; upload headers.
- **Admin**: real MindAR compilation (~3.5–5 s). A gradient wallpaper graded **Poor** (1 tracking point); a detailed photo graded **Good** (32 tracking points, 1833 features). Content upload, hotspot placement, live 3D preview, save, and redirect to the manage page.
- **QR**: the downloaded 1024×1024 PNG was decoded and contains exactly the experience URL.
- **AR**: no camera request before Start AR. Real MindAR detection about 1.5 s after start. Video, image and animated-GLB content rendered aligned with the target. Hotspot tap opens its label, and a tap elsewhere closes it. Close stops all camera tracks and removes the video and canvas. A second session works. Permission-denied and not-found screens render. No console errors.

**Not yet verified**: tracking on a **real phone with a real camera** over a deployed HTTPS URL. No device or public HTTPS host was available in this environment. Test this before launch (see *Testing on a phone*).

## Patched dependency note

`mind-ar@1.2.5` declares the native `canvas` package, which is used only by its Node-side compiler. That package pulled a vulnerable `tar` into the install. Because the browser bundles never import it, `package.json` overrides it with an empty package (`@favware/skip-dependency`). Result: no native build step and `npm audit` reports **0 vulnerabilities**.
