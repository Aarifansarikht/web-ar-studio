import * as THREE from 'three';
import { ARError, classifyCameraError } from './environment.js';

/**
 * Image tracking with the 8th Wall engine (free since 2026; binary in
 * public/external/xr, see README "8th Wall engine"). Content, hotspots and
 * the gallery all use this session directly:
 * content added to `session.anchor` is in target space (origin at the image
 * centre, +X right, +Y up, +Z towards the viewer, 1 unit = image width).
 *
 * Target data is built in the browser from each experience's target image
 * (8th Wall uses a 3:4 crop, 480×640 grayscale; landscape images are rotated
 * to portrait first), so no extra files are needed per experience.
 */

const ENGINE_URL = '/external/xr/xr.js';
const LUMINANCE = [480, 640];
// Keep the camera compositor below 1280px on its longest side. Image target
// tracking uses its own input, while this avoids a costly full-resolution draw.
const MAX_RENDER_DIMENSION = 1280;
const LOST_GRACE_MS = 180;

let enginePromise = null;

/** Load the 8th Wall engine (with the image-target chunk) once. */
export function loadEighthWall() {
  if (enginePromise) return enginePromise;
  enginePromise = new Promise((resolve, reject) => {
    // The engine's three.js module uses the global THREE.
    window.THREE = THREE;
    if (window.XR8) {
      resolve(window.XR8);
      return;
    }
    window.addEventListener('xrloaded', () => resolve(window.XR8), { once: true });
    const s = document.createElement('script');
    s.src = ENGINE_URL;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.preloadChunks = 'slam';
    s.onerror = () => {
      enginePromise = null;
      reject(new Error('The AR engine could not be downloaded. Check your connection.'));
    };
    document.head.appendChild(s);
  });
  return enginePromise;
}

/**
 * Build 3:4 crops for one artwork. 8th Wall tracks 3:4 planar inputs; three
 * overlapping crops cover the outer details and every corner of the image.
 */
async function buildTargetData(name, url) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('The target image could not be loaded.'));
    i.src = url;
  });
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const isRotated = W > H;
  const rw = isRotated ? H : W; // portrait frame
  const rh = isRotated ? W : H;
  const tall = rw / rh <= 3 / 4;
  const width = tall ? rw : Math.round((rh * 3) / 4);
  const height = tall ? Math.round((rw * 4) / 3) : rh;
  const span = Math.max(0, tall ? rh - height : rw - width);
  // Start, centre and end cover every corner without multiplying gallery
  // tracking work more than necessary.
  const offsets = [...new Set([0, Math.round(span / 2), span])];

  return offsets.map((offset, variant) => {
    const left = tall ? 0 : offset;
    const top = tall ? offset : 0;
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = LUMINANCE;
    const g = canvas.getContext('2d');
    g.filter = 'grayscale(1)';
    g.scale(LUMINANCE[0] / width, LUMINANCE[1] / height);
    g.translate(-left, -top);
    if (isRotated) {
      g.translate(rw, 0);
      g.rotate(Math.PI / 2);
    }
    g.drawImage(img, 0, 0);
    return {
      data: {
        imagePath: canvas.toDataURL('image/jpeg', 0.92),
        metadata: null,
        name: `${name}--${variant}`,
        type: 'PLANAR',
        properties: { left, top, width, height, isRotated, originalWidth: rw, originalHeight: rh },
        resources: {},
        created: 0,
        updated: 0,
      },
      geometry: { W, H, isRotated, crop: { left, top, width, height }, rw },
    };
  });
}

