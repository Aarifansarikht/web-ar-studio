import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const deg = THREE.MathUtils.degToRad;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** Neutral studio lighting for PBR models. Returns a dispose function. */
export function addModelLighting(scene, renderer) {
  // Filmic tone mapping for lit (PBR) materials; unlit layers opt out below so
  // they keep the exact colours of the printed artwork.
  const prevToneMapping = renderer.toneMapping;
  const prevExposure = renderer.toneMappingExposure;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 0.6);
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(0.5, 1, 1.5);
  scene.add(hemi, dir);
  return () => {
    renderer.toneMapping = prevToneMapping;
    renderer.toneMappingExposure = prevExposure;
    scene.remove(hemi, dir);
    scene.environment = null;
    envTexture.dispose();
    pmrem.dispose();
  };
}

function loadVideo(url, { loop, startMuted }) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.loop = loop;
  video.muted = startMuted;
  video.defaultMuted = startMuted;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  return new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(video), { once: true });
    video.addEventListener('error', () => reject(new Error('The AR video could not be decoded by this browser.')), {
      once: true,
    });
    video.src = url;
    video.load();
  });
}

/**
 * AR content anchored to the image target: a video plane, an image plane or a
 * glTF model. All units are relative to the target width (see ImageTrackingSession).
 */
export class ARContent {
  constructor({
    type,
    root,
    visual,
    video = null,
    mixer = null,
    introAction = null,
    materials = [],
    baseVisualScale = 1,
    revealScale = true,
    disposeExtra,
  }) {
    this.introAction = introAction;
    this.revealScale = revealScale;
    this.introPlayed = false;
    this.type = type;
    this.root = root;
    this.visual = visual;
    this.video = video;
    this.mixer = mixer;
    this.materials = materials;
    this.baseVisualScale = baseVisualScale;
    this.disposeExtra = disposeExtra;
    this.reveal = 0;
    this.revealing = false;
  }

  applyPlacement(p) {
    this.root.position.set(p.offsetX, p.offsetY, p.offsetZ);
    this.root.rotation.set(deg(p.rotationX), deg(p.rotationY), deg(p.rotationZ));
    this.root.scale.setScalar(p.scale);
  }

  /** Called when the target is found. Resolves `{ blocked }` if video autoplay was refused. */
  async onFound() {
    this.revealing = true;
    // Authored "intro" animation (e.g. the tyre lifting off the wall): play
    // once, on the first lock only.
    if (this.introAction && !this.introPlayed) {
      this.introPlayed = true;
      this.introAction.reset().play();
    }
    if (!this.video) return { blocked: false };
    try {
      await this.video.play();
      return { blocked: false };
    } catch {
      return { blocked: true };
    }
  }

  onLost() {
    this.revealing = false;
    this.reveal = 0;
    this.#applyReveal();
    this.video?.pause();
  }

  /** Show fully without a tracking event (admin preview). */
  showImmediately() {
    this.revealing = true;
    if (this.introAction) {
      this.introPlayed = true;
      this.introAction.reset().play();
    }
    this.reveal = 1;
    this.#applyReveal();
  }

  update(dt) {
    this.mixer?.update(dt);
    if (this.revealing && this.reveal < 1) {
      this.reveal = Math.min(1, this.reveal + dt / 0.45);
      this.#applyReveal();
    }
  }

  #applyReveal() {
    const t = easeOut(this.reveal);
    if (this.type === 'model') {
      // Target-aligned scenes must not be rescaled (they would drift off the print).
      if (this.revealScale) this.visual.scale.setScalar(this.baseVisualScale * (0.6 + 0.4 * t));
    } else {
      for (const m of this.materials) m.opacity = t;
    }
  }

  dispose() {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.mixer?.stopAllAction();
    this.root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        for (const value of Object.values(m)) {
          if (value?.isTexture) value.dispose();
        }
        m.dispose();
      }
    });
    this.disposeExtra?.();
    this.root.removeFromParent();
  }
}

