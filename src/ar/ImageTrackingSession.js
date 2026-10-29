import * as THREE from 'three';
import { ARError, classifyCameraError } from './environment.js';
import { loadMindAR } from './loadMindAR.js';

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
// Motion prediction. The live camera is shown at full frame rate; each tracker
// result describes a frame that is already some tens of ms old, so the pose is
// extrapolated with the measured velocity to the moment of display. Capped so
// a missed frame can never send content flying.
const MAX_PREDICT_S = 0.12;
const VELOCITY_SMOOTHING = 0.55; // weight of the newest velocity sample
// Point used for the wobble diagnostic: 0.15 image widths in front of the centre.
const WOBBLE_PROBE = new THREE.Vector3(0, 0, 0.15);
// The tracker analyses a downscaled copy of the camera frame (long side in px).
// MindAR's projection is resolution-independent, so this is ~45% less work per
// frame than 720p with no loss of alignment; the display stays at full 720p.
const PROCESS_LONG_SIDE = 960;

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
    stabilise: q.get('stab') !== '0',
    // &sync=1: show only tracker-analysed frames (perfect alignment, choppy at low tracker fps).
    sync: q.get('sync') === '1',
    predict: q.get('predict') !== '0',
    maxPredict: num('maxp'),
  };
})();

/**
 * Real image-target tracking session: camera feed + MindAR Controller +
 * three.js renderer. Content added to `session.anchor` is rendered in the
 * target's coordinate space:
 *   - origin at the centre of the target image
 *   - +X right, +Y up, +Z out of the image towards the viewer
 *   - 1 unit = the target image's width (height = targetHeight / targetWidth)
 *
 * Smooth rendering: the live camera video is always shown at its full frame
 * rate, independent of how fast the tracker runs on the device. The content
 * pose from each tracker frame is extrapolated (velocity prediction) to the
 * moment of display, so content keeps up with the image while the phone moves.
 * (A frame-synchronised mode, which shows only tracker-analysed frames, is
 * kept for diagnostics: ?debug&sync=1.)
 */
export class ImageTrackingSession {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container Full-size element that will host the video and canvas.
   * @param {ArrayBuffer} opts.mindBuffer Compiled `.mind` target data.
   * @param {(e: {type: 'found'|'searching'}) => void} [opts.onTrackingChange]
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
    this.targetAspect = 1;
    this.targetWidth = 1;
    this._postMatrix = new THREE.Matrix4();
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
    this._displayMatrix = new THREE.Matrix4(); // pose belonging to the displayed camera frame
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

    // Frame sync state.
    this._hasSyncedFrame = false;
    this._synced = false;

