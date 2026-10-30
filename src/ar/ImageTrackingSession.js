import * as THREE from 'three';
import { ARError, classifyCameraError } from './environment.js';
import { loadMindAR } from './loadMindAR.js';
import { GyroTracker } from './GyroTracker.js';
import { FocalCalibrator } from './FocalCalibrator.js';

/** Only one camera + tracking session may run at a time. */
let activeSession = null;

const IDENTITY_QUAT = new THREE.Quaternion();
// Pose stabiliser. MindAR's One-Euro filter works on raw matrix values per
// millisecond, so its speed term reacts to any noise and it barely smooths in
// practice; content (especially 3D parts sticking out of the wall) wobbles.
// We smooth the pose in meaningful units with an adaptive rate: changes small
// enough to be noise are smoothed heavily, real motion is followed quickly.
// Thresholds from measured tracker noise on a static, noisy camera feed
// (rotation p90 ≈ 3.7°, position p90 ≈ 0.23% of distance). Real motion always
// moves the image in the frame, so the position channel catches it even when
// the rotation threshold is generous.
const ROT_STILL_DEG = 2.5; // below: treated as noise
const ROT_MOVE_DEG = 12; // above: real motion, follow fast
const POS_STILL = 0.004; // translation change relative to camera distance
const POS_MOVE = 0.03;
const RATE_STILL = 2.5; // per second
const RATE_MOVE = 40;
// Adaptive tracking level (see vite.config.js): switch to the fine 256px
// templates when the image's shorter side appears larger than this in the
// tracker input (px), back to the stable 128px level below the exit size.
const FINE_ENTER_PX = 210;
const FINE_EXIT_PX = 170;
// Delayed, frame-exact display (see class comment). Every camera frame is kept
// on the GPU in a small ring; the view plays them back slightly delayed, and
// each frame's content pose is interpolated between the tracker results just
// before and after it. The delay adapts to the tracker's speed on the device.
const FRAME_RING_SIZE = 12;
const MAX_DELAY_S = 0.3;
const MIN_DELAY_S = 0.03;
const DELAY_MARGIN_S = 0.012;
// Extrapolation is only a fallback (tracker hiccup, or browsers without
// requestVideoFrameCallback): capped so content can never fly off.
const MAX_PREDICT_S = 0.12;
// A tracker gap shorter than this is bridged by continuing the recent motion
// (content keeps gliding with the camera); longer gaps fade the content out.
const STALE_BRIDGE_S = 0.25;
const FADE_S = 0.15; // content fade in/out time when tracking stops/resumes
const VELOCITY_SMOOTHING = 0.55; // weight of the newest velocity sample
const POSE_HISTORY = 40;
// Tracking quality gate (anti-drift): share of the template points visible in
// the frame that must match for a frame to count as tracked.
const MIN_TRACK_RATIO = 0.35; // on a running average (TRACK_QUALITY_ALPHA) over recent frames
const TRACK_QUALITY_ALPHA = 0.2;
const MIN_VISIBLE_FOR_GATE = 12;
// Centred pose fit (delayed mode). Each displayed frame's pose is a weighted
// linear fit over the raw tracker poses before *and after* it (the delay makes
// later ones available). A linear fit follows steady motion without lag, so
// noise is removed while the phone moves too, unlike a causal smoother that
// must follow fast motion and lets its noise through. Window (Gaussian sigma,
// seconds) adapts: wide when still, narrower when moving fast. When still,
// the fit becomes a plain weighted mean (no slope term: much less noise).
const FIT_SIGMA_STILL = 0.3;
const FIT_SIGMA_MOVE = 0.07;
// With the gyroscope (see GyroTracker.js), the artwork's orientation in the
// world frame is constant, so rotation noise is averaged over a long window.
const FIT_SIGMA_GYRO_ROT = 0.45;
// Point used for the wobble diagnostic: 0.15 image widths in front of the centre.
const WOBBLE_PROBE = new THREE.Vector3(0, 0, 0.15);
// The tracker analyses a downscaled copy of the camera frame (long side in px).
// MindAR's projection is resolution-independent, so this is ~45% less work per
// frame than 720p with no loss of alignment; the display stays at full 720p.
const PROCESS_LONG_SIDE = 960;
// Phone camera field of view across the *long* side of the video, in degrees
// (typical main cameras with 16:9 video: ~63–70°). MindAR's own assumption is
// 45° across the frame height, about half the real view in portrait.
const CAMERA_FOV_LONG_DEG = 66;

// Diagnostics: ?debug&minCF=…&beta=…&proc=…&stab=0 override tracking settings for field tuning.
const TUNING = (() => {
  if (typeof window === 'undefined') return {};
  const q = new URLSearchParams(window.location.search);
  if (!q.has('debug')) return {};
  const num = (k) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : undefined);
  return {
    debug: true,
    minCF: num('minCF'),
    beta: num('beta'),
    processLongSide: num('proc'),
    // &fov=<deg>: camera field of view across the long side (0 = MindAR's default).
    fov: num('fov'),
    stabilise: q.get('stab') !== '0',
    // &live=1: show the live camera with extrapolated poses (the fallback mode).
    live: q.get('live') === '1',
    predict: q.get('predict') !== '0',
    // &fit=0: interpolate the causally stabilised poses instead (A/B).
    fit: q.get('fit') !== '0',
    minTrack: num('minTrack'),
    fitMean: q.get('fitMean') !== '0',
    sigS: num('sigS'),
    sigM: num('sigM'),
    drift: q.get('drift') === '1',
    // &wire=1: wireframe of the exact target rectangle on the tracked anchor.
    wire: q.get('wire') === '1',
    staleHide: q.get('staleHide') !== '0',
    // &stall=1: pause the tracker 0.6 s every 3 s (simulates a busy phone).
    stall: q.get('stall') === '1',
    // &gyro=1: gyroscope fusion (experimental, off by default: on a real phone the
    // camera/gyroscope timing differs per device and it pulled content off the image).
    gyro: q.get('gyro') === '1',
    // &noise=<deg>: add random tracking noise to test smoothing: rotation <deg>, position <deg>/8 % of the
    // distance (the ratio measured on the tracker: rotation p90 ≈ 2–5°, position ≈ 0.25–0.6 %).
    noise: num('noise'),
  };
})();

/**
 * Real image-target tracking session: camera feed + MindAR Controller +
 * three.js renderer. Content added to `session.anchor` is rendered in the
 * target's coordinate space:
 *   - origin at the centre of the target image
 *   - +X right, +Y up, +Z out of the image towards the viewer
 *   - 1 unit = the target image's width (height = targetHeight / targetWidth)
 * The compiled data may contain several images (gallery): one is tracked at a
 * time; `displayTarget` is the index of the image whose pose is on screen.
 *
 * Smooth and glued: every camera frame is copied to the GPU as it arrives
 * (requestVideoFrameCallback) and the view plays the frames back at full camera
 * frame rate, delayed by just enough for the tracker to have analysed a later
 * frame. Each displayed frame gets the pose interpolated between the tracker
 * results around it, so content stays fixed to the printed image while the
 * phone moves, even when the tracker runs slower than the camera. Without
 * requestVideoFrameCallback, the live video is shown with extrapolated poses.
 */
