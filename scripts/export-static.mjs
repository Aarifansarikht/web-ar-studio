// Exports published experiences (metadata + uploaded files) into public/ so a
// static host such as Vercel can serve them without the Node API.
//
//   npm run export:static
//
// Output:
//   public/static-data/index.json              list of published experiences
//   public/static-data/experiences/<id>.json   one experience
//   public/uploads/<id>/...                    its files (same URLs as the API)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  // no .env
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'server/data');
const OUT_DATA = path.join(ROOT, 'public', 'static-data');
const OUT_UPLOADS = path.join(ROOT, 'public', 'uploads');

const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'experiences.json'), 'utf8'));
const published = Object.values(db.experiences)
  .filter((e) => e.status === 'published')
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

fs.rmSync(OUT_DATA, { recursive: true, force: true });
fs.rmSync(OUT_UPLOADS, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_DATA, 'experiences'), { recursive: true });

let bytes = 0;
for (const exp of published) {
  const urls = [exp.target.imageUrl, exp.target.mindUrl, exp.content.url, exp.brand?.logoUrl, exp.brand?.coverUrl];
  for (const url of urls.filter(Boolean)) {
    const rel = url.replace(/^\/uploads\//, '');
    const src = path.join(DATA_DIR, 'uploads', rel);
    const dst = path.join(OUT_UPLOADS, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    bytes += fs.statSync(dst).size;
  }
  fs.writeFileSync(path.join(OUT_DATA, 'experiences', `${exp.id}.json`), JSON.stringify(exp, null, 2));
  console.log(`exported ${exp.id}  ${exp.name}`);
}
fs.writeFileSync(path.join(OUT_DATA, 'index.json'), JSON.stringify(published, null, 2));
console.log(`${published.length} experiences, ${(bytes / 1024 / 1024).toFixed(1)} MB of assets → public/`);
