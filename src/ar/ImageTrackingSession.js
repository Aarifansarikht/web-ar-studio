import * as THREE from 'three';
import { ARError, classifyCameraError } from './environment.js';
import { loadMindAR } from './loadMindAR.js';

/** Only one camera + tracking session may run at a time. */
let activeSession = null;

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const IDENTITY_QUAT = new THREE.Quaternion();
// Rotates the device frame so the camera looks out of the back of the phone.
const DEVICE_TO_CAMERA = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

/**
 * Real image-target tracking session: camera feed + MindAR Controller +
 * three.js renderer. Content added to `session.anchor` is rendered in the
 * target's coordinate space:
 *   - origin at the centre of the target image
 *   - +X right, +Y up, +Z out of the image towards the viewer
 *   - 1 unit = the target image's width (height = targetHeight / targetWidth)
 */
export class ImageTrackingSession {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container Full-size element that will host the video and canvas.
   * @param {ArrayBuffer} opts.mindBuffer Compiled `.mind` target data.
   * @param {(e: {type: 'found'|'lost'}) => void} [opts.onTrackingChange]
   * @param {(e: {fullscreen: boolean, auto: boolean}) => void} [opts.onModeChange]
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

    // Pose state (allocated once; updated every frame).
    this._trackedMatrix = new THREE.Matrix4();
    this._holdMatrix = new THREE.Matrix4();
    this._holdDeviceQuat = null;
    this._goal = new THREE.Matrix4();
    this._gp = new THREE.Vector3();
    this._gq = new THREE.Quaternion();
    this._gs = new THREE.Vector3();
    this._cp = new THREE.Vector3();
    this._cq = new THREE.Quaternion();
    this._cs = new THREE.Vector3(1, 1, 1);
    this._tmpPos = new THREE.Vector3();
    this._tmpScale = new THREE.Vector3();
    this._relQuat = new THREE.Quaternion();
    this._devQuat = new THREE.Quaternion();
    this._screenQuat = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._orientation = null;
    this._snapPose = false;
    this._blendUntil = 0;
  }

  /** True while the image is actually being tracked by the camera. */
  get isTracking() {
    return this.tracking;
  }

  /** True once the target has been recognised at least once (content then stays visible). */
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
      Object.assign(this.renderer.domElement.style, {
        position: 'absolute',
        inset: '0',
        zIndex: '1',
        touchAction: 'none',
        maxWidth: 'none',
      });
      this.container.appendChild(this.renderer.domElement);

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
        // 720p gives a sharp full-screen feed and steadier tracking at distance.
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
    video.setAttribute('width', video.videoWidth);
    video.setAttribute('height', video.videoHeight);
  }

  async #buildController() {
    const { video } = this;
    this.controller = new this.Controller({
      inputWidth: video.videoWidth,
      inputHeight: video.videoHeight,
      maxTrack: 1,
      // One-Euro filter: a low min-cutoff removes jitter when the phone is
      // still; a high beta lets the pose catch up instantly when it moves.
      // (Beta near 0 makes content lag and "swim" behind the target.)
      filterMinCF: 0.0005,
      filterBeta: 800,
      warmupTolerance: 3,
      missTolerance: 6,
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
    this._postMatrix.compose(
      new THREE.Vector3(w / 2, h / 2, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(w, w, w),
    );

    this.resize();
    // Compile GPU kernels before the first real frame (can take ~1s).
    this.controller.dummyRun(video);
    if (this.stopped) return;
    this.controller.processVideo(video);
  }

  #onControllerUpdate(data) {
    if (data.type === 'processDone') {
      this._processDone?.();
      return;
    }
    if (data.type !== 'updateMatrix' || this.stopped) return;

    const { worldMatrix } = data;
    if (worldMatrix) {
      // Only store the goal pose; #updatePose() eases towards it every frame.
      this._trackedMatrix.fromArray(worldMatrix).multiply(this._postMatrix);
      if (!this.tracking) {
        this.tracking = true;
        if (!this.everFound) this._snapPose = true;
        else this._blendUntil = this.clock.elapsedTime + 0.5; // glide back from the held pose
        this.everFound = true;
        // Re-anchor automatically if full screen was entered automatically.
        if (this.fullscreen === 'auto') this.#setMode(false);
        this.onTrackingChange?.({ type: 'found' });
      }
    } else if (this.tracking) {
      this.tracking = false;
      // Extended tracking: keep the content where it was and, if the gyroscope
      // is available, counter-rotate it as the phone turns.
      this._holdMatrix.copy(this._trackedMatrix);
      this._holdDeviceQuat = this.#deviceQuaternion()?.clone() ?? null;
      this.onTrackingChange?.({ type: 'lost' });
    }
  }

  /* ------------------------------------------------- pose: tracking / hold / full screen */

  /** Show the content facing the camera, sized to fill the screen (independent of tracking). */
  setFullscreen(on) {
    // Leaving an automatic full screen by hand: don't re-enter it until the
    // target has been seen again.
    if (!on && this.fullscreen === 'auto') this._autoSuppressed = true;
    this.#setMode(on ? 'manual' : false);
  }

  /** false | 'manual' (user toggled) | 'auto' (content drifted off-screen while holding). */
  #setMode(mode) {
    if (this.fullscreen === mode) return;
    this.fullscreen = mode;
    this._blendUntil = this.clock.elapsedTime + 0.7;
    this._offscreenSince = null;
    if (mode && !this.everFound) this._snapPose = true;
    this.onModeChange?.({ fullscreen: Boolean(mode), auto: mode === 'auto' });
  }

  /** True when the target rectangle at the current pose does not intersect the screen. */
  #contentOffscreen() {
    const h = this.targetAspect / 2;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of [[-0.5, -h], [0.5, -h], [-0.5, h], [0.5, h]]) {
      const p = this._tmpPos.set(x, y, 0).applyMatrix4(this.anchor.matrix);
      if (p.z > 0) return true; // behind the camera
      p.project(this.camera);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // Treat "barely visible" (under ~8% overlap on an axis) as off-screen too.
    return maxX < -0.84 || minX > 0.84 || maxY < -0.84 || minY > 0.84;
  }

  /** While holding, glide into full screen if the content stays off-screen. */
  #checkAutoFullscreen() {
    if (this.tracking) this._autoSuppressed = false;
    if (this.tracking || this.fullscreen || !this.everFound || this._autoSuppressed) {
      this._offscreenSince = null;
      return;
    }
    if (!this.#contentOffscreen()) {
      this._offscreenSince = null;
      return;
    }
    this._offscreenSince ??= this.clock.elapsedTime;
    if (this.clock.elapsedTime - this._offscreenSince > 1.2) this.#setMode('auto');
  }

  /** Enable gyroscope-assisted extended tracking (call after permission is granted). */
  enableOrientation(enabled) {
    if (!enabled || this.#onOrientation || typeof window.DeviceOrientationEvent === 'undefined') return;
    this.#onOrientation = (e) => {
      if (e.alpha === null && e.beta === null) return;
      this._orientation = { alpha: e.alpha ?? 0, beta: e.beta ?? 0, gamma: e.gamma ?? 0 };
    };
    window.addEventListener('deviceorientation', this.#onOrientation);
  }

  #onOrientation = null;

  /** Camera orientation in world space from DeviceOrientation (three.js convention). */
  #deviceQuaternion() {
    const o = this._orientation;
    if (!o) return null;
    const deg = THREE.MathUtils.DEG2RAD;
    const screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) * deg;
    this._euler.set(o.beta * deg, o.alpha * deg, -o.gamma * deg, 'YXZ');
    return this._devQuat
      .setFromEuler(this._euler)
      .multiply(DEVICE_TO_CAMERA)
      .multiply(this._screenQuat.setFromAxisAngle(Z_AXIS, -screenAngle));
  }

  #goalMatrix() {
    if (this.fullscreen) {
      // Fit the target rectangle inside the viewport with a small margin.
      const { camera } = this;
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const fitWidth = 1 / (2 * tanHalf * camera.aspect);
      const fitHeight = this.targetAspect / (2 * tanHalf);
      const dist = Math.max(fitWidth, fitHeight) * 1.08 * this.targetWidth;
      return this._goal.compose(
        this._tmpPos.set(0, 0, -dist),
        IDENTITY_QUAT,
        this._tmpScale.setScalar(this.targetWidth),
      );
    }
    if (this.tracking) return this._goal.copy(this._trackedMatrix);
    if (!this.everFound) return null;
    const now = this.#deviceQuaternion();
    if (now && this._holdDeviceQuat) {
      // anchor_now = R(camera_now⁻¹ · camera_at_loss) · anchor_at_loss
      this._relQuat.copy(now).invert().multiply(this._holdDeviceQuat);
      return this._goal.makeRotationFromQuaternion(this._relQuat).multiply(this._holdMatrix);
    }
    return this._goal.copy(this._holdMatrix);
  }

  #updatePose(dt) {
    const goal = this.#goalMatrix();
    if (!goal) {
      this.anchor.visible = false;
      return;
    }
    goal.decompose(this._gp, this._gq, this._gs);
    if (this._snapPose) {
      this._cp.copy(this._gp);
      this._cq.copy(this._gq);
      this._cs.copy(this._gs);
      this._snapPose = false;
    } else {
      // Frame-rate independent exponential smoothing. Tracker poses arrive at
      // ~15-30 Hz; easing at render rate (60 Hz) removes stepping and residual
      // jitter. Mode changes (re-lock, full screen) use a slower glide.
      const rate = this.clock.elapsedTime < this._blendUntil ? 7 : this.tracking ? 26 : 30;
      const k = 1 - Math.exp(-dt * rate);
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
    if (video.videoWidth === controller.inputWidth && video.videoHeight === controller.inputHeight) {
      this.resize();
      return;
    }
    await this.#disposeController();
    if (this.stopped) return;
    video.setAttribute('width', video.videoWidth);
    video.setAttribute('height', video.videoHeight);
    if (this.tracking) {
      // Hold the content while the tracker restarts for the new orientation.
      this.tracking = false;
      this._holdMatrix.copy(this._trackedMatrix);
      this._holdDeviceQuat = this.#deviceQuaternion()?.clone() ?? null;
      this.onTrackingChange?.({ type: 'lost' });
    }
    await this.#buildController();
  }

  /**
   * Fit the video to cover the container and derive a three.js camera whose
   * projection matches MindAR's (port of MindARThree.resize).
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

    const proj = controller.getProjectionMatrix();
    const inputRatio = controller.inputWidth / controller.inputHeight;
    const scale =
      inputRatio > containerRatio
        ? video.videoWidth / controller.inputWidth
        : video.videoHeight / controller.inputHeight;
    const projectedHeight =
      inputRatio > containerRatio
        ? ch * scale
        : (cw / controller.inputWidth) * controller.inputHeight * scale;
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
    renderer.setSize(cw, ch, true);
  }

  #render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.#updatePose(dt);
    this.#checkAutoFullscreen();
    this.onFrame?.(dt, this.clock.elapsedTime);
    this.renderer.render(this.scene, this.camera);
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
    if (this.#onOrientation) window.removeEventListener('deviceorientation', this.#onOrientation);
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
