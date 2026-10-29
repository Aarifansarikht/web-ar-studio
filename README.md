# WebAR Studio

Create **image-tracked WebAR experiences** and share them with a **QR code**, with no app install. An admin uploads a poster, product or packaging image, attaches a video, image or 3D model, and gets a QR code. Visitors scan it and see the content anchored to the real printed image through their phone's camera.

The flow reproduces the reference video (`WhatsApp Video 2026-10-28 at 1.53.18 PM.mp4`):

| Reference video | This app |
| --- | --- |
| QR code printed on the poster | Per-experience QR code (PNG download) containing the real public URL |
| Branded web page with logo, "AR EXPERIENCE" tagline and a red **PRELOADING** bar | `/ar/:id` splash: brand header, hero image, real byte-level preloading progress |
| Camera view with a slim brand header | Full-screen camera with brand header, scan frame and guidance |
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

### Tracking behaviour (enhanced / extended tracking)

- **Smooth, low-lag tracking.** MindAR's One-Euro filter uses a low min-cutoff (no jitter when still) and a high beta (no lag when moving). The camera runs at 720p. Poses from the tracker (~15–30 Hz) are eased at the display rate (60 Hz), so content glides instead of stepping.
- **Close-up tracking (Artivive-style).** The overlay stays locked when you walk up to the artwork and only part of it fills the screen. Two changes make this work, measured with a simulated walk-in/close-up/pan camera feed:
  - *Tracker tuning* (Vite plugin `mindarTrackingTuning` in `vite.config.js`, MindAR pinned to 1.2.5). Tracking runs on the finer 256 px template level instead of 128 px, with a slightly wider search radius. Close-up lock: 18% → 66%.
  - *Higher-resolution targets*. Images are compiled at up to 2048 px instead of 1024 px, so detection can re-find the target from a close-up. Combined with the tracker tuning: **100% lock** through walk-in, close-up, pan and back-out.
  - Add `?debug` to an AR link to show the tracker's frame rate on a phone.
  - Targets compiled before this change still work but should be re-uploaded (Admin → Replace target image) to get the close-up improvement.
- **Lock-on cue.** Accent corner brackets snap onto the target when it is recognised.
- **No re-scan after the first lock.** If the image leaves the view, the content stays (*Extended tracking* chip). With motion sensors (requested on the Start tap; iOS shows a prompt), the content is **gyro-anchored** on the wall for up to 4 s (3-DoF). Without sensors it hides after 0.5 s (see "Tracking when the image is lost").
- **Manual full screen.** The expand button shows the content full screen at any time; tap again to return to the AR view.

Limits: extended tracking compensates rotation only. If the user walks sideways, the held content does not shift with them until the image is re-detected.

### Layered 3D scenes (artwork stays on the wall)

For the most convincing effect, don't cover the whole print with a flat video. Leave the real artwork visible through the camera and add **3D elements that come off it**, like Artivive. Upload a GLB as **3D model** and tick **"Scene is authored in target space"**:

- Units: 1 = image width, origin at the image centre, +X right, +Y up, +Z out of the wall. Nothing is auto-scaled, so the scene lines up with the print.
- Animation clips named `intro` play once when the image is first recognised (e.g. an element lifting off the wall). A clip named `loop` repeats. Other GLBs play their first clip.
- Unlit (`KHR_materials_unlit`) materials keep the artwork's exact colours. Use them for wall patches, glows and light effects. Lit (PBR) materials get studio lighting and filmic tone mapping.
- Hotspots accept an optional `z` (height above the image, in image widths), so markers can sit on 3D parts.

The CEAT demo (`demo-assets/ceat/ceat-ar-scene.glb`) is built this way. It contains a feathered clean patch that hides the printed tyre, the same 3D tyre (PBR) lifting 0.1 image widths off the wall and spinning, a contact shadow, a glow, and light streaks. It is about 54k triangles, 2.1 MB, and was validated with Blender's glTF importer.

### Tracking when the image is lost

- With motion sensors: the content stays world-anchored on the wall (rotation-compensated) for up to 4 s, then hides.
- Without motion sensors: only brief dropouts (0.5 s) are bridged, then the content hides with a "Point at the artwork" hint. It never freezes on screen as a floating picture.
- Rotation is smoothed more strongly than position. Rotation is the noisiest part of a single-camera pose and shows up as a tilting/wobbling overlay.

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

Three published demos are stored in `server/data` (local, git-ignored). Each covers one content type. All were compiled with the app's own pipeline and graded **Good**, and all were verified to track with a simulated camera.

| Experience | ID | Target | Content | Hotspots |
| --- | --- | --- | --- | --- |
| The Starry Night — Living Painting | `fjyd6wyh65` | Van Gogh, *The Starry Night* (1889) | **Video**: the painting itself animated (rippling sky, colour shimmer), overlaid exactly on the target | Crescent moon, The swirling sky, Cypress tree, Village church |
| The Great Wave — 3D Fox | `kyz99aw9q2` | Hokusai, *The Great Wave off Kanagawa* (c. 1831) | **3D model**: animated Fox (glTF) standing on the waves | The great wave, Mount Fuji, Fishing boats |
| Girl with a Pearl Earring — Explore Vermeer | `z9u7ykh6gs` | Vermeer, *Girl with a Pearl Earring* (c. 1665) | **Image**: Vermeer's *View of Delft* as a floating panel | The pearl, Ultramarine turban, The gaze |

### CEAT Premium Touring Tyre (`vprgcfcwen`)

A tyre-ad experience in the style of the reference video. It has a premium dark UI, a splash hero with a preloading bar, an angled glass header tab, an animated video overlay locked to the poster, and tappable tread hotspots (Wide center rib, Strong shoulder, Wet-grip grooves, Sidewall design).

- **Print or display `demo-assets/ceat/ceat-poster.jpg`** and scan it. That folder also holds the AR video, splash hero, wordmark logo and hotspot coordinates.
- **All artwork is original** and was generated for this demo: a procedural three.js tyre, the layout, and the copy. "CEAT" appears as a plain text wordmark, **not the official CEAT logo**, and the poster copy is placeholder marketing text. Before showing it publicly, replace the logo, poster, splash image and copy with official, licensed CEAT brand assets via **Admin → Manage → Branding / Target image**. The video overlay must be re-rendered to match any new poster.

To try them, open `/ar/<ID>` and point the camera at the painting, either printed or on another screen. Source images: [Starry Night](https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg), [Great Wave](https://commons.wikimedia.org/wiki/File:Tsunami_by_hokusai_19th_century.jpg), [Pearl Earring](https://commons.wikimedia.org/wiki/File:1665_Girl_with_a_Pearl_Earring.jpg).

**Credits / licences**
- Paintings (Van Gogh, Hokusai, Vermeer incl. *View of Delft*): public domain, via Wikimedia Commons.
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