export class ImageTrackingSession {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container Full-size element that will host the video and canvas.
   * @param {ArrayBuffer} opts.mindBuffer Compiled `.mind` target data.
   * @param {(e: {type: 'found'|'searching', targetIndex: number}) => void} [opts.onTrackingChange]
   * @param {(e: {fullscreen: boolean}) => void} [opts.onModeChange]
   * @param {(dt: number, elapsed: number) => void} [opts.onFrame]
   */
  constructor({ container, mindBuffer, onTrackingChange, onModeChange, onFrame }) {
    this.container = container;
    this.mindBuffer = mindBuffer;
    this.onTrackingChange = onTrackingChange;
    this.onModeChange = onModeChange;
    this.onFrame = onFrame;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.anchor = new THREE.Group();
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.scene.add(this.anchor);

    this.clock = new THREE.Clock(false);
    this.tracking = false;
    this.everFound = false;
    this.fullscreen = false;
    this.stopped = false;
    /** Per image: { aspect, width, post } (post: MindAR pose units → 1 unit = image width, centred). */
    this.targets = [];
    this.activeTarget = -1; // image the tracker currently follows
    this.displayTarget = -1; // image whose pose belongs to the frame on screen
    this._processDone = null;

    // Pose state (allocated once).
    this._trackedMatrix = new THREE.Matrix4(); // latest tracker result (stabilised)
    this._sp = new THREE.Vector3();
    this._sq = new THREE.Quaternion();
    this._ss = new THREE.Vector3();
    this._pS = new THREE.Vector3();
    this._qS = new THREE.Quaternion();
    this._sS = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._stabInit = false;
    this._stabT = 0;
    this._wobble = { raw: [], shown: [] };
    this._goal = new THREE.Matrix4();
    this._gp = new THREE.Vector3();
    this._gq = new THREE.Quaternion();
    this._gs = new THREE.Vector3();
    this._cp = new THREE.Vector3();
    this._cq = new THREE.Quaternion();
    this._cs = new THREE.Vector3(1, 1, 1);
    this._tmpPos = new THREE.Vector3();
    this._tmpScale = new THREE.Vector3();
    this._snapPose = false;
    this._blendUntil = 0;

    // Motion prediction state: last tracked (stabilised) pose, the time its
    // camera frame was read, and smoothed linear/angular velocity.
    this._inputT = 0;
    this._predT = 0;
    this._predP = new THREE.Vector3();
    this._predQ = new THREE.Quaternion();
    this._predS = new THREE.Vector3(1, 1, 1);
    this._vel = new THREE.Vector3();
    this._angVel = new THREE.Vector3(); // axis * rad/s
    this._hasPred = false;
    this._tmpVel = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();

    // Delayed display state: ring of camera frames ({rt, t}) and tracked poses
    // ({t, seg, p, q, s}, stabilised), keyed by camera frame time (seconds).
    this._frames = [];
    this._poses = [];
    this._seg = 0;
    this._delay = 0.1;
    this._snapT = 0;
    this._delayed = false;
    this._shownT = 0;
    this._trackQ = 0.8;
    this._viewFrames = 0;
    this._rawP = new THREE.Vector3();
    this._rawQ = new THREE.Quaternion();
    this._rawS = new THREE.Vector3();
    this._fit = {
      qInv: new THREE.Quaternion(),
      dq: new THREE.Quaternion(),
      r: new THREE.Vector3(),
      p0: new THREE.Vector3(),
      p1: new THREE.Vector3(),
      r0: new THREE.Vector3(),
      r1: new THREE.Vector3(),
      s0: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      g: new THREE.Quaternion(),
    };
    this._jerk = [];
    this._jerkT = 0;
    this._fitMean = new THREE.Vector3();

    /** Diagnostics: tracker frames processed per second. */
    this.stats = { trackFps: 0, wobbleRaw: 0, wobbleShown: 0, trackLevel: 'coarse', delayMs: 0 };
    this._trackFrames = 0;
    this._statsAt = 0;
  }

  /** True while the image is actually being tracked by the camera. */
  get isTracking() {
    return this.tracking;
  }

  /** Height / width of the image on screen (or the first image). */
  get targetAspect() {
    return this.targets[Math.max(0, this.displayTarget)]?.aspect ?? 1;
  }

  get targetWidth() {
    return this.targets[Math.max(0, this.displayTarget)]?.width ?? 1;
  }

  /** True once the target has been recognised at least once. */
  get hasFoundTarget() {
    return this.everFound;
  }

