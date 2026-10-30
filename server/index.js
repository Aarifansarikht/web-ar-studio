import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { customAlphabet } from 'nanoid';
import { ExperienceStore } from './store.js';
import {
  FILE_RULES,
  ValidationError,
  sanitizeExperienceInput,
  toPublicExperience,
} from './validation.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the real environment.
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 8787;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || '';
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'server/data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DIST_DIR = path.join(ROOT, 'dist');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 60;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const store = new ExperienceStore(DATA_DIR);
const newId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10);
const ID_PATTERN = /^[a-z0-9]{6,32}$/;

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  next();
});

// --- CORS (only needed when the frontend is hosted on another origin) ------
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Uploaded assets: public, immutable (file names are unique per upload) --
app.use(
  '/uploads',
  (req, res, next) => {
    // Assets are loaded into WebGL textures, so they must be CORS-readable.
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Uploaded files are never documents: block script execution if opened directly.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    next();
  },
  express.static(UPLOADS_DIR, {
    immutable: true,
    maxAge: '365d',
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.mind')) res.setHeader('Content-Type', 'application/octet-stream');
      if (filePath.endsWith('.glb')) res.setHeader('Content-Type', 'model/gltf-binary');
      if (filePath.endsWith('.gltf')) res.setHeader('Content-Type', 'model/gltf+json');
    },
  }),
  (req, res) => res.status(404).json({ error: 'Asset not found.' }),
);

// --- Auth ------------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    if (IS_PROD) {
      return res.status(503).json({ error: 'ADMIN_TOKEN is not configured on the server.' });
    }
    return next(); // Development convenience: open admin API on localhost.
  }
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Admin token required.' });
  }
  next();
}