/**
 * @param {object} opts
 * @param {{type:'video'|'image'|'model', fit:'target'|'natural', loop:boolean, startMuted:boolean, playAnimations:boolean}} opts.content
 * @param {object} opts.placement
 * @param {number} opts.targetAspect target height / width
 * @param {string} opts.url Asset URL (typically a blob: URL from the preloader)
 * @param {number} [opts.maxAnisotropy]
 */
export async function createARContent({ content, placement, targetAspect, url, maxAnisotropy = 4 }) {
  const root = new THREE.Group();
  root.name = 'ar-content';
  let result;

  if (content.type === 'video' || content.type === 'image') {
    let texture;
    let video = null;
    let contentAspect;

    if (content.type === 'video') {
      video = await loadVideo(url, content);
      contentAspect = video.videoWidth / video.videoHeight || 16 / 9;
      texture = new THREE.VideoTexture(video);
    } else {
      texture = await new THREE.TextureLoader().loadAsync(url);
      contentAspect = texture.image.width / texture.image.height || 1;
      texture.anisotropy = maxAnisotropy;
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = content.type === 'image';
    if (content.type === 'video') texture.minFilter = THREE.LinearFilter;

    const height = content.fit === 'natural' ? 1 / contentAspect : targetAspect;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const visual = new THREE.Mesh(new THREE.PlaneGeometry(1, height), material);
    root.add(visual);
    result = new ARContent({ type: content.type, root, visual, video, materials: [material] });
  } else if (content.type === 'model') {
    // Self-hosted glTF-specific Draco decoder (bundled by Vite, fetched only when needed).
    const draco = new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG);
    const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
    let gltf;
    try {
      gltf = await loader.loadAsync(url);
    } catch (err) {
      draco.dispose();
      throw new Error(`The 3D model could not be loaded (${err?.message || 'invalid file'}).`);
    }

    const model = gltf.scene;
    const visual = new THREE.Group();
    visual.add(model);
    let baseVisualScale = 1;

    if (content.alignToTarget) {
      // Scene authored in target space (1 unit = target width, origin at the
      // target centre, +Z out of the image): use as-is so it lines up with the print.
    } else {
      // Normalise: largest dimension = 1 target width, bounding box centred on
      // the target so placement rotations pivot around the model's middle.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      model.position.sub(center);
      baseVisualScale = 1 / maxDim;
      visual.scale.setScalar(baseVisualScale * 0.6);
    }
    root.add(visual);

    // Unlit layers (wall patches, glows, streaks) keep the artwork's exact
    // colours: exclude them from tone mapping.
    model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m?.isMeshBasicMaterial) m.toneMapped = false;
      }
    });

    let mixer = null;
    let introAction = null;
    if (content.playAnimations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      const byName = (n) => gltf.animations.find((c) => c.name.toLowerCase() === n);
      const intro = byName('intro');
      const loop = byName('loop');
      if (intro || loop) {
        // Authored scene: "loop" runs continuously; "intro" plays once on the
        // first lock and holds its last frame.
        if (loop) mixer.clipAction(loop).play();
        if (intro) {
          introAction = mixer.clipAction(intro);
          introAction.setLoop(THREE.LoopOnce, 1);
          introAction.clampWhenFinished = true;
          introAction.play();
          introAction.paused = true; // pose at frame 0 until the target is found
        }
      } else {
        // Play only the first clip: separate clips often drive the same joints
        // (e.g. idle/walk/run cycles) and must not be blended together.
        mixer.clipAction(gltf.animations[0]).play();
      }
    }
    result = new ARContent({
      type: 'model',
      root,
      visual,
      mixer,
      introAction,
      baseVisualScale,
      revealScale: !content.alignToTarget,
      disposeExtra: () => draco.dispose(),
    });
  } else {
    throw new Error(`Unsupported content type "${content.type}".`);
  }

  result.applyPlacement(placement);
  return result;
}
