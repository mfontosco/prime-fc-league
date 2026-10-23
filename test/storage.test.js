import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloudStore, createFileStore, storeFromEnv, ConflictError } from '../src/storage.js';
import { createLeagueServer } from '../server.js';

const REDIS = 'https://redis.test';
const BLOB_TOKEN = 'vercel_blob_rw_store123_secret';

// Fake Upstash REST + Vercel Blob endpoints behind a mocked global fetch.
let redis;
let blobs;
let blobAccess;
let realFetch;

beforeEach(() => {
  redis = new Map();
  blobs = new Map();
  blobAccess = 'public';
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin === REDIS) {
      const [cmd, ...args] = JSON.parse(init.body);
      if (cmd === 'MGET') return Response.json({ result: args.map((k) => redis.get(k) ?? null) });
      if (cmd === 'EVAL') {
        const [, , stateKey, revKey, expected, json] = args;
        if ((redis.get(revKey) ?? '0') !== expected) return Response.json({ result: 0 });
        redis.set(stateKey, json);
        const next = Number(redis.get(revKey) ?? 0) + 1;
        redis.set(revKey, String(next));
        return Response.json({ result: next });
      }
      return Response.json({ error: `unsupported ${cmd}` }, { status: 400 });
    }
    if (url.href.startsWith('https://vercel.com/api/blob/delete')) {
      for (const u of JSON.parse(init.body).urls) blobs.delete(new URL(u).pathname.slice(1));
      return Response.json({});
    }
    if (url.href.startsWith('https://vercel.com/api/blob/')) {
      const access = init.headers['x-vercel-blob-access'];
      if (access !== blobAccess) return Response.json({ error: { message: `Cannot use ${access} access on a ${blobAccess} store` } }, { status: 400 });
      blobs.set(url.searchParams.get('pathname'), Buffer.from(init.body));
      return Response.json({ url: 'ignored' });
    }
    if (url.hostname === `store123.${blobAccess}.blob.vercel-storage.com`) {
      const data = blobs.get(url.pathname.slice(1));
      return data ? new Response(data) : new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
});

afterEach(() => { globalThis.fetch = realFetch; });

const cloud = () => createCloudStore({ redisUrl: REDIS, redisToken: 't', blobToken: BLOB_TOKEN });

test('cloud store: empty, then saves and reloads with a new revision', async () => {
  const store = cloud();
  assert.deepEqual(await store.load(), { state: null, rev: 0 });
  await store.save({ hello: 1 }, 0);
  assert.deepEqual(await store.load(), { state: { hello: 1 }, rev: 1 });
});

test('cloud store: a stale save is rejected', async () => {
  const store = cloud();
  await store.save({ v: 1 }, 0);
  await assert.rejects(store.save({ v: 2 }, 0), ConflictError);
  assert.deepEqual((await store.load()).state, { v: 1 });
});

test('cloud store: photos round-trip on public and private blob stores', async () => {
  for (const access of ['public', 'private']) {
    blobAccess = access;
    const store = cloud();
    await store.putPhoto('a.png', Buffer.from('img'), 'image/png');
    assert.equal((await store.getPhoto('a.png')).toString(), 'img');
    await store.deletePhoto('a.png');
    assert.equal(await store.getPhoto('a.png'), null);
  }
});

test('file store: a stale save is rejected', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prime-store-'));
  try {
    const store = createFileStore(path.join(dir, 'league.json'));
    await store.save({ v: 1 }, 0);
    await assert.rejects(store.save({ v: 2 }, 0), ConflictError);
    assert.deepEqual(await createFileStore(path.join(dir, 'league.json')).load(), { state: { v: 1 }, rev: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('storeFromEnv: Redis credentials select the cloud store', () => {
  assert.equal(storeFromEnv({ UPSTASH_REDIS_REST_URL: REDIS, UPSTASH_REDIS_REST_TOKEN: 't' }, 'x.json').kind, 'cloud');
  assert.equal(storeFromEnv({ KV_REST_API_URL: REDIS, KV_REST_API_TOKEN: 't' }, 'x.json').kind, 'cloud');
  assert.equal(storeFromEnv({}, 'x.json').kind, 'file');
});

test('server on cloud store: concurrent availability votes are all kept', async () => {
  const server = createLeagueServer({ store: cloud(), adminPin: 'pin' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const s = await (await realFetch(`${base}/api/state`)).json();
    const date = s.matches[0].date;
    const players = s.pots.flatMap((p) => p.players).slice(0, 3);
    // Each vote loads the same revision; the losers of each race must retry on fresh state.
    const results = await Promise.all(players.map((player) => realFetch(`${base}/api/availability`, {
      method: 'PUT', body: JSON.stringify({ date, player, status: 'yes' }),
    })));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    const after = await (await realFetch(`${base}/api/state`)).json();
    assert.deepEqual(Object.keys(after.availability[date]).sort(), [...players].sort());
  } finally { server.close(); }
});