export class EighthWallSession {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {{id: string, url: string}[]} opts.targets one per artwork (experience id, target image URL)
   * @param {(e: {type: 'found'|'searching', targetIndex: number}) => void} [opts.onTrackingChange]
   * @param {(e: {fullscreen: boolean}) => void} [opts.onModeChange]
   * @param {(dt: number, elapsed: number) => void} [opts.onFrame]
   */
  constructor({ container, targets, onTrackingChange, onModeChange, onFrame }) {
    this.container = container;
    this.targetSources = targets;
    this.onTrackingChange = onTrackingChange;
    this.onModeChange = onModeChange;
    this.onFrame = onFrame;
    this.anchor = new THREE.Group();
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.targets = [];
    this.tracking = false;
    this.everFound = false;
    this.fullscreen = false;
    this.activeTarget = -1;
    this.displayTarget = -1;
    this.stopped = false;
    this.clock = new THREE.Clock(false);
    this.stats = { engine: '8th Wall', fps: 0, trackFps: 0, tracking: false, target: -1 };
    this._updates = 0;
    this._frames = 0;
    this._statsAt = 0;
    this._m = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
    this._rawAnchor = new THREE.Matrix4();
    this._rawPosition = new THREE.Vector3();
    this._rawRotation = new THREE.Quaternion();
    this._rawScale = new THREE.Vector3();
    this._filteredPosition = new THREE.Vector3();
    this._filteredRotation = new THREE.Quaternion();
    this._filteredScale = new THREE.Vector3(1, 1, 1);
    this._poseInitialised = false;
    this._lastPoseAt = 0;
    this._lostTimer = null;
    this._visibleTargetVariants = new Set();
  }

  get isTracking() {
    return this.tracking;
  }

  get hasFoundTarget() {
    return this.everFound;
  }

  get targetAspect() {
    return this.targets[Math.max(0, this.displayTarget)]?.aspect ?? 1;
  }

