/** Validation and metadata extraction for 8th Wall image targets. */
export const TARGET_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
const TARGET_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_TARGET_BYTES = 15 * 1024 * 1024;
const MIN_SIDE = 300;

export class TargetError extends Error {}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new TargetError('The image could not be decoded. Try exporting it again as JPG or PNG.'));
    };
    image.src = url;
  });
}

export function validateTargetFile(file) {
  if (!file) throw new TargetError('Choose a target image.');
  if (!TARGET_TYPES.includes(file.type)) throw new TargetError('Target image must be a JPG, PNG or WebP file.');
  if (file.size > MAX_TARGET_BYTES) throw new TargetError('Target image must be smaller than 15 MB.');
}

/** 8th Wall creates target data from the source image when a session begins. */
export async function inspectImageTarget(file) {
  validateTargetFile(file);
  const image = await loadImage(file);
  if (Math.min(image.naturalWidth, image.naturalHeight) < MIN_SIDE) {
    throw new TargetError(`Target image is too small. The shortest side must be at least ${MIN_SIDE}px.`);
  }
  return { file, width: image.naturalWidth, height: image.naturalHeight };
}