  async start() {
    if (activeSession && activeSession !== this) {
      await activeSession.stop();
    }
    activeSession = this;

    try {
      const [{ Controller }] = await Promise.all([loadMindAR(), this.#startCamera()]);
      if (this.stopped) return;
      this.Controller = Controller;

      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.autoClear = false;
      Object.assign(this.renderer.domElement.style, {
        position: 'absolute',
        inset: '0',
        zIndex: '1',
        touchAction: 'none',
        maxWidth: 'none',
      });
      this.container.appendChild(this.renderer.domElement);
      this.#createCameraBackground();

      await this.#buildController();
      if (this.stopped) return;

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
      this.#onVideoResize = () => this.#handleVideoResize();
      this.video.addEventListener('resize', this.#onVideoResize);

      if (TUNING.gyro === true && this._delayed) {
        this._gyro = new GyroTracker();
        this._gyro.start();
        if (TUNING.debug) window.__webarGyro = this._gyro; // diagnostics
      }
      if (TUNING.debug) window.__webarSession = this; // diagnostics
      this.clock.start();
      this.renderer.setAnimationLoop(() => this.#render());
    } catch (err) {
      await this.stop();
      if (err instanceof ARError) throw err;
      throw new ARError('engine', 'The AR engine failed to start on this device.', err);
    }
  }

  async #startCamera() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // 720p gives a sharp full-screen feed; the tracker analyses a smaller copy.
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (err) {
      throw classifyCameraError(err);
    }
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.playsInline = true;
    // The video is deliberately larger than the container (cover fit), so
    // neutralise any host-page max-width/height rules.
    Object.assign(video.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      zIndex: '0',
      objectFit: 'fill',
      maxWidth: 'none',
      maxHeight: 'none',
    });
    this.container.appendChild(video);
    this.video = video;

    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new ARError('camera-busy', 'The camera stream could not be read.')), {
        once: true,
      });
      video.srcObject = stream;
    });
    await video.play().catch(() => {});
  }

  /* ---------------------------------------------------------------- camera frames */

  #createCameraBackground() {
    // Raw pixel copies (no colour conversion, no tone mapping) so the camera
    // image on screen is identical to the video.
    const vertexShader = `
      uniform vec4 uCrop;
      varying vec2 vUv;
      void main() { vUv = uv * uCrop.xy + uCrop.zw; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
    const fragmentShader = `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() { gl_FragColor = texture2D(map, vUv); }`;
    const quad = (map, crop) =>
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({
          uniforms: { map: { value: map }, uCrop: { value: crop } },
          vertexShader,
          fragmentShader,
          depthTest: false,
          depthWrite: false,
        }),
      );
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // Display: one buffered camera frame, cover-cropped like the <video>.
    this.bgScene = new THREE.Scene();
    this.bgMesh = quad(null, new THREE.Vector4(1, 1, 0, 0));
    this.bgScene.add(this.bgMesh);
    // Capture: the current video frame, copied 1:1 into a ring slot.
    this.videoTexture = new THREE.Texture(this.video);
    this.videoTexture.colorSpace = THREE.NoColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;
    this.copyScene = new THREE.Scene();
    this.copyMesh = quad(this.videoTexture, new THREE.Vector4(1, 1, 0, 0));
    this.copyScene.add(this.copyMesh);
  }

  /** Copy the current camera frame into the ring (called once per new video frame). */
  #captureFrame(t, source) {
    const { renderer, video } = this;
    if (!renderer || !video.videoWidth) return;
    let slot;
    if (this._frames.length >= FRAME_RING_SIZE) {
      slot = this._frames.shift();
    } else {
      slot = {
        rt: new THREE.WebGLRenderTarget(source.width, source.height, {
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        }),
        t: 0,
      };
    }
    if (this.videoTexture.image !== source) this.videoTexture.image = source;
    this.videoTexture.needsUpdate = true;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(slot.rt);
    renderer.render(this.copyScene, this.bgCamera);
    renderer.setRenderTarget(prev);
    slot.t = t;
    this._frames.push(slot);
  }

  #disposeFrames() {
    for (const f of this._frames) f.rt.dispose();
    this._frames = [];
  }

  /* ---------------------------------------------------------------- tracker */

  async #buildController() {
    const { video } = this;
    this._videoW = video.videoWidth;
    this._videoH = video.videoHeight;
    const s = Math.min(1, (TUNING.processLongSide ?? PROCESS_LONG_SIDE) / Math.max(video.videoWidth, video.videoHeight));
    const inputWidth = Math.round(video.videoWidth * s);
    const inputHeight = Math.round(video.videoHeight * s);
    // MindAR's input loader draws the video at its width/height *attributes*:
    // setting them to the tracker input size makes it downscale each frame.
    // (CSS width/height, set in resize(), still control the on-screen size.)
    video.setAttribute('width', inputWidth);
    video.setAttribute('height', inputHeight);
    // Realistic focal length (see CAMERA_FOV_LONG_DEG and vite.config.js): the
    // value measured on this device before, else a typical phone camera. It is
    // then measured live (FocalCalibrator) unless fixed with ?debug&fov=.
    const fov = TUNING.fov ?? FocalCalibrator.load() ?? CAMERA_FOV_LONG_DEG;
    const focal = fov > 0 ? Math.max(inputWidth, inputHeight) / 2 / Math.tan(THREE.MathUtils.degToRad(fov) / 2) : undefined;
    globalThis.__mindarFocal = focal;
    this.controller = new this.Controller({
      inputWidth,
      inputHeight,
      maxTrack: 1,
      // One-Euro filter: a low min-cutoff removes jitter when the phone is
      // still; a high beta lets the pose follow instantly when it moves.
      filterMinCF: TUNING.minCF ?? 0.0005,
      filterBeta: TUNING.beta ?? 800,
      // Frames needed to confirm a detection before content appears (kept
      // minimal: content appears the moment the image is recognised).
      warmupTolerance: 1,
      // Frames the tracker may miss (motion blur) before the target counts as
      // lost. Kept short: content must never linger where the image isn't.
      missTolerance: 3,
      onUpdate: (data) => this.#onControllerUpdate(data),
    });

    delete globalThis.__mindarFocal;
    const { dimensions, trackingDataList, matchingDataList } = this.controller.addImageTargetsFromBuffer(this.mindBuffer.slice(0));
    this._matchingDataList = matchingDataList;
    this._focalCal =
      TUNING.fov === undefined ? new FocalCalibrator({ width: inputWidth, height: inputHeight }, this.controller.projectionTransform[0][0]) : null;
    this.stats.fov = Math.round(this._focalCal ? this._focalCal.fovFor(this.controller.projectionTransform[0][0]) : fov);
    if (!dimensions?.length) {
      throw new ARError('engine', 'The image target data is invalid or was compiled with an incompatible version.');
    }
    // Every analysed camera frame is tagged with its capture time, so its pose
    // can be paired with exactly that frame on screen.
    const loader = this.controller.inputLoader;
    const loadInput = loader.loadInput.bind(loader);
    let freshFrame = true;
    this._delayed = typeof video.requestVideoFrameCallback === 'function' && !TUNING.live;
    // Delayed mode: one full-resolution snapshot per camera frame feeds both
    // the display ring and (downscaled) the tracker, so the frame on screen is
    // guaranteed to be the frame its pose was computed from. (Uploading the
    // <video> to WebGL directly can deliver a different frame than drawImage
    // in the same callback; measured: tens of px of content slip.)
    const full = document.createElement('canvas');
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    const fullCtx = full.getContext('2d', { alpha: false });
    const snap = document.createElement('canvas');
    snap.width = inputWidth;
    snap.height = inputHeight;
    const snapCtx = snap.getContext('2d', { alpha: false });
    loader.loadInput = (v) => {
      freshFrame = false;
      if (this._delayed && this._snapT) {
        this._inputT = this._snapT;
        return loadInput(snap);
      }
      this._inputT = performance.now() / 1000;
      return loadInput(v);
    };
    // Start the next tracking step as soon as the camera has a new frame
    // (MindAR otherwise waits for a screen refresh after every frame, and may
    // analyse the same camera frame twice). See vite.config.js.
    if (typeof video.requestVideoFrameCallback === 'function') {
      let waiter = null;
      const controller = this.controller;
      const onVideoFrame = () => {
        if (this.stopped || this.controller !== controller) return; // rebuilt or stopped
        if (this._delayed) {
          const t = performance.now() / 1000;
          fullCtx.drawImage(video, 0, 0, full.width, full.height);
          snapCtx.drawImage(full, 0, 0, inputWidth, inputHeight);
          this._snapT = t;
          this.#captureFrame(t, full);
        }
        freshFrame = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w();
        }
        video.requestVideoFrameCallback(onVideoFrame);
      };
      video.requestVideoFrameCallback(onVideoFrame);
      this.controller.nextFrameHook = () =>
        new Promise((resolve) => {
          if (freshFrame) {
            setTimeout(resolve, 0); // yield so rendering can run
            return;
          }
          waiter = resolve;
          setTimeout(() => {
            // Never stall if frame callbacks pause (e.g. camera hiccup).
            if (waiter === resolve) {
              waiter = null;
              resolve();
            }
          }, 100);
        });
    }
    this.#setupAdaptiveTracking(dimensions, trackingDataList);
    // MindAR reports poses in target-pixel units with the origin at the
    // bottom-left corner; re-centre and normalise so 1 unit = target width.
    this.targets = dimensions.map(([w, h]) => ({
      aspect: h / w,
      width: w,
      post: new THREE.Matrix4().compose(new THREE.Vector3(w / 2, h / 2, 0), new THREE.Quaternion(), new THREE.Vector3(w, w, w)),
    }));

    this.resize();
    // Compile GPU kernels before the first real frame (can take ~1s).
    this.controller.dummyRun(video);
    if (this._fineTracker) {
      const input = this.controller.inputLoader.loadInput(video);
      this._fineTracker.dummyRun(input);
      input.dispose();
    }
    if (this.stopped) return;
    this.controller.processVideo(video);
  }

  /**
   * Two trackers over the same image: MindAR's default 128px level (stable at
   * normal distances) and the 256px level (keeps close-ups locked). Before each
   * tracking step, pick one by the image's apparent size, with hysteresis.
   */
  #setupAdaptiveTracking(dimensions, trackingDataList) {
    const c = this.controller;
    const Tracker = c.tracker?.constructor;
    this._fineTracker = null;
    if (Tracker && trackingDataList) {
      globalThis.__mindarTrackLevel = 0;
      try {
        this._fineTracker = new Tracker(dimensions, trackingDataList, c.projectionTransform, c.inputWidth, c.inputHeight, c.debugMode);
      } catch {
        this._fineTracker = null; // unpatched MindAR: stay on the default level
      } finally {
        delete globalThis.__mindarTrackLevel;
      }
    }
    const coarse = c.tracker;
    const fine = this._fineTracker;
    const minSides = dimensions.map(([w, h]) => Math.min(w, h));
    let level = 1;
    const trackAndUpdate = c._trackAndUpdate.bind(c);
    // Also records whether this frame was actually tracked (vs. a miss that
    // MindAR bridges by re-reporting the previous pose).
    c._trackAndUpdate = async (input, modelView, index) => {
      if (fine) {
        const depth = modelView[2][3];
        // Current focal length: it may have been recalibrated during the session.
        const apparent = depth > 0 ? (c.projectionTransform[0][0] * minSides[index]) / depth : 0;
        if (level === 1 && apparent > FINE_ENTER_PX) level = 0;
        else if (level === 0 && apparent < FINE_EXIT_PX) level = 1;
        c.tracker = level === 0 ? fine : coarse;
        this.stats.trackLevel = level === 0 ? 'fine' : 'coarse';
      }
      // Same as MindAR's _trackAndUpdate, plus a quality gate against drift:
      // a lock that slid off the image still matches a few template points
      // (MindAR accepts 4), so it would stay "locked" in the wrong place.
      // Require a share of the points that should be visible to match; else
      // drop the lock so the image is re-detected at its true position.
      if (TUNING.drift) this.#debugKick(modelView);
      if (TUNING.stall && performance.now() - (this._stallAt ??= performance.now()) > 3000) {
        this._stallAt = performance.now();
        await new Promise((r) => setTimeout(r, 600));
      }
      const { worldCoords, screenCoords } = c.tracker.track(input, modelView, index);
      this.#calibrateFocal(worldCoords, screenCoords, index);
      const visible = this.#visibleTrackPoints(c, modelView, index);
      const ratio = visible > 0 ? worldCoords.length / visible : 0;
      this.#noteTrackQuality(ratio, worldCoords.length);
      // Running average: single blurred frames dip, a slid-off lock stays low.
      if (visible >= MIN_VISIBLE_FOR_GATE) this._trackQ += (ratio - this._trackQ) * TRACK_QUALITY_ALPHA;
      if (worldCoords.length < 4 || this._trackQ < (TUNING.minTrack ?? MIN_TRACK_RATIO)) {
        this._trackQ = 0.8; // fresh start for the re-detected lock
        return null;
      }
      const result = await c._workerTrackUpdate(modelView, { worldCoords, screenCoords });
      if (result) this._frameTracked = true;
      return result;
    };
    void trackAndUpdate; // MindAR's version (replaced above)
  }

  /**
   * Feed the camera calibration and apply a newly measured focal length once
   * it differs noticeably from the one in use (see FocalCalibrator.js).
   */
  #calibrateFocal(worldCoords, screenCoords, index) {
    const cal = this._focalCal;
    if (!cal || worldCoords.length < 12) return;
    cal.observe(worldCoords, screenCoords, this.targets[index]?.width ?? 1);
    this._calFrames = (this._calFrames ?? 0) + 1;
    if (this._calFrames % 15) return;
    const measured = cal.result();
    const c = this.controller;
    const current = c.projectionTransform[0][0];
    this.stats.fovMeasured = measured ? Math.round(cal.fovFor(measured)) : null;
    // Each switch re-detects the image (a short gap), so only apply clear
    // differences, at most twice per session.
    if (!measured || Math.abs(measured - current) / current < 0.05 || (this._focalSwitches ?? 0) >= 2) return;
    this._focalSwitches = (this._focalSwitches ?? 0) + 1;
    this.#setFocal(measured);
    FocalCalibrator.save(cal.fovFor(measured));
  }

  /** Switch the tracker, pose estimator (worker) and renderer to a new focal length. */
  #setFocal(focal) {
    const c = this.controller;
    c.projectionTransform[0][0] = focal; // shared with both trackers
    c.projectionTransform[1][1] = focal;
    c.projectionMatrix = c._glProjectionMatrix({
      projectionTransform: c.projectionTransform,
      width: c.inputWidth,
      height: c.inputHeight,
      near: 10,
      far: 100000,
    });
    c.worker.postMessage({
      type: 'setup',
      inputWidth: c.inputWidth,
      inputHeight: c.inputHeight,
      projectionTransform: c.projectionTransform,
      debugMode: c.debugMode,
      matchingDataList: this._matchingDataList,
    });
    this._focalCal.focal = focal;
    this.stats.fov = Math.round(this._focalCal.fovFor(focal));
    // MindAR refines each pose from the previous one; a pose from the old lens
    // model keeps it in a wrong solution, so re-detect from scratch (the content
    // stays up during MindAR's miss tolerance).
    for (const st of c.trackingStates) st.isTracking = false;
    // Poses estimated with the old lens model must not be blended with new ones.
    this._seg++;
    this._stabInit = false;
    this.resize();
  }

  /** Diagnostics: recent tracking state transitions with times (s since start). */
  #logEvent(e) {
    if (!TUNING.debug) return;
    const log = (this._events ??= []);
    log.push(`${this.clock.elapsedTime.toFixed(1)}s ${e}`);
    if (log.length > 4) log.shift();
    this.stats.events = log.join(' → ');
  }

  /** Number of the tracker's template points that project inside the camera frame for this pose. */
  #visibleTrackPoints(c, mv, index) {
    const kf = c.tracker.trackingKeyframeList[index];
    if (!kf) return 0;
    const P = c.projectionTransform;
    const w = c.inputWidth;
    const h = c.inputHeight;
    let n = 0;
    for (const p of kf.points) {
      const X = p.x / kf.scale;
      const Y = p.y / kf.scale;
      const z = mv[2][0] * X + mv[2][1] * Y + mv[2][3];
      if (z <= 0) continue;
      const u = (P[0][0] * (mv[0][0] * X + mv[0][1] * Y + mv[0][3])) / z + P[0][2];
      const v = (P[1][1] * (mv[1][0] * X + mv[1][1] * Y + mv[1][3])) / z + P[1][2];
      if (u >= 0 && u < w && v >= 0 && v < h) n++;
    }
    return n;
  }

  /** Diagnostics only (?debug&drift=1): knock the tracker's pose off by 15% of the image every 3 s. */
  #debugKick(mv) {
    const now = performance.now();
    if (now - (this._kickAt ?? now) < 3000) {
      this._kickAt ??= now;
      return;
    }
    this._kickAt = now;
    const shift = 0.15 * (this.targets[0]?.width ?? 1000);
    mv[0][3] += shift;
    mv[1][3] += shift * 0.5;
  }

  #noteTrackQuality(ratio, matched) {
    const q = (this._quality ??= { sum: 0, n: 0, min: 1, matched: 0 });
    q.sum += ratio;
    q.n += 1;
    q.min = Math.min(q.min, ratio);
    q.matched += matched;
  }

  #onControllerUpdate(data) {
    if (data.type === 'processDone') {
      this._trackFrames++;
      this._frameTracked = false;
      this._processDone?.();
      return;
    }
    if (data.type !== 'updateMatrix' || this.stopped) return;

    const { worldMatrix, targetIndex = 0 } = data;
    if (worldMatrix) {
      // Another image was recognised while the previous one is still within
      // its miss tolerance: start a new lock on the new image.
      if (this.tracking && targetIndex !== this.activeTarget) this.tracking = false;
      // Missed frame (MindAR re-reports the previous pose): keep predicting
      // from the last real measurement instead of treating it as "stopped".
      if (this.tracking && !this._frameTracked) return;
      if (!this.tracking) this.activeTarget = targetIndex;
      this._trackedMatrix.fromArray(worldMatrix).multiply(this.targets[targetIndex].post);
      this._trackedMatrix.decompose(this._rawP, this._rawQ, this._rawS);
      if (TUNING.noise) this.#addTestNoise(TUNING.noise);
      this._gyro?.observe(this._inputT, this._rawQ);
      if (!this.tracking) {
        this._stabInit = false; // first frame of a lock: no history
        this._seg++;
      }
      this.#stabilisePose(this._trackedMatrix);
      this.#updatePrediction(this.tracking);
      this.#recordPose();
      if (!this.tracking) {
        this.tracking = true;
        this._snapPose = true;
        this.everFound = true;
        this.#logEvent(`TRACKING art ${targetIndex}`);
        this.onTrackingChange?.({ type: 'found', targetIndex });
      }
    } else if (this.tracking && targetIndex === this.activeTarget) {
      // Lost: hide immediately. Content only ever appears where the image is.
      this.tracking = false;
      this.#logEvent('LOST');
      this.onTrackingChange?.({ type: 'searching', targetIndex });
    }
  }

  /** Adaptive pose smoothing (see ROT_* and POS_* above), in place. */
  #stabilisePose(m) {
    m.decompose(this._sp, this._sq, this._ss);
    if (TUNING.debug) {
      this.#recordWobble(this._wobble.raw, m);
      // Raw pose log for offline analysis (?debug only).
      const log = (window.__webarPoseLog ??= []);
      if (log.length < 5000) log.push({ t: performance.now(), p: this._sp.toArray(), q: this._sq.toArray() });
    }
    const t = this._inputT || performance.now() / 1000; // camera frame time
    if (!this._stabInit) {
      this._pS.copy(this._sp);
      this._qS.copy(this._sq);
      this._sS.copy(this._ss);
      this._stabInit = true;
    } else {
      const dt = Math.min(0.2, t - this._stabT);
      const { smoothstep, lerp, radToDeg } = THREE.MathUtils;
      const rotDeg = radToDeg(this._qS.angleTo(this._sq));
      const rotRate = lerp(RATE_STILL, RATE_MOVE, smoothstep(rotDeg, ROT_STILL_DEG, ROT_MOVE_DEG));
      const rel = this._pS.distanceTo(this._sp) / Math.max(1e-6, this._sp.length());
      const posRate = lerp(RATE_STILL, RATE_MOVE, smoothstep(rel, POS_STILL, POS_MOVE));
      // Rotation and translation are coupled for a tracked plane: move them
      // together at the faster rate so the content never drifts off the image.
      const k = 1 - Math.exp(-Math.max(rotRate, posRate) * dt);
      this._qS.slerp(this._sq, k);
      this._pS.lerp(this._sp, k);
      this._sS.lerp(this._ss, k);
    }
    this._stabT = t;
    if (TUNING.stabilise === false) return; // ?debug&stab=0 (A/B diagnostics)
    m.compose(this._pS, this._qS, this._sS);
  }

  /** Record the latest tracked pose and update the smoothed velocity estimate. */
  #updatePrediction(continuing) {
    const t = this._inputT || performance.now() / 1000;
    const m = this._trackedMatrix;
    m.decompose(this._sp, this._sq, this._ss);
    const dt = t - this._predT;
    if (continuing && this._hasPred && dt > 0.005 && dt < 0.25) {
      const a = VELOCITY_SMOOTHING;
      this._tmpVel.subVectors(this._sp, this._predP).divideScalar(dt);
      this._vel.multiplyScalar(1 - a).addScaledVector(this._tmpVel, a);
      // Angular velocity: rotation from the previous to the new orientation.
      const dq = this._tmpQ.copy(this._sq).multiply(this._predQ.invert());
      if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
      const angle = 2 * Math.acos(Math.min(1, dq.w));
      const sinHalf = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
      if (sinHalf > 1e-6) this._tmpVel.set(dq.x, dq.y, dq.z).multiplyScalar(angle / sinHalf / dt);
      else this._tmpVel.set(0, 0, 0);
      this._angVel.multiplyScalar(1 - a).addScaledVector(this._tmpVel, a);
    } else {
      this._vel.set(0, 0, 0);
      this._angVel.set(0, 0, 0);
    }
    this._predP.copy(this._sp);
    this._predQ.copy(this._sq);
    this._predS.copy(this._ss);
    this._predT = t;
    this._hasPred = true;
  }

  /**
   * Store the (stabilised) pose of the frame just tracked, and adapt the
   * display delay: a frame can only be shown once a tracker result at or after
   * it exists, i.e. the delay must cover the time from one tracked frame's
   * capture to the arrival of the next result. Rises fast, decays slowly.
   */
  #recordPose() {
    const P = this._poses;
    const t = this._inputT;
    const last = P[P.length - 1];
    if (last && t <= last.t) return; // same frame reported twice
    const now = performance.now() / 1000;
    if (last && last.seg === this._seg) {
      const need = Math.min(MAX_DELAY_S, now - last.t + DELAY_MARGIN_S);
      this._delay += (need - this._delay) * (need > this._delay ? 0.5 : 0.02);
      this._delay = Math.max(MIN_DELAY_S, this._delay);
    }
    const entry =
      P.length >= POSE_HISTORY
        ? P.shift()
        : {
            p: new THREE.Vector3(),
            q: new THREE.Quaternion(),
            s: new THREE.Vector3(),
            rp: new THREE.Vector3(),
            rq: new THREE.Quaternion(),
            rs: new THREE.Vector3(),
          };
    entry.t = t;
    entry.seg = this._seg;
    entry.target = this.activeTarget;
    entry.p.copy(this._predP); // causally stabilised (live fallback, A/B)
    entry.q.copy(this._predQ);
    entry.s.copy(this._predS);
    entry.rp.copy(this._rawP); // raw tracker pose (centred fit)
    entry.rq.copy(this._rawQ);
    entry.rs.copy(this._rawS);
    P.push(entry);
  }

  /**
   * Weighted local-linear fit of the raw poses of segment `seg` around time t
   * (see FIT_SIGMA_*). Rotation is fitted as rotation vectors relative to the
   * sample nearest t. Writes the pose at t into `out`.
   *
   * With the gyroscope calibrated, poses are first expressed in a world frame
   * (the phone's own rotation removed): there the artwork's orientation is
   * constant, so rotation is averaged over a much longer window, and camera
   * turns no longer count as motion for position either. The result is
   * rotated back with the exact gyroscope orientation of the displayed frame.
   */
  #fitPose(t, seg, out) {
    const P = this._poses;
    const F = this._fit;
    const gyro = this._gyro?.enabled ? this._gyro : null;
    let ref = null;
    let best = Infinity;
    for (const e of P) {
      if (e.seg !== seg) continue;
      e.wp ??= new THREE.Vector3();
      e.wq ??= new THREE.Quaternion();
      if (gyro) {
        gyro.orientationAt(e.t - gyro.lag, undefined, F.g);
        e.wq.copy(F.g).multiply(e.rq);
        e.wp.copy(e.rp).applyQuaternion(F.g);
      } else {
        e.wq.copy(e.rq);
        e.wp.copy(e.rp);
      }
      const d = Math.abs(e.t - t);
      if (d < best) {
        best = d;
        ref = e;
      }
    }
    if (!ref) return false;
    this.displayTarget = ref.target;
    F.qInv.copy(ref.wq).invert();
    const { smoothstep, lerp, degToRad } = THREE.MathUtils;
    let sigmaP = FIT_SIGMA_MOVE;
    let sigmaR = FIT_SIGMA_MOVE;
    let movingP = 1;
    let movingR = 1;
    for (let pass = 0; pass < 2; pass++) {
      const SP = [0, 0, 0];
      const SR = [0, 0, 0];
      F.p0.set(0, 0, 0);
      F.p1.set(0, 0, 0);
      F.r0.set(0, 0, 0);
      F.r1.set(0, 0, 0);
      F.s0.set(0, 0, 0);
      const reach = 2.5 * Math.max(sigmaP, sigmaR);
      for (const e of P) {
        if (e.seg !== seg) continue;
        const x = e.t - t;
        if (x < -reach || x > reach) continue;
        const wP = Math.exp(-0.5 * (x / sigmaP) ** 2);
        const wR = Math.exp(-0.5 * (x / sigmaR) ** 2);
        // Rotation vector of ref^-1 * q.
        F.dq.copy(F.qInv).multiply(e.wq);
        if (F.dq.w < 0) F.dq.set(-F.dq.x, -F.dq.y, -F.dq.z, -F.dq.w);
        const sinHalf = Math.sqrt(Math.max(0, 1 - F.dq.w * F.dq.w));
        const angle = 2 * Math.atan2(sinHalf, F.dq.w);
        F.r.set(F.dq.x, F.dq.y, F.dq.z).multiplyScalar(sinHalf > 1e-9 ? angle / sinHalf : 2);
        SP[0] += wP;
        SP[1] += wP * x;
        SP[2] += wP * x * x;
        SR[0] += wR;
        SR[1] += wR * x;
        SR[2] += wR * x * x;
        F.p0.addScaledVector(e.wp, wP);
        F.p1.addScaledVector(e.wp, wP * x);
        F.s0.addScaledVector(e.rs, wP);
        F.r0.addScaledVector(F.r, wR);
        F.r1.addScaledVector(F.r, wR * x);
      }
      if (SP[0] <= 0 || SR[0] <= 0) return false;
      // Value at t: a = (S2*Y0 - S1*Y1)/det; slope: b = (S0*Y1 - S1*Y0)/det.
      // Blends towards the weighted mean as motion stops (final pass).
      const fitInto = (S, a, b, y0, y1, moving) => {
        const det = S[0] * S[2] - S[1] * S[1];
        if (det > 1e-12 * Math.max(1, S[0] * S[0])) {
          a.copy(y0).multiplyScalar(S[2]).addScaledVector(y1, -S[1]).divideScalar(det);
          if (pass === 1 && moving < 1 && TUNING.fitMean !== false) a.lerp(this._fitMean.copy(y0).divideScalar(S[0]), 1 - moving);
          b.copy(y1).multiplyScalar(S[0]).addScaledVector(y0, -S[1]).divideScalar(det);
        } else {
          a.copy(y0).divideScalar(S[0]);
          b.set(0, 0, 0);
        }
      };
      if (pass === 0) {
        // Speed from a short-window fit picks the windows for the final fit.
        fitInto(SP, F.a, F.b, F.p0, F.p1, 1);
        const rel = F.b.length() / Math.max(1e-6, F.a.length());
        fitInto(SR, F.a, F.b, F.r0, F.r1, 1);
        const rot = F.b.length();
        movingP = smoothstep(rel, 0.03, 0.3);
        movingR = smoothstep(rot, degToRad(4), degToRad(40));
        if (gyro) {
          // World frame: only real translation moves the position, and the
          // artwork's orientation should not change at all.
          sigmaP = lerp(FIT_SIGMA_STILL, FIT_SIGMA_MOVE, movingP);
          sigmaR = lerp(FIT_SIGMA_GYRO_ROT, FIT_SIGMA_STILL, movingR);
        } else {
          const moving = Math.max(movingP, movingR);
          movingP = moving;
          movingR = moving;
          sigmaP = lerp(TUNING.sigS ?? FIT_SIGMA_STILL, TUNING.sigM ?? FIT_SIGMA_MOVE, moving);
          sigmaR = sigmaP;
        }
        continue;
      }
      fitInto(SP, this._gp, F.b, F.p0, F.p1, movingP);
      fitInto(SR, F.a, F.b, F.r0, F.r1, movingR);
      const angle = F.a.length();
      if (angle > 1e-9) this._gq.setFromAxisAngle(F.a.divideScalar(angle), angle);
      else this._gq.identity();
      this._gq.premultiply(ref.wq);
      this._gs.copy(F.s0).divideScalar(SP[0]);
    }
    if (gyro) {
      // Back to the camera frame of the displayed frame.
      gyro.orientationAt(t - gyro.lag, undefined, F.g).invert();
      this._gq.premultiply(F.g);
      this._gp.applyQuaternion(F.g);
    }
    out.compose(this._gp, this._gq, this._gs);
    return true;
  }

  /**
   * Content pose for the camera frame captured at time t: interpolated between
   * the tracked frames around it; extrapolated briefly past the newest result
   * while tracking continues. Returns false when the image was not tracked in
   * that frame (content must not be shown there).
   */
  #poseAt(t, out) {
    const P = this._poses;
    if (!P.length || t < P[0].t - 0.002) return false;
    const last = P[P.length - 1];
    const fit = this._delayed && TUNING.fit !== false;
    if (t >= last.t) {
      if (last.seg !== this._seg || (!this.tracking && t > last.t + 0.002)) return false;
      // No tracker result for this frame yet (tracker stalled: blur, re-detection,
      // a busy phone). Showing the last pose would freeze the content while the
      // camera image moves on (a doubled image): hide it until poses resume.
      if (t - last.t > STALE_BRIDGE_S && TUNING.staleHide !== false) return false;
      if (fit) return this.#fitPose(Math.min(t, last.t + STALE_BRIDGE_S), last.seg, out);
      this.displayTarget = last.target;
      const h = TUNING.predict === false ? 0 : Math.min(STALE_BRIDGE_S, t - last.t);
      this._gp.copy(last.p).addScaledVector(this._vel, h);
      this._gq.copy(last.q);
      const w = this._angVel.length();
      if (w * h > 1e-6) {
        this._tmpVel.copy(this._angVel).divideScalar(w);
        this._gq.premultiply(this._tmpQ.setFromAxisAngle(this._tmpVel, w * h));
      }
      out.compose(this._gp, this._gq, last.s);
      return true;
    }
    let i = P.length - 2;
    while (i > 0 && P[i].t > t) i--;
    const a = P[i];
    const b = P[i + 1];
    if (a.seg !== b.seg) return false; // image was lost between these frames
    if (fit) return this.#fitPose(t, a.seg, out);
    this.displayTarget = a.target;
    const f = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 1;
    this._gp.lerpVectors(a.p, b.p, f);
    this._gq.slerpQuaternions(a.q, b.q, f);
    this._gs.lerpVectors(a.s, b.s, f);
    out.compose(this._gp, this._gq, this._gs);
    return true;
  }

  /** Diagnostics only (?debug&noise=): perturb the raw pose like a noisy real camera would. */
  #addTestNoise(deg) {
    const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.41; // ~N(0,1)
    const a = THREE.MathUtils.degToRad(deg);
    this._tmpVel.set(g(), g(), g()).multiplyScalar(a);
    const ang = this._tmpVel.length();
    if (ang > 0) this._rawQ.premultiply(this._tmpQ.setFromAxisAngle(this._tmpVel.divideScalar(ang), ang));
    const d = this._rawP.length() * (deg / 800);
    this._rawP.x += g() * d;
    this._rawP.y += g() * d;
    this._rawP.z += g() * d;
    this._trackedMatrix.compose(this._rawP, this._rawQ, this._rawS);
  }

  /** Screen position (px) of a point in front of the image, for the wobble diagnostic. */
  #recordWobble(list, m) {
    if (!this.renderer) return;
    const p = this._probe.copy(WOBBLE_PROBE).applyMatrix4(m).project(this.camera);
    const { width, height } = this.renderer.domElement;
    list.push([p.x * width * 0.5, p.y * height * 0.5]);
  }

  /* ---------------------------------------------------------------- pose */

  /** Show the content facing the camera, sized to fill the screen (independent of tracking). */
  setFullscreen(on) {
    if (this.fullscreen === on) return;
    this.fullscreen = on;
    this._blendUntil = this.clock.elapsedTime + 0.6;
    if (on && !this.tracking) this._snapPose = true;
    this.onModeChange?.({ fullscreen: on });
  }

  #fullscreenMatrix() {
    // Fit the target rectangle inside the viewport with a small margin.
    const { camera } = this;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const fitWidth = 1 / (2 * tanHalf * camera.aspect);
    const fitHeight = this.targetAspect / (2 * tanHalf);
    const dist = Math.max(fitWidth, fitHeight) * 1.08 * this.targetWidth;
    return this._goal.compose(this._tmpPos.set(0, 0, -dist), IDENTITY_QUAT, this._tmpScale.setScalar(this.targetWidth));
  }

  /** @param {number} frameT capture time of the camera frame on screen (s). */
  #updatePose(dt, frameT) {
    let goal;
    let exact = false;
    if (this.fullscreen) {
      goal = this.#fullscreenMatrix();
    } else if (this.#poseAt(frameT, this._goal)) {
      // The pose of exactly the frame on screen; not smoothed again here.
      goal = this._goal;
      exact = true;
    } else {
      // No pose for this frame: fade out at the last shown pose.
      this.#fade(dt, false);
      return;
    }

    goal.decompose(this._gp, this._gq, this._gs);
    const blending = this.clock.elapsedTime < this._blendUntil;
    if (this._snapPose || (exact && !blending)) {
      this._cp.copy(this._gp);
      this._cq.copy(this._gq);
      this._cs.copy(this._gs);
      this._snapPose = false;
    } else {
      // Glide only for full-screen transitions.
      const k = 1 - Math.exp(-dt * 9);
      this._cp.lerp(this._gp, k);
      this._cq.slerp(this._gq, k);
      this._cs.lerp(this._gs, k);
    }
    this.anchor.matrix.compose(this._cp, this._cq, this._cs);
    this.anchor.matrixWorldNeedsUpdate = true;
    if (TUNING.debug) {
      this.stats.anchor = `pos ${this._cp.toArray().map((v) => (v / this.targetWidth).toFixed(2)).join(',')} rot ${new THREE.Euler()
        .setFromQuaternion(this._cq)
        .toArray()
        .slice(0, 3)
        .map((v) => Math.round(THREE.MathUtils.radToDeg(v)))
        .join(',')}°`;
      this.#updateWireframe();
    }
    if (TUNING.debug && exact) {
      this.#recordWobble(this._wobble.shown, this.anchor.matrix);
      if (frameT !== this._jerkT) {
        this._jerkT = frameT;
        this.#recordWobble(this._jerk, this.anchor.matrix);
      }
    }
    this.#fade(dt, true);
  }

  /**
   * Fade the anchored content in or out (FADE_S) instead of popping it, so a
   * brief loss and re-lock feels continuous. Only the fade level is tracked
   * here; it is applied per draw in #drawScene and never stored in materials
   * (content animates its own opacity, e.g. the reveal).
   */
  #fade(dt, show) {
    const target = show ? 1 : 0;
    const prev = this._fadeV ?? 0;
    this._fadeV = prev < target ? Math.min(target, prev + dt / FADE_S) : Math.max(target, prev - dt / FADE_S);
    this.anchor.visible = this._fadeV > 0.001;
  }

  /** Render the AR scene, temporarily multiplying content opacity by the fade level. */
  #drawScene() {
    const v = this.fullscreen ? 1 : (this._fadeV ?? 1);
    if (v >= 0.999) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const saved = (this._fadeSaved ??= []);
    saved.length = 0;
    this.anchor.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        saved.push(m, m.opacity, m.transparent);
        m.opacity *= v;
        if (!m.transparent) {
          m.transparent = true;
          m.needsUpdate = true;
        }
      }
    });
    this.renderer.render(this.scene, this.camera);
    for (let i = 0; i < saved.length; i += 3) {
      const m = saved[i];
      m.opacity = saved[i + 1];
      if (m.transparent !== saved[i + 2]) {
        m.transparent = saved[i + 2];
        m.needsUpdate = true;
      }
    }
  }

  /** Debug wireframe (?debug&wire=1): exact target rectangle + diagonals, on the anchor. */
  #updateWireframe() {
    if (!TUNING.wire) return;
    if (!this._wire) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(30).fill(0), 3));
      this._wire = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x00ff66, depthTest: false, transparent: true }));
      this._wire.renderOrder = 999;
      this.anchor.add(this._wire);
    }
    const h = this.targetAspect / 2;
    const P = [[-0.5, h], [0.5, h], [0.5, h], [0.5, -h], [0.5, -h], [-0.5, -h], [-0.5, -h], [-0.5, h], [-0.5, h], [0.5, -h]];
    const pos = this._wire.geometry.attributes.position;
    P.forEach(([x, y], i) => pos.setXYZ(i, x, y, 0.001));
    pos.needsUpdate = true;
  }

  #onVideoResize = null;

  /** Rebuild the tracker if the camera stream dimensions change (device rotation). */
  async #handleVideoResize() {
    const { video, controller } = this;
    if (!video || !controller || this.stopped) return;
    if (video.videoWidth === this._videoW && video.videoHeight === this._videoH) {
      this.resize();
      return;
    }
    await this.#disposeController();
    if (this.stopped) return;
    this.#disposeFrames(); // new frame size
    this._poses = [];
    this._snapT = 0;
    if (this.tracking) {
      this.tracking = false;
      this.onTrackingChange?.({ type: 'searching', targetIndex: this.activeTarget });
    }
    await this.#buildController();
  }

  /**
   * Fit the video to cover the container and derive a three.js camera whose
   * projection matches MindAR's (port of MindARThree.resize). The WebGL camera
   * background uses the same cover crop as the <video> element.
   */
  resize() {
    const { video, controller, container, camera, renderer } = this;
    if (!video || !controller || !renderer) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;

    const videoRatio = video.videoWidth / video.videoHeight;
    const containerRatio = cw / ch;
    let vw;
    let vh;
    if (videoRatio > containerRatio) {
      vh = ch;
      vw = vh * videoRatio;
    } else {
      vw = cw;
      vh = vw / videoRatio;
    }

    // MindAR's projection is defined for the tracker input's aspect ratio and
    // does not depend on its resolution (the input is a scaled copy of the video).
    const proj = controller.getProjectionMatrix();
    const inputRatio = controller.inputWidth / controller.inputHeight;
    const projectedHeight = inputRatio > containerRatio ? ch : (cw / controller.inputWidth) * controller.inputHeight;
    const fovRatio = ch / projectedHeight;

    camera.fov = (2 * Math.atan((1 / proj[5]) * fovRatio) * 180) / Math.PI;
    camera.near = proj[14] / (proj[10] - 1);
    camera.far = proj[14] / (proj[10] + 1);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();

    Object.assign(video.style, {
      top: `${-(vh - ch) / 2}px`,
      left: `${-(vw - cw) / 2}px`,
      width: `${vw}px`,
      height: `${vh}px`,
    });

    // Same cover crop for the WebGL camera background.
    const rx = cw / vw;
    const ry = ch / vh;
    this.bgMesh.material.uniforms.uCrop.value.set(rx, ry, (1 - rx) / 2, (1 - ry) / 2);

    renderer.setSize(cw, ch, true);
  }

  #render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);

    // Delayed mode: show the newest buffered camera frame that is at least
    // `delay` old (the tracker has analysed a frame at or after it by then).
    // Otherwise the live <video> under the canvas is visible.
    const now = performance.now() / 1000;
    let frame = null;
    if (this._delayed && this._frames.length) {
      const target = now - this._delay;
      frame = this._frames[0];
      for (const f of this._frames) if (f.t <= target) frame = f;
      this.bgMesh.material.uniforms.map.value = frame.rt.texture;
    }
    this.stats.delayMs = frame ? Math.round((now - frame.t) * 1000) : 0;
    this.stats.target = this.displayTarget;
    this.stats.gyro = this._gyro ? `${this._gyro.state}${this._gyro.lastScore !== undefined ? ` ${this._gyro.lastScore.toFixed(2)}` : ''}` : 'off';
    if (frame && frame.t !== this._shownT) {
      this._shownT = frame.t;
      this._viewFrames++;
    }

    this.#updatePose(dt, frame ? frame.t : now);
    if (this.clock.elapsedTime - this._statsAt >= 1) {
      this.stats.trackFps = Math.round(this._trackFrames / (this.clock.elapsedTime - this._statsAt));
      const q = this._quality;
      this.stats.quality = q?.n ? `${Math.round((q.sum / q.n) * 100)}% min ${Math.round(q.min * 100)}% n${Math.round(q.matched / q.n)}` : '-';
      this._quality = null;
      this.stats.viewFps = Math.round(this._viewFrames / (this.clock.elapsedTime - this._statsAt));
      this._viewFrames = 0;
      // Wobble: standard deviation (px) of a point in front of the image over the
      // last second. With the phone held still, this is pure tracking noise.
      const sd = (pts) => {
        if (pts.length < 3) return 0;
        const mx = pts.reduce((a, q) => a + q[0], 0) / pts.length;
        const my = pts.reduce((a, q) => a + q[1], 0) / pts.length;
        const v = pts.reduce((a, q) => a + (q[0] - mx) ** 2 + (q[1] - my) ** 2, 0) / pts.length;
        return +Math.sqrt(v).toFixed(1);
      };
      this.stats.wobbleRaw = sd(this._wobble.raw);
      this.stats.wobbleShown = sd(this._wobble.shown); // what is actually drawn (incl. prediction)
      this._wobble = { raw: [], shown: [] };
      // Jerk: RMS second difference (px) of the probe over consecutive
      // displayed camera frames. Smooth real motion gives ~0, so this measures
      // wobble while the camera moves.
      const J = this._jerk;
      let jsum = 0;
      for (let k = 2; k < J.length; k++) {
        jsum += (J[k][0] - 2 * J[k - 1][0] + J[k - 2][0]) ** 2 + (J[k][1] - 2 * J[k - 1][1] + J[k - 2][1]) ** 2;
      }
      this.stats.jerk = J.length > 2 ? +Math.sqrt(jsum / (J.length - 2)).toFixed(1) : 0;
      this._jerk = [];
      this._trackFrames = 0;
      this._statsAt = this.clock.elapsedTime;
    }
    this.onFrame?.(dt, this.clock.elapsedTime);

    const r = this.renderer;
    r.clear();
    if (frame) r.render(this.bgScene, this.bgCamera);
    this.#drawScene();
  }

  /** Raycast helper for tap interactions on anchored content. */
  pick(clientX, clientY, objects) {
    if (!this.renderer || !this.anchor.visible) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster.intersectObjects(objects, true)[0] ?? null;
  }

  async #disposeController() {
    const { controller } = this;
    if (!controller) return;
    this.controller = null;
    controller.stopProcessVideo();
    // Let the in-flight frame finish so its tensors are released.
    await new Promise((resolve) => {
      this._processDone = resolve;
      setTimeout(resolve, 600);
    });
    this._processDone = null;
    try {
      controller.dispose();
      controller.worker?.terminate();
    } catch {
      // ignore
    }
  }

  /** Stop tracking, release the camera and free GPU resources. Idempotent. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;

    this.renderer?.setAnimationLoop(null);
    this._gyro?.stop();
    this.resizeObserver?.disconnect();
    if (this.video && this.#onVideoResize) this.video.removeEventListener('resize', this.#onVideoResize);

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    await this.#disposeController();

    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }

    this.#disposeFrames();
    for (const mesh of [this.bgMesh, this.copyMesh]) {
      mesh?.geometry.dispose();
      mesh?.material.dispose();
    }
    this.videoTexture?.dispose();

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.scene.clear();
    this.clock.stop();

    if (activeSession === this) activeSession = null;
  }
}