  async start() {
    let XR8;
    let targetVariants;
    try {
      [XR8, targetVariants] = await Promise.all([
        loadEighthWall(),
        Promise.all(this.targetSources.map((t) => buildTargetData(t.id, t.url))),
      ]);
    } catch (err) {
      throw new ARError('engine', err.message, err);
    }
    if (this.stopped) return;
    this.XR8 = XR8;
    this.targets = targetVariants.map((variants) => ({
      aspect: variants[0].geometry.H / variants[0].geometry.W,
      ...variants[0].geometry,
    }));
    const built = targetVariants.flatMap((variants, targetIndex) =>
      variants.map((target) => ({ ...target, targetIndex })),
    );
    this._nameToTarget = new Map(built.map((target) => [target.data.name, target]));

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: '1', touchAction: 'none' });
    this.container.appendChild(canvas);
    this.canvas = canvas;
    this.#sizeCanvas();
    this._onResize = () => this.#sizeCanvas();
    window.addEventListener('resize', this._onResize);

    await new Promise((resolve, reject) => {
      this._resolveStart = resolve;
      this._rejectStart = reject;
      XR8.XrController.configure({ disableWorldTracking: true, imageTargetData: built.map((b) => b.data) });
      XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),
        XR8.Threejs.pipelineModule(),
        XR8.XrController.pipelineModule(),
        this.#pipelineModule(),
      ]);
      XR8.run({
        canvas,
        allowedDevices: XR8.XrConfig.device().ANY,
        cameraConfig: { direction: XR8.XrConfig.camera().BACK },
        glContextConfig: {
          alpha: false,
          antialias: false,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
          desynchronized: true,
        },
      });
    });
  }

  /**
   * Size the canvas the way 8th Wall expects (port of its XRExtras
   * FullWindowCanvas module, for our container): the drawing buffer has the
   * screen's aspect ratio and at most the camera's resolution, i.e. the
   * cropped camera frame. A larger or differently shaped buffer makes the
   * engine stretch the camera image.
   */
  #sizeCanvas() {
    const canvas = this.canvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ww = this.container.clientWidth * dpr;
    const wh = this.container.clientHeight * dpr;
    if (!ww || !wh) return;
    const ph = Math.max(ww, wh);
    const pw = Math.min(ww, wh);
    const pa = ph / pw;
    const v = this._video ?? { w: 0, h: 0 };
    const pvh = Math.max(v.w, v.h) || ph;
    const pvw = Math.min(v.w, v.h) || pw;
    let ch = pvh;
    let cw = Math.round(pvh / pa);
    if (cw > pvw) {
      cw = pvw;
      ch = Math.round(pvw * pa);
    }
    if (cw > pw || ch > ph) {
      cw = Math.round(pw);
      ch = Math.round(ph);
    }
    if (ww > wh) [cw, ch] = [ch, cw];
    const longest = Math.max(cw, ch);
    if (longest > MAX_RENDER_DIMENSION) {
      const scale = MAX_RENDER_DIMENSION / longest;
      cw = Math.max(1, Math.round(cw * scale));
      ch = Math.max(1, Math.round(ch * scale));
    }
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
  }

  #pipelineModule() {
    const setVideo = (w, h) => {
      if (w && h) this._video = { w, h };
      this.#sizeCanvas();
    };
    return {
      name: 'webar-session',
      onAttach: ({ videoWidth, videoHeight }) => setVideo(videoWidth, videoHeight),
      onVideoSizeChange: ({ videoWidth, videoHeight }) => setVideo(videoWidth, videoHeight),
      onDeviceOrientationChange: () => this.#sizeCanvas(),
      onCanvasSizeChange: () => this.#sizeCanvas(),
      onStart: () => {
        const { scene, camera, renderer } = this.XR8.Threejs.xrScene();
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        scene.add(this.anchor);
        this.clock.start();
        this._resolveStart?.();
      },
      onCameraStatusChange: ({ status, video }) => {
        if (status === 'hasVideo' && video) setVideo(video.videoWidth, video.videoHeight);
        if (status === 'failed') this._rejectStart?.(new ARError('camera-denied', 'Camera access was denied or is unavailable.'));
      },
      onException: (err) => this._rejectStart?.(classifyCameraError(err)),
      onUpdate: () => {
        const dt = Math.min(this.clock.getDelta(), 0.1);
        this._frames++;
        if (this.fullscreen) this.#placeFullscreen();
        if (this.clock.elapsedTime - this._statsAt >= 1) {
          this.stats.trackFps = Math.round(this._updates / (this.clock.elapsedTime - this._statsAt));
          this.stats.fps = Math.round(this._frames / (this.clock.elapsedTime - this._statsAt));
          this.stats.tracking = this.tracking;
          this.stats.target = this.displayTarget;
          this._updates = 0;
          this._frames = 0;
          this._statsAt = this.clock.elapsedTime;
        }
        this.onFrame?.(dt, this.clock.elapsedTime);
      },
      listeners: [
        { event: 'reality.imagefound', process: ({ detail }) => this.#onImage(detail, true) },
        { event: 'reality.imageupdated', process: ({ detail }) => this.#onImage(detail, false) },
        { event: 'reality.imagelost', process: ({ detail }) => this.#onLost(detail) },
      ],
    };
  }

  /** Anchor = engine pose of the tracked crop × (crop → full-image target space). */
  #onImage(detail, found) {
    const tracked = this._nameToTarget.get(detail.name);
    if (!tracked) return;
    const { targetIndex: i, geometry: t } = tracked;
    this._updates++;
    this._visibleTargetVariants.add(detail.name);
    if (this._lostTimer !== null) {
      clearTimeout(this._lostTimer);
      this._lostTimer = null;
    }
    // Units per image pixel in the engine's image frame (reported in the
    // image's own orientation: width = scaledWidth).
    const cropAlongX = t.isRotated ? t.crop.height : t.crop.width;
    const u = detail.scaledWidth / cropAlongX;
    // Crop centre relative to the full image centre, in image pixels (x right, y down).
    let dx;
    let dy;
    if (t.isRotated) {
      // Portrait frame = image rotated 90° clockwise: (x, y) -> (H - y, x).
      const cxr = t.crop.left + t.crop.width / 2;
      const cyr = t.crop.top + t.crop.height / 2;
      dx = cyr - t.W / 2;
      dy = t.H - cxr - t.H / 2;
    } else {
      dx = t.crop.left + t.crop.width / 2 - t.W / 2;
      dy = t.crop.top + t.crop.height / 2 - t.H / 2;
    }
    const w = t.W * u; // full image width in engine units
    this._local.makeScale(w, w, w).setPosition(-dx * u, dy * u, 0);
    this._m.compose(
      this._rawPosition.set(detail.position.x, detail.position.y, detail.position.z),
      this._rawRotation.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w),
      this._rawScale.set(detail.scale, detail.scale, detail.scale),
    );
    if (!this.fullscreen) {
      this._rawAnchor.multiplyMatrices(this._m, this._local);
      this._rawAnchor.decompose(this._rawPosition, this._rawRotation, this._rawScale);
      const now = performance.now();
      const isNewTarget = i !== this.activeTarget || !this.tracking;
      if (!this._poseInitialised || isNewTarget) {
        this._filteredPosition.copy(this._rawPosition);
        this._filteredRotation.copy(this._rawRotation);
        this._filteredScale.copy(this._rawScale);
        this._poseInitialised = true;
      } else {
        // Dampen small pose noise while following a fast intentional motion
        // closely enough that the overlay does not visibly lag behind it.
        const distance = this._filteredPosition.distanceTo(this._rawPosition);
        const rotation = this._filteredRotation.angleTo(this._rawRotation);
        const dt = Math.min(100, Math.max(16, now - this._lastPoseAt));
        const response = distance > 0.035 || rotation > 0.08 ? 0.88 : 1 - Math.exp(-dt / 85);
        this._filteredPosition.lerp(this._rawPosition, response);
        this._filteredRotation.slerp(this._rawRotation, response);
        this._filteredScale.lerp(this._rawScale, response);
      }
      this._lastPoseAt = now;
      this.anchor.matrix.compose(this._filteredPosition, this._filteredRotation, this._filteredScale);
      this.anchor.matrixWorldNeedsUpdate = true;
      this.anchor.visible = true;
    }
    if (found || !this.tracking || i !== this.activeTarget) {
      this.tracking = true;
      this.everFound = true;
      this.activeTarget = i;
      this.displayTarget = i;
      this.onTrackingChange?.({ type: 'found', targetIndex: i });
    }
  }

  #onLost(detail) {
    const tracked = this._nameToTarget.get(detail.name);
    if (!tracked) return;
    this._visibleTargetVariants.delete(detail.name);
    if (tracked.targetIndex !== this.activeTarget) return;
    const i = tracked.targetIndex;
    const anotherVariantIsVisible = [...this._visibleTargetVariants].some(
      (name) => this._nameToTarget.get(name)?.targetIndex === i,
    );
    if (anotherVariantIsVisible) return;
    if (this._lostTimer !== null) clearTimeout(this._lostTimer);
    // A short loss is normal while a phone is shaken or the camera adjusts
    // exposure. Keep the most recent stable pose while the next frame recovers.
    this._lostTimer = window.setTimeout(() => {
      this._lostTimer = null;
      const recovered = [...this._visibleTargetVariants].some(
        (name) => this._nameToTarget.get(name)?.targetIndex === i,
      );
      if (recovered || i !== this.activeTarget) return;
      this.tracking = false;
      if (!this.fullscreen) this.anchor.visible = false;
      this.onTrackingChange?.({ type: 'searching', targetIndex: i });
    }, LOST_GRACE_MS);
  }

  setFullscreen(on) {
    if (this.fullscreen === on) return;
    this.fullscreen = on;
    if (!on) this.anchor.visible = this.tracking;
    this.onModeChange?.({ fullscreen: on });
  }

  /** Content facing the camera, sized to fill the view. */
  #placeFullscreen() {
    const cam = this.camera;
    if (!cam) return;
    // The engine sets the projection matrix directly (camera intrinsics), so
    // derive the visible extent from it rather than from cam.fov / cam.aspect.
    const e = cam.projectionMatrix.elements;
    const tanH = 1 / e[0];
    const tanV = 1 / e[5];
    const dist = Math.max(0.5 / tanH, (this.targetAspect * 0.5) / tanV) * 1.08;
    cam.updateMatrixWorld();
    this.anchor.matrix.copy(cam.matrixWorld).multiply(this._local.makeTranslation(0, 0, -dist));
    this.anchor.matrixWorldNeedsUpdate = true;
    this.anchor.visible = true;
  }

  pick(clientX, clientY, objects) {
    if (!this.canvas || !this.anchor.visible || !this.camera) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster.intersectObjects(objects, true)[0] ?? null;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this._lostTimer !== null) clearTimeout(this._lostTimer);
    window.removeEventListener('resize', this._onResize);
    const XR8 = this.XR8;
    if (XR8) {
      try {
        XR8.stop();
        XR8.clearCameraPipelineModules();
      } catch {
        // already stopped
      }
    }
    this.anchor.removeFromParent();
    this.canvas?.remove();
    this.clock.stop();
  }
}