// --- Multipart uploads -----------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 5, fields: 4, fieldSize: 256 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['targetImage', 'targetMind', 'content', 'logo', 'cover'];
    if (!allowed.includes(file.fieldname)) {
      return cb(new ValidationError(`Unexpected file field "${file.fieldname}".`));
    }
    cb(null, true);
  },
}).fields([
  { name: 'targetImage', maxCount: 1 },
  { name: 'targetMind', maxCount: 1 },
  { name: 'content', maxCount: 1 },
  { name: 'logo', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);

const extOf = (file) => path.extname(file.originalname || '').toLowerCase();

/** Move an uploaded temp file into the experience folder; return its public URL. */
async function commitFile(file, id, prefix, rule) {
  const ext = extOf(file);
  if (!rule.exts.includes(ext)) {
    throw new ValidationError(`${rule.label} must be one of: ${rule.exts.join(', ')}.`);
  }
  if (file.size === 0) throw new ValidationError(`${rule.label} file is empty.`);
  const dir = path.join(UPLOADS_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const name = `${prefix}-${crypto.randomBytes(5).toString('hex')}${ext}`;
  await fsp.rename(file.path, path.join(dir, name));
  file.committed = true;
  return `/uploads/${id}/${name}`;
}

async function removeAsset(url) {
  if (!url?.startsWith('/uploads/')) return;
  const filePath = path.join(UPLOADS_DIR, url.slice('/uploads/'.length));
  if (!filePath.startsWith(UPLOADS_DIR)) return;
  await fsp.rm(filePath, { force: true });
}

async function discardTempFiles(files = {}) {
  await Promise.all(
    Object.values(files)
      .flat()
      .filter((f) => !f.committed)
      .map((f) => fsp.rm(f.path, { force: true })),
  );
}

function parseData(raw) {
  try {
    return JSON.parse(raw ?? '');
  } catch {
    throw new ValidationError('Experience data must be valid JSON.');
  }
}

const one = (files, field) => files?.[field]?.[0];

function validId(req, res, next) {
  if (!ID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Experience not found.' });
  next();
}

// --- API routes ------------------------------------------------------------
const api = express.Router();

api.get('/health', (req, res) => {
  res.json({ ok: true, adminAuth: ADMIN_TOKEN ? 'token' : IS_PROD ? 'unconfigured' : 'open' });
});

api.get('/auth/check', requireAdmin, (req, res) => res.json({ ok: true }));

// Public: used by the QR landing page. Drafts are not exposed.
api.get('/public/experiences/:id', validId, async (req, res) => {
  const exp = await store.get(req.params.id);
  if (!exp || exp.status !== 'published') {
    return res.status(404).json({ error: 'This experience does not exist or is not published.' });
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.json(toPublicExperience(exp));
});

// Public: the gallery (one QR code that recognises every published artwork).
api.get('/public/experiences', async (req, res) => {
  const list = (await store.list()).filter((e) => e.status === 'published');
  res.setHeader('Cache-Control', 'no-cache');
  res.json(list.map(toPublicExperience));
});

api.get('/experiences', requireAdmin, async (req, res) => {
  res.json(await store.list());
});

api.get('/experiences/:id', requireAdmin, validId, async (req, res) => {
  const exp = await store.get(req.params.id);
  if (!exp) return res.status(404).json({ error: 'Experience not found.' });
  res.json(exp);
});

api.post('/experiences', requireAdmin, upload, async (req, res) => {
  const files = req.files ?? {};
  const id = newId();
  try {
    const clean = sanitizeExperienceInput(parseData(req.body.data));
    const targetImage = one(files, 'targetImage');
    const targetMind = one(files, 'targetMind');
    const content = one(files, 'content');
    if (!targetImage || !targetMind) {
      throw new ValidationError('A target image and its compiled tracking data are required.');
    }
    if (!content) throw new ValidationError('An AR content file is required.');

    clean.target.imageUrl = await commitFile(targetImage, id, 'target', FILE_RULES.targetImage);
    clean.target.mindUrl = await commitFile(targetMind, id, 'target', FILE_RULES.targetMind);
    clean.content.url = await commitFile(content, id, 'content', FILE_RULES.content[clean.content.type]);
    clean.content.fileName = content.originalname.slice(0, 120);
    const logo = one(files, 'logo');
    if (logo) clean.brand.logoUrl = await commitFile(logo, id, 'logo', FILE_RULES.logo);
    const cover = one(files, 'cover');
    if (cover) clean.brand.coverUrl = await commitFile(cover, id, 'cover', FILE_RULES.cover);

    const now = new Date().toISOString();
    const experience = { id, ...clean, createdAt: now, updatedAt: now };
    await store.create(experience);
    res.status(201).json(experience);
  } catch (err) {
    await fsp.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true });
    throw err;
  } finally {
    await discardTempFiles(files);
  }
});

api.put('/experiences/:id', requireAdmin, validId, upload, async (req, res) => {
  const files = req.files ?? {};
  const { id } = req.params;
  const replaced = [];
  try {
    const previous = await store.get(id);
    if (!previous) return res.status(404).json({ error: 'Experience not found.' });
    const clean = sanitizeExperienceInput(parseData(req.body.data), previous);

    const targetImage = one(files, 'targetImage');
    const targetMind = one(files, 'targetMind');
    if (Boolean(targetImage) !== Boolean(targetMind)) {
      throw new ValidationError('A new target image must be uploaded together with its compiled tracking data.');
    }
    if (targetImage) {
      clean.target.imageUrl = await commitFile(targetImage, id, 'target', FILE_RULES.targetImage);
      clean.target.mindUrl = await commitFile(targetMind, id, 'target', FILE_RULES.targetMind);
      replaced.push(previous.target.imageUrl, previous.target.mindUrl);
    }

    const content = one(files, 'content');
    if (content) {
      clean.content.url = await commitFile(content, id, 'content', FILE_RULES.content[clean.content.type]);
      clean.content.fileName = content.originalname.slice(0, 120);
      replaced.push(previous.content.url);
    } else if (!clean.content.url) {
      throw new ValidationError('Changing the content type requires uploading a new content file.');
    }

    const logo = one(files, 'logo');
    if (logo) {
      clean.brand.logoUrl = await commitFile(logo, id, 'logo', FILE_RULES.logo);
      replaced.push(previous.brand?.logoUrl);
    } else if (!clean.brand.logoUrl && previous.brand?.logoUrl) {
      replaced.push(previous.brand.logoUrl);
    }

    const cover = one(files, 'cover');
    if (cover) {
      clean.brand.coverUrl = await commitFile(cover, id, 'cover', FILE_RULES.cover);
      replaced.push(previous.brand?.coverUrl);
    } else if (!clean.brand.coverUrl && previous.brand?.coverUrl) {
      replaced.push(previous.brand.coverUrl);
    }

    const updated = await store.update(id, () => ({
      ...previous,
      ...clean,
      id,
      createdAt: previous.createdAt,
      updatedAt: new Date().toISOString(),
    }));
    await Promise.all([...new Set(replaced)].filter((u) => u !== undefined).map(removeAsset));
    res.json(updated);
  } finally {
    await discardTempFiles(files);
  }
});

api.patch('/experiences/:id/status', requireAdmin, validId, express.json(), async (req, res) => {
  const { status } = req.body ?? {};
  if (!['draft', 'published'].includes(status)) throw new ValidationError('Invalid status.');
  const updated = await store.update(req.params.id, (exp) => ({
    ...exp,
    status,
    updatedAt: new Date().toISOString(),
  }));
  if (!updated) return res.status(404).json({ error: 'Experience not found.' });
  res.json(updated);
});

api.delete('/experiences/:id', requireAdmin, validId, async (req, res) => {
  const existed = await store.remove(req.params.id);
  if (!existed) return res.status(404).json({ error: 'Experience not found.' });
  await fsp.rm(path.join(UPLOADS_DIR, req.params.id), { recursive: true, force: true });
  res.status(204).end();
});

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use('/api', api);

// --- Production: serve the built SPA ----------------------------------------
if (fs.existsSync(DIST_DIR)) {
  app.use(
    express.static(DIST_DIR, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get('/{*splat}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// --- Errors ----------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_UPLOAD_MB} MB).` : err.message;
    return res.status(status).json({ error: message });
  }
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`[webar] API listening on http://localhost:${PORT}`);
  console.log(`[webar] data directory: ${DATA_DIR}`);
  if (!ADMIN_TOKEN) {
    console.warn(
      IS_PROD
        ? '[webar] ADMIN_TOKEN is not set — admin write operations are disabled.'
        : '[webar] ADMIN_TOKEN is not set — admin API is OPEN (development only).',
    );
  }
  if (fs.existsSync(DIST_DIR)) console.log('[webar] serving built frontend from dist/');
});
