import { apiRequest, apiUpload } from './apiClient.js';

/**
 * Experience data model (as stored by the server):
 * {
 *   id, name, description, status: 'draft' | 'published',
 *   brand:     { name, accentColor, logoUrl, coverUrl },   // coverUrl: optional splash hero image
 *   target:    { imageUrl, mindUrl, width, height, quality, featureCount },
 *   content:   { type: 'video' | 'image' | 'model', url, fileName, fit, loop, startMuted, playAnimations, aspect },
 *   placement: { scale, offsetX, offsetY, offsetZ, rotationX, rotationY, rotationZ },
 *   hotspots:  [{ id, label, x, y }],   // x/y normalised from the target's top-left
 *   createdAt, updatedAt
 * }
 */

export const CONTENT_TYPES = [
  { value: 'video', label: 'Video', accept: '.mp4,.webm,.mov,.m4v,video/mp4,video/webm,video/quicktime' },
  { value: 'image', label: 'Image', accept: '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp' },
  { value: 'model', label: '3D model', accept: '.glb,.gltf' },
];

export const DEFAULT_PLACEMENT = Object.freeze({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
});

export function createEmptyDraft() {
  return {
    name: '',
    description: '',
    status: 'published',
    brand: { name: '', accentColor: '#e5173f', logoUrl: null, coverUrl: null, removeLogo: false, removeCover: false },
    target: { imageUrl: null, mindUrl: null, width: 0, height: 0, quality: null, featureCount: 0 },
    content: {
      type: 'video',
      url: null,
      fileName: null,
      fit: 'target',
      loop: true,
      startMuted: true,
      playAnimations: true,
      aspect: 1,
    },
    placement: { ...DEFAULT_PLACEMENT },
    hotspots: [],
  };
}

export const listExperiences = (opts) => apiRequest('/api/experiences', opts);
export const getExperience = (id, opts) => apiRequest(`/api/experiences/${encodeURIComponent(id)}`, opts);
export const getPublicExperience = (id, opts) =>
  apiRequest(`/api/public/experiences/${encodeURIComponent(id)}`, { ...opts, auth: false });
export const getHealth = () => apiRequest('/api/health', { auth: false });
export const checkAdminAuth = () => apiRequest('/api/auth/check');

export const setExperienceStatus = (id, status) =>
  apiRequest(`/api/experiences/${encodeURIComponent(id)}/status`, { method: 'PATCH', json: { status } });

export const deleteExperience = (id) =>
  apiRequest(`/api/experiences/${encodeURIComponent(id)}`, { method: 'DELETE' });

function buildFormData(draft, files) {
  const fd = new FormData();
  fd.append('data', JSON.stringify(draft));
  if (files.targetImage) fd.append('targetImage', files.targetImage);
  if (files.targetMind) fd.append('targetMind', files.targetMind, 'target.mind');
  if (files.content) fd.append('content', files.content);
  if (files.logo) fd.append('logo', files.logo);
  if (files.cover) fd.append('cover', files.cover);
  return fd;
}

/**
 * @param {object} draft Experience fields (see data model).
 * @param {{targetImage?: File, targetMind?: Blob, content?: File, logo?: File, cover?: File}} files
 */
export function createExperience(draft, files, onProgress) {
  return apiUpload('/api/experiences', { formData: buildFormData(draft, files), onProgress });
}

export function updateExperience(id, draft, files, onProgress) {
  return apiUpload(`/api/experiences/${encodeURIComponent(id)}`, {
    method: 'PUT',
    formData: buildFormData(draft, files),
    onProgress,
  });
}
