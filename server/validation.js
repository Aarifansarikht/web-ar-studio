/**
 * Server-side sanitisation of the experience payload sent by the admin.
 * Never trust the client: every field is type-checked, clamped and limited.
 */

export const CONTENT_TYPES = ['video', 'image', 'model'];
export const STATUSES = ['draft', 'published'];

export const FILE_RULES = {
  targetImage: { exts: ['.jpg', '.jpeg', '.png', '.webp'], label: 'Target image' },
  targetMind: { exts: ['.mind'], label: 'Compiled target' },
  logo: { exts: ['.jpg', '.jpeg', '.png', '.webp'], label: 'Logo' },
  cover: { exts: ['.jpg', '.jpeg', '.png', '.webp'], label: 'Splash image' },
  content: {
    video: { exts: ['.mp4', '.webm', '.mov', '.m4v'], label: 'Video' },
    image: { exts: ['.jpg', '.jpeg', '.png', '.webp'], label: 'Image' },
    model: { exts: ['.glb', '.gltf'], label: '3D model' },
  },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const str = (value, max, fallback = '') =>
  typeof value === 'string' ? value.trim().slice(0, max) : fallback;

const num = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * @param {unknown} input Parsed JSON from the `data` multipart field.
 * @param {object} [previous] Existing experience when updating.
 */
export function sanitizeExperienceInput(input, previous = null) {
  if (!input || typeof input !== 'object') throw new ValidationError('Missing experience data.');

  const name = str(input.name, 80);
  if (!name) throw new ValidationError('Experience name is required.');

  const status = STATUSES.includes(input.status) ? input.status : previous?.status ?? 'draft';

  const brandIn = input.brand ?? {};
  const brand = {
    name: str(brandIn.name, 40),
    accentColor: HEX_COLOR.test(brandIn.accentColor ?? '') ? brandIn.accentColor : '#e5173f',
    logoUrl: previous?.brand?.logoUrl ?? null,
    coverUrl: previous?.brand?.coverUrl ?? null,
  };
  if (brandIn.removeLogo === true) brand.logoUrl = null;
  if (brandIn.removeCover === true) brand.coverUrl = null;

  const contentIn = input.content ?? {};
  const contentType = CONTENT_TYPES.includes(contentIn.type) ? contentIn.type : null;
  if (!contentType) throw new ValidationError('A valid AR content type is required.');

  const content = {
    type: contentType,
    url: previous?.content?.type === contentType ? previous.content.url : null,
    fileName: previous?.content?.type === contentType ? previous.content.fileName : null,
    fit: contentIn.fit === 'natural' ? 'natural' : 'target',
    loop: bool(contentIn.loop, true),
    startMuted: bool(contentIn.startMuted, true),
    playAnimations: bool(contentIn.playAnimations, true),
    aspect: num(contentIn.aspect, 0.05, 20, previous?.content?.aspect ?? 1),
  };

  const p = input.placement ?? {};
  const placement = {
    scale: num(p.scale, 0.05, 10, 1),
    offsetX: num(p.offsetX, -5, 5, 0),
    offsetY: num(p.offsetY, -5, 5, 0),
    offsetZ: num(p.offsetZ, -5, 5, 0),
    rotationX: num(p.rotationX, -180, 180, 0),
    rotationY: num(p.rotationY, -180, 180, 0),
    rotationZ: num(p.rotationZ, -180, 180, 0),
  };

  const hotspots = Array.isArray(input.hotspots)
    ? input.hotspots.slice(0, 20).map((h, i) => ({
        id: str(h?.id, 24) || `h${i}`,
        label: str(h?.label, 40) || `Hotspot ${i + 1}`,
        x: num(h?.x, 0, 1, 0.5),
        y: num(h?.y, 0, 1, 0.5),
      }))
    : [];

  const t = input.target ?? {};
  const target = {
    imageUrl: previous?.target?.imageUrl ?? null,
    mindUrl: previous?.target?.mindUrl ?? null,
    width: Math.round(num(t.width, 1, 20000, previous?.target?.width ?? 1)),
    height: Math.round(num(t.height, 1, 20000, previous?.target?.height ?? 1)),
    quality: ['good', 'fair', 'poor'].includes(t.quality) ? t.quality : previous?.target?.quality ?? null,
    featureCount: Math.round(num(t.featureCount, 0, 1e6, previous?.target?.featureCount ?? 0)),
  };

  return {
    name,
    description: str(input.description, 400),
    status,
    brand,
    content,
    placement,
    hotspots,
    target,
  };
}

/** Fields safe to expose on the public (unauthenticated) endpoint. */
export function toPublicExperience(exp) {
  const { id, name, description, brand, content, placement, hotspots, target, updatedAt } = exp;
  return { id, name, description, brand, content, placement, hotspots, target, updatedAt };
}
