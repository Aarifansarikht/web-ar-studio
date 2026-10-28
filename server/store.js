import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Minimal JSON-file persistence for experience metadata.
 *
 * Writes are serialised through a promise queue and committed atomically
 * (write to a temp file, then rename) so a crash never leaves a half-written
 * database. This is suitable for a single-instance deployment; for horizontal
 * scaling replace it with a real database (see README).
 */
export class ExperienceStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'experiences.json');
    this.queue = Promise.resolve();
    this.cache = null;
  }

  async #load() {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cache = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.cache = { experiences: {} };
    }
    return this.cache;
  }

  async #commit(db) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, this.file);
    this.cache = db;
  }

  /** Run a read-modify-write transaction exclusively. */
  #transact(fn) {
    const run = this.queue.then(async () => {
      const db = structuredClone(await this.#load());
      const result = await fn(db);
      await this.#commit(db);
      return result;
    });
    // Keep the queue alive even if this transaction fails.
    this.queue = run.catch(() => {});
    return run;
  }

  async list() {
    const db = await this.#load();
    return Object.values(db.experiences).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) {
    const db = await this.#load();
    return db.experiences[id] ?? null;
  }

  create(experience) {
    return this.#transact((db) => {
      db.experiences[experience.id] = experience;
      return experience;
    });
  }

  update(id, updater) {
    return this.#transact(async (db) => {
      const current = db.experiences[id];
      if (!current) return null;
      const next = await updater(structuredClone(current));
      db.experiences[id] = next;
      return next;
    });
  }

  remove(id) {
    return this.#transact((db) => {
      const existed = Boolean(db.experiences[id]);
      delete db.experiences[id];
      return existed;
    });
  }
}