    /** Diagnostics: tracker frames processed per second. */
    this.stats = { trackFps: 0, wobbleRaw: 0, wobbleShown: 0, trackLevel: 'coarse' };
    this._trackFrames = 0;
    this._statsAt = 0;
  }

  /** True while the image is actually being tracked by the camera. */
  get isTracking() {
    return this.tracking;
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
    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bgTexture = new THREE.CanvasTexture(document.createElement('canvas'));
    this.bgTexture.colorSpace = THREE.SRGBColorSpace;
    this.bgTexture.minFilter = THREE.LinearFilter;
    this.bgTexture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map: this.bgTexture, depthTest: false, depthWrite: false, toneMapped: false });
    this.bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.bgScene.add(this.bgMesh);
  }

  /**
   * Tracker finished a frame: show that exact frame together with its pose.
   * MindAR draws every analysed frame (RGB, at the tracker input size) into its
   * input canvas; we display that canvas and upload it to the GPU right now,
   * before the next frame overwrites it. No extra copies of the video.
   */
  #promoteFrame(tracked) {
    // Tracker missed this frame (fast motion/blur) but still reports its last
    // pose for up to missTolerance frames: pairing that stale pose with a new
    // camera frame would make content slip off the image. Keep showing the last
    // tracked frame and its pose instead (a brief hold, already on the GPU).
    if (this.tracking && !tracked && this._hasSyncedFrame) return;
    const canvas = this.controller?.inputLoader?.context?.canvas;
    if (!canvas || !this.renderer) return;
    if (this.bgTexture.image !== canvas) this.bgTexture.image = canvas;
    this.bgTexture.needsUpdate = true;
    this.renderer.initTexture(this.bgTexture);
    this._hasSyncedFrame = true;
    if (this.tracking) this._displayMatrix.copy(this._trackedMatrix);
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

    const { dimensions, trackingDataList } = this.controller.addImageTargetsFromBuffer(this.mindBuffer.slice(0));
    if (!dimensions?.length) {
      throw new ARError('engine', 'The image target data is invalid or was compiled with an incompatible version.');
    }
    // Timestamp each analysed camera frame (for motion prediction).
    const loader = this.controller.inputLoader;
    const loadInput = loader.loadInput.bind(loader);
    let freshFrame = true;
    loader.loadInput = (v) => {
      this._inputT = performance.now() / 1000;
      freshFrame = false;
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
    const [w, h] = dimensions[0];
    this.targetAspect = h / w;
    this.targetWidth = w;
    // MindAR reports poses in target-pixel units with the origin at the
    // bottom-left corner; re-centre and normalise so 1 unit = target width.
    this._postMatrix.compose(new THREE.Vector3(w / 2, h / 2, 0), new THREE.Quaternion(), new THREE.Vector3(w, w, w));

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
    const minSide = Math.min(dimensions[0][0], dimensions[0][1]);
    const focal = c.projectionTransform[0][0];
    let level = 1;
    const trackAndUpdate = c._trackAndUpdate.bind(c);
    // Also records whether this frame was actually tracked (vs. a miss that
    // MindAR bridges by re-reporting the previous pose).
    c._trackAndUpdate = async (input, modelView, index) => {
      if (fine) {
        const depth = modelView[2][3];
        const apparent = depth > 0 ? (focal * minSide) / depth : 0;
        if (level === 1 && apparent > FINE_ENTER_PX) level = 0;
        else if (level === 0 && apparent < FINE_EXIT_PX) level = 1;
        c.tracker = level === 0 ? fine : coarse;
        this.stats.trackLevel = level === 0 ? 'fine' : 'coarse';
      }
      const result = await trackAndUpdate(input, modelView, index);
      if (result) this._frameTracked = true;
      return result;
    };
  }

  #onControllerUpdate(data) {
    if (data.type === 'processDone') {
      this._trackFrames++;
      if (TUNING.sync) this.#promoteFrame(this._frameTracked);
      this._frameTracked = false;
      this._processDone?.();
      return;
    }
    if (data.type !== 'updateMatrix' || this.stopped) return;

    const { worldMatrix } = data;
    if (worldMatrix) {
      // Missed frame (MindAR re-reports the previous pose): keep predicting
      // from the last real measurement instead of treating it as "stopped".
      if (this.tracking && !this._frameTracked) return;
      this._trackedMatrix.fromArray(worldMatrix).multiply(this._postMatrix);
      if (!this.tracking) this._stabInit = false; // first frame of a lock: no history
      this.#stabilisePose(this._trackedMatrix);
      this.#updatePrediction(this.tracking);
      if (!this.tracking) {
        this.tracking = true;
        this._snapPose = true;
        this.everFound = true;
        this.onTrackingChange?.({ type: 'found' });
      }
    } else if (this.tracking) {
      // Lost: hide immediately. Content only ever appears where the image is.
      this.tracking = false;
      this.onTrackingChange?.({ type: 'searching' });
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
    const t = performance.now() / 1000;
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

  /** Tracked pose extrapolated to now (the camera frame currently on screen). */
  #predictedMatrix(out) {
    const h = TUNING.predict === false ? 0 : Math.min(TUNING.maxPredict ?? MAX_PREDICT_S, Math.max(0, performance.now() / 1000 - this._predT));
    this._gp.copy(this._predP).addScaledVector(this._vel, h);
    const w = this._angVel.length();
    this._gq.copy(this._predQ);
    if (w * h > 1e-6) {
      this._tmpVel.copy(this._angVel).divideScalar(w);
      this._gq.premultiply(this._tmpQ.setFromAxisAngle(this._tmpVel, w * h));
    }
    return out.compose(this._gp, this._gq, this._predS);
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

  #updatePose(dt) {
    let goal;
    let exact = false;
    if (this.fullscreen) {
      goal = this.#fullscreenMatrix();
    } else if (this.tracking) {
      // Live video: tracked pose predicted to now. Synced (diagnostic): the
      // pose of the exact frame on screen. Neither is smoothed again here.
      goal = this._synced ? this._goal.copy(this._displayMatrix) : this.#predictedMatrix(this._goal);
      exact = true;
    } else {
      this.anchor.visible = false;
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
    if (TUNING.debug && exact) this.#recordWobble(this._wobble.shown, this.anchor.matrix);
    this.anchor.visible = true;
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
    if (this.tracking) {
      this.tracking = false;
      this.onTrackingChange?.({ type: 'searching' });
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
    this.bgTexture.repeat.set(rx, ry);
    this.bgTexture.offset.set((1 - rx) / 2, (1 - ry) / 2);

    renderer.setSize(cw, ch, true);
  }

  #render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);

    // Live video at full frame rate (synced display only in the ?debug&sync=1 diagnostic mode).
    const synced = TUNING.sync === true && this.tracking && !this.fullscreen && this._hasSyncedFrame;
    if (synced !== this._synced) {
      this._synced = synced;
      if (this.video) this.video.style.opacity = synced ? '0' : '1';
    }

    this.#updatePose(dt);
    if (this.clock.elapsedTime - this._statsAt >= 1) {
      this.stats.trackFps = Math.round(this._trackFrames / (this.clock.elapsedTime - this._statsAt));
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
      this._trackFrames = 0;
      this._statsAt = this.clock.elapsedTime;
    }
    this.onFrame?.(dt, this.clock.elapsedTime);

    const r = this.renderer;
    r.clear();
    if (this._synced) r.render(this.bgScene, this.bgCamera);
    r.render(this.scene, this.camera);
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

    this.bgMesh?.geometry.dispose();
    this.bgMesh?.material.dispose();
    this.bgTexture?.dispose();

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
