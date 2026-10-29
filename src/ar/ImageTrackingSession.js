import * as THREE from 'three';
import { ARError, classifyCameraError } from './environment.js';
import { loadMindAR } from './loadMindAR.js';

/** Only one camera + tracking session may run at a time. */
let activeSession = null;

const IDENTITY_QUAT = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Tilt stabiliser: the out-of-plane rotation (where the image plane "faces")
// is the least observable part of a single-camera pose of a flat image, and its
// noise makes content that sticks out of the wall wobble. It is smoothed with
// an adaptive rate: strongly when the change is tiny (noise), fast when the
// phone really turns. Position and in-plane rotation stay exact, so content
// remains glued to the print.
const TILT_STILL_DEG = 0.6;
const TILT_MOVE_DEG = 5;
const TILT_RATE_STILL = 4;
const TILT_RATE_MOVE = 45;
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
  return { minCF: num('minCF'), beta: num('beta'), processLongSide: num('proc'), stabilise: q.get('stab') !== '0' };
})();

/**
 * Real image-target tracking session: camera feed + MindAR Controller +
 * three.js renderer. Content added to `session.anchor` is rendered in the
 * target's coordinate space:
 *   - origin at the centre of the target image
 *   - +X right, +Y up, +Z out of the image towards the viewer
 *   - 1 unit = the target image's width (height = targetHeight / targetWidth)
 *
 * Frame-synchronised rendering: while the target is tracked, the camera image
 * on screen is the exact frame the tracker analysed, drawn in WebGL together
 * with the pose computed for that frame. Content therefore never lags or
 * slides relative to the printed image when the phone moves (the whole view
 * is delayed by one tracker frame instead). When not tracking, the live video
 * is shown for the smoothest scanning experience.
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
    this._qc = new THREE.Quaternion();
    this._nRaw = new THREE.Vector3();
    this._nPrevRaw = new THREE.Vector3();
    this._nStab = new THREE.Vector3();
    this._nPrevStab = new THREE.Vector3();
    this._stabInit = false;
    this._stabT = 0;
    this._jitter = { raw: 0, shown: 0, n: 0 };
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

    // Frame sync state.
    this._hasSyncedFrame = false;
    this._synced = false;

    /** Diagnostics: tracker frames processed per second. */
    this.stats = { trackFps: 0, tiltJitterRaw: 0, tiltJitterShown: 0 };
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
  #promoteFrame() {
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
      // Frames needed to confirm a detection before content appears.
      warmupTolerance: 2,
      // Frames the tracker may miss (motion blur) before the target counts as
      // lost. Kept short: content must never linger where the image isn't.
      missTolerance: 3,
      onUpdate: (data) => this.#onControllerUpdate(data),
    });

    const { dimensions } = this.controller.addImageTargetsFromBuffer(this.mindBuffer.slice(0));
    if (!dimensions?.length) {
      throw new ARError('engine', 'The image target data is invalid or was compiled with an incompatible version.');
    }
    const [w, h] = dimensions[0];
    this.targetAspect = h / w;
    this.targetWidth = w;
    // MindAR reports poses in target-pixel units with the origin at the
    // bottom-left corner; re-centre and normalise so 1 unit = target width.
    this._postMatrix.compose(new THREE.Vector3(w / 2, h / 2, 0), new THREE.Quaternion(), new THREE.Vector3(w, w, w));

    this.resize();
    // Compile GPU kernels before the first real frame (can take ~1s).
    this.controller.dummyRun(video);
    if (this.stopped) return;
    this.controller.processVideo(video);
  }

  #onControllerUpdate(data) {
    if (data.type === 'processDone') {
      this._trackFrames++;
      this.#promoteFrame();
      this._processDone?.();
      return;
    }
    if (data.type !== 'updateMatrix' || this.stopped) return;

    const { worldMatrix } = data;
    if (worldMatrix) {
      this._trackedMatrix.fromArray(worldMatrix).multiply(this._postMatrix);
      if (!this.tracking) this._stabInit = false; // first frame of a lock: no history
      this.#stabiliseTilt(this._trackedMatrix);
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

  /** Smooth only the image-plane normal (see TILT_* above), in place. */
  #stabiliseTilt(m) {
    m.decompose(this._sp, this._sq, this._ss);
    this._nRaw.copy(Z_AXIS).applyQuaternion(this._sq);
    const t = performance.now() / 1000;
    if (!this._stabInit) {
      this._nStab.copy(this._nRaw);
      this._nPrevRaw.copy(this._nRaw);
      this._nPrevStab.copy(this._nRaw);
      this._stabInit = true;
    } else {
      const dt = Math.min(0.2, t - this._stabT);
      const deg = THREE.MathUtils.radToDeg(this._nStab.angleTo(this._nRaw));
      const f = THREE.MathUtils.smoothstep(deg, TILT_STILL_DEG, TILT_MOVE_DEG);
      const rate = THREE.MathUtils.lerp(TILT_RATE_STILL, TILT_RATE_MOVE, f);
      this._nStab.lerp(this._nRaw, 1 - Math.exp(-rate * dt)).normalize();
      // diagnostics
      const j = this._jitter;
      j.raw += this._nPrevRaw.angleTo(this._nRaw) ** 2;
      j.shown += this._nPrevStab.angleTo(this._nStab) ** 2;
      j.n++;
      this._nPrevRaw.copy(this._nRaw);
      this._nPrevStab.copy(this._nStab);
    }
    this._stabT = t;
    if (TUNING.stabilise === false) return; // ?debug&stab=0 (A/B diagnostics)
    this._qc.setFromUnitVectors(this._nRaw, this._nStab);
    this._sq.premultiply(this._qc);
    m.compose(this._sp, this._sq, this._ss);
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
      // Synced: use the pose of the frame on screen, unsmoothed (smoothing
      // here would re-introduce lag between the image and the content).
      goal = this._synced ? this._goal.copy(this._displayMatrix) : this._goal.copy(this._trackedMatrix);
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

    // Synced display while tracking; live video otherwise.
    const synced = this.tracking && !this.fullscreen && this._hasSyncedFrame;
    if (synced !== this._synced) {
      this._synced = synced;
      if (this.video) this.video.style.opacity = synced ? '0' : '1';
    }

    this.#updatePose(dt);
    if (this.clock.elapsedTime - this._statsAt >= 1) {
      this.stats.trackFps = Math.round(this._trackFrames / (this.clock.elapsedTime - this._statsAt));
      const j = this._jitter;
      if (j.n) {
        // RMS frame-to-frame change of the image-plane normal, in degrees
        this.stats.tiltJitterRaw = +THREE.MathUtils.radToDeg(Math.sqrt(j.raw / j.n)).toFixed(2);
        this.stats.tiltJitterShown = +THREE.MathUtils.radToDeg(Math.sqrt(j.shown / j.n)).toFixed(2);
      }
      this._jitter = { raw: 0, shown: 0, n: 0 };
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
