import * as THREE from 'three';
import { ARError, classifyCameraError } from './environment.js';

/**
 * Image tracking with the 8th Wall engine (free since 2026; binary in
 * public/external/xr, see README "8th Wall engine"). Same interface as
 * ImageTrackingSession, so content, hotspots and the gallery work unchanged:
 * content added to `session.anchor` is in target space (origin at the image
 * centre, +X right, +Y up, +Z towards the viewer, 1 unit = image width).
 *
 * Target data is built in the browser from each experience's target image
 * (8th Wall uses a 3:4 crop, 480×640 grayscale; landscape images are rotated
 * to portrait first), so no extra files are needed per experience.
 */

const ENGINE_URL = '/external/xr/xr.js';
const LUMINANCE = [480, 640];

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

/** 8th Wall image-target data for an image (3:4 crop, rotated to portrait if landscape). */
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
  let width = rw;
  let height = Math.round((rw * 4) / 3);
  let left = 0;
  let top = Math.round((rh - height) / 2);
  if (height > rh) {
    height = rh;
    width = Math.round((rh * 3) / 4);
    top = 0;
    left = Math.round((rw - width) / 2);
  }
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
      name,
      type: 'PLANAR',
      properties: { left, top, width, height, isRotated, originalWidth: rw, originalHeight: rh },
      resources: {},
      created: 0,
      updated: 0,
    },
    // How the tracked crop relates to the full image (for the anchor transform).
    geometry: { W, H, isRotated, crop: { left, top, width, height }, rw },
  };
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
    this.stats = { engine: '8th Wall', trackFps: 0 };
    this._updates = 0;
    this._statsAt = 0;
    this._m = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
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
    let built;
    try {
      [XR8, built] = await Promise.all([
        loadEighthWall(),
        Promise.all(this.targetSources.map((t) => buildTargetData(t.id, t.url))),
      ]);
    } catch (err) {
      throw new ARError('engine', err.message, err);
    }
    if (this.stopped) return;
    this.XR8 = XR8;
    this.targets = built.map((b) => ({ aspect: b.geometry.H / b.geometry.W, ...b.geometry }));
    this._nameToIndex = new Map(this.targetSources.map((t, i) => [t.id, i]));

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
      XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY });
    });
  }

  #sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.container.clientWidth * dpr);
    this.canvas.height = Math.round(this.container.clientHeight * dpr);
  }

  #pipelineModule() {
    return {
      name: 'webar-session',
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
      onCameraStatusChange: ({ status }) => {
        if (status === 'failed') this._rejectStart?.(new ARError('camera-denied', 'Camera access was denied or is unavailable.'));
      },
      onException: (err) => this._rejectStart?.(classifyCameraError(err)),
      onUpdate: () => {
        const dt = Math.min(this.clock.getDelta(), 0.1);
        if (this.fullscreen) this.#placeFullscreen();
        if (this.clock.elapsedTime - this._statsAt >= 1) {
          this.stats.trackFps = Math.round(this._updates / (this.clock.elapsedTime - this._statsAt));
          this.stats.tracking = this.tracking;
          this.stats.target = this.displayTarget;
          this._updates = 0;
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
    const i = this._nameToIndex.get(detail.name);
    if (i === undefined) return;
    this._updates++;
    const t = this.targets[i];
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
      new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z),
      new THREE.Quaternion(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w),
      new THREE.Vector3(detail.scale, detail.scale, detail.scale),
    );
    if (!this.fullscreen) {
      this.anchor.matrix.multiplyMatrices(this._m, this._local);
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
    const i = this._nameToIndex.get(detail.name);
    if (i !== this.activeTarget) return;
    this.tracking = false;
    if (!this.fullscreen) this.anchor.visible = false;
    this.onTrackingChange?.({ type: 'searching', targetIndex: i });
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
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const dist = Math.max(1 / (2 * tanHalf * cam.aspect), this.targetAspect / (2 * tanHalf)) * 1.08;
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
