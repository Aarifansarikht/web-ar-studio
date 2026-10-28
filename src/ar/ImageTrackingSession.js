import * as THREE from 'three';
import { ARError, classifyCameraError } from './environment.js';
import { loadMindAR } from './loadMindAR.js';

/** Only one camera + tracking session may run at a time. */
let activeSession = null;

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
   * @param {(dt: number, elapsed: number) => void} [opts.onFrame]
   */
  constructor({ container, mindBuffer, onTrackingChange, onFrame }) {
    this.container = container;
    this.mindBuffer = mindBuffer;
    this.onTrackingChange = onTrackingChange;
    this.onFrame = onFrame;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.anchor = new THREE.Group();
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.scene.add(this.anchor);

    this.clock = new THREE.Clock(false);
    this.tracking = false;
    this.stopped = false;
    this.targetAspect = 1;
    this._postMatrix = new THREE.Matrix4();
    this._worldMatrix = new THREE.Matrix4();
    this._processDone = null;
  }

  get isTracking() {
    return this.tracking;
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
        video: { facingMode: { ideal: 'environment' } },
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
      // Slightly more smoothing than the defaults to reduce jitter on posters.
      filterMinCF: 0.0001,
      filterBeta: 0.001,
      warmupTolerance: 5,
      missTolerance: 5,
      onUpdate: (data) => this.#onControllerUpdate(data),
    });

    const { dimensions } = this.controller.addImageTargetsFromBuffer(this.mindBuffer.slice(0));
    if (!dimensions?.length) {
      throw new ARError('engine', 'The image target data is invalid or was compiled with an incompatible version.');
    }
    const [w, h] = dimensions[0];
    this.targetAspect = h / w;
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
      this._worldMatrix.fromArray(worldMatrix).multiply(this._postMatrix);
      this.anchor.matrix.copy(this._worldMatrix);
      this.anchor.matrixWorldNeedsUpdate = true;
      this.anchor.visible = true;
      if (!this.tracking) {
        this.tracking = true;
        this.onTrackingChange?.({ type: 'found' });
      }
    } else {
      this.anchor.visible = false;
      if (this.tracking) {
        this.tracking = false;
        this.onTrackingChange?.({ type: 'lost' });
      }
    }
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
      this.tracking = false;
      this.anchor.visible = false;
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
