// Storage backends for the league server. Both expose the same interface:
//   load()                  → { state, rev }   (state is null when nothing is saved yet)
//   save(state, rev)        → resolves, or throws ConflictError if someone else saved since load()
//   putPhoto(name, buf, mime) / getPhoto(name) → Buffer|null / deletePhoto(name)
//
// - File store: data/league.json + data/uploads/ — local development and single-server hosting.
// - Cloud store: Upstash Redis (league state) + Vercel Blob (photos) — serverless hosting such as
//   Vercel, where the filesystem is not persistent. Plain fetch calls, no SDK dependencies.

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class ConflictError extends Error {
  constructor() { super('Someone else saved at the same moment. Please try again.'); this.status = 409; }
}

export function createFileStore(dataFile) {
  const uploadsDir = path.join(path.dirname(dataFile), 'uploads');
  let cached = null;
  let currentRev = 0;
  let writeQueue = Promise.resolve();

  return {
    async load() {
      if (!cached && existsSync(dataFile)) cached = JSON.parse(await readFile(dataFile, 'utf8'));
      return { state: cached && structuredClone(cached), rev: currentRev };
    },
    // Same compare-and-set rule as the cloud store, checked in memory (one process owns the file).
    // Writes are serialised and the file is replaced atomically so a crash never leaves half a file.
    save(state, rev) {
      if (rev !== currentRev) return Promise.reject(new ConflictError());
      currentRev++;
      cached = state;
      writeQueue = writeQueue.then(async () => {
        await mkdir(path.dirname(dataFile), { recursive: true });
        const tmp = `${dataFile}.tmp`;
        await writeFile(tmp, JSON.stringify(state, null, 2));
        await rename(tmp, dataFile);
      });
      return writeQueue;
    },
    async putPhoto(name, data) {
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(path.join(uploadsDir, name), data);
    },
    getPhoto: (name) => readFile(path.join(uploadsDir, name)).catch(() => null),
    deletePhoto: (name) => unlink(path.join(uploadsDir, name)).catch(() => {}),
  };
}

const STATE_KEY = 'prime-fc:league';
const REV_KEY = 'prime-fc:league:rev';

// Compare-and-set: only write when nobody else has saved since our load. Returns the new revision, or 0.
const SAVE_SCRIPT = `
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return redis.call('INCR', KEYS[2])`;

const BLOB_API = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '13';

export function createCloudStore({ redisUrl, redisToken, blobToken }) {
  async function redis(command) {
    const res = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      body: JSON.stringify(command),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Redis ${command[0]} failed: ${res.status} ${body.error ?? ''}`);
    return body.result;
  }

  // Vercel Blob stores are either public or private; detect which on first use.
  const storeId = blobToken?.split('_')[3] ?? '';
  let access = null;
  const blobAuth = { Authorization: `Bearer ${blobToken}`, 'x-api-version': BLOB_API_VERSION };
  const blobUrl = (name, acc) => `https://${storeId}.${acc}.blob.vercel-storage.com/photos/${name}`;

  async function blobPut(name, data, mime, acc) {
    return fetch(`${BLOB_API}/?${new URLSearchParams({ pathname: `photos/${name}` })}`, {
      method: 'PUT',
      headers: { ...blobAuth, 'x-vercel-blob-access': acc, 'x-content-type': mime, 'x-add-random-suffix': '0' },
      body: data,
    });
  }

  return {
    async load() {
      const [json, rev] = await redis(['MGET', STATE_KEY, REV_KEY]);
      return { state: json ? JSON.parse(json) : null, rev: Number(rev) || 0 };
    },
    async save(state, rev) {
      const next = await redis(['EVAL', SAVE_SCRIPT, '2', STATE_KEY, REV_KEY, String(rev), JSON.stringify(state)]);
      if (!next) throw new ConflictError();
    },
    async putPhoto(name, data, mime) {
      for (const acc of access ? [access] : ['public', 'private']) {
        const res = await blobPut(name, data, mime, acc);
        if (res.ok) { access = acc; return; }
        const detail = await res.text().catch(() => '');
        if (acc === 'public' && !access && /private/i.test(detail)) continue;
        throw new Error(`Blob upload failed: ${res.status} ${detail}`);
      }
    },
    async getPhoto(name) {
      for (const acc of access ? [access] : ['public', 'private']) {
        const res = await fetch(blobUrl(name, acc), { headers: { Authorization: `Bearer ${blobToken}` } });
        if (res.ok) { access = acc; return Buffer.from(await res.arrayBuffer()); }
      }
      return null;
    },
    async deletePhoto(name) {
      const urls = access ? [blobUrl(name, access)] : [blobUrl(name, 'public'), blobUrl(name, 'private')];
      await fetch(`${BLOB_API}/delete`, {
        method: 'POST',
        headers: { ...blobAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      }).catch(() => {});
    },
  };
}

/** Pick the cloud store when Redis credentials are configured (Vercel), otherwise the local file. */
export function storeFromEnv(env, defaultDataFile) {
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    return { store: createCloudStore({ redisUrl, redisToken, blobToken: env.BLOB_READ_WRITE_TOKEN }), kind: 'cloud' };
  }
  return { store: createFileStore(env.DATA_FILE || defaultDataFile), kind: 'file' };
}
