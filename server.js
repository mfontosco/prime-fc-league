// PRIME FC Mini League — zero-dependency Node server.
// Serves the web app and a small JSON API; results persist to data/league.json.
// Anyone can view; editing requires the admin PIN (env ADMIN_PIN).

import http from 'node:http';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { timingSafeEqual, createHash, randomInt, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialState, normalizeState, drawSquads, isValidScore, isValidDate,
  validateEvent, matchPlayers, allPlayers, matchdays, AVAILABILITY, MAX_REPORT, MAX_PHOTOS,
} from './src/league.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Whitelisted static files only — no filesystem path handling from the URL.
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/lib/league.js': ['src/league.js', 'text/javascript; charset=utf-8'],
};

const MAX_BODY = 10 * 1024;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_NAME = 30;

// Accepted photo formats, identified by their leading "magic" bytes rather than trusting the client.
const PHOTO_TYPES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
const PHOTO_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

function pinMatches(given, expected) {
  if (typeof given !== 'string') return false;
  // Hash both sides so lengths match for timingSafeEqual.
  const h = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

function send(res, status, body) {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req) {
  const raw = await readRaw(req, MAX_BODY);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function createLeagueServer({ dataFile, adminPin }) {
  const uploadsDir = path.join(path.dirname(dataFile), 'uploads');
  let state = null;
  let writeQueue = Promise.resolve();

  async function load() {
    if (state) return state;
    if (existsSync(dataFile)) {
      state = normalizeState(JSON.parse(await readFile(dataFile, 'utf8')));
    } else {
      state = createInitialState();
      await persist();
    }
    return state;
  }

  // Serialise writes and replace the file atomically so a crash never leaves half a file.
  function persist() {
    writeQueue = writeQueue.then(async () => {
      await mkdir(path.dirname(dataFile), { recursive: true });
      const tmp = `${dataFile}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, dataFile);
    });
    return writeQueue;
  }

  function requireAdmin(req, res) {
    if (pinMatches(req.headers['x-admin-pin'], adminPin)) return true;
    send(res, 401, { error: 'Admin PIN required' });
    return false;
  }

  async function handleApi(req, res, url) {
    const s = await load();

    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, s);

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { pin } = await readBody(req);
      return pinMatches(pin, adminPin) ? send(res, 200, { ok: true }) : send(res, 401, { error: 'Wrong PIN' });
    }

    const matchRoute = url.pathname.match(/^\/api\/matches\/(\d+)$/);
    if (req.method === 'PUT' && matchRoute) {
      if (!requireAdmin(req, res)) return;
      const match = s.matches.find((m) => m.id === Number(matchRoute[1]));
      if (!match) return send(res, 404, { error: 'Match not found' });
      const body = await readBody(req);
      const homeGoals = 'homeGoals' in body ? body.homeGoals : match.homeGoals;
      const awayGoals = 'awayGoals' in body ? body.awayGoals : match.awayGoals;
      if (!isValidScore(homeGoals, awayGoals)) {
        return send(res, 400, { error: 'Scores must both be whole numbers 0–99, or both empty' });
      }
      if ('date' in body && !isValidDate(body.date)) return send(res, 400, { error: 'Date must be YYYY-MM-DD' });
      if ('motm' in body && body.motm !== null && !matchPlayers(s, match).includes(body.motm)) {
        return send(res, 400, { error: 'Man of the match must be a player from one of the two teams' });
      }
      if ('report' in body && (typeof body.report !== 'string' || body.report.length > MAX_REPORT)) {
        return send(res, 400, { error: `Report must be text of at most ${MAX_REPORT} characters` });
      }
      Object.assign(match, { homeGoals, awayGoals });
      if ('date' in body) match.date = body.date;
      if ('motm' in body) match.motm = body.motm;
      if ('report' in body) match.report = body.report.trim();
      await persist();
      return send(res, 200, s);
    }

    const findMatch = (id) => s.matches.find((m) => m.id === Number(id));

    const eventsRoute = url.pathname.match(/^\/api\/matches\/(\d+)\/events(?:\/([\w-]+))?$/);
    if (eventsRoute) {
      if (!requireAdmin(req, res)) return;
      const match = findMatch(eventsRoute[1]);
      if (!match) return send(res, 404, { error: 'Match not found' });
      if (req.method === 'POST' && !eventsRoute[2]) {
        const body = await readBody(req);
        const error = validateEvent(s, match, body);
        if (error) return send(res, 400, { error });
        const ev = { id: randomUUID(), type: body.type, team: body.team, player: body.player };
        if (body.ownGoal) ev.ownGoal = true;
        match.events.push(ev);
        await persist();
        return send(res, 200, s);
      }
      if (req.method === 'DELETE' && eventsRoute[2]) {
        const before = match.events.length;
        match.events = match.events.filter((e) => e.id !== eventsRoute[2]);
        if (match.events.length === before) return send(res, 404, { error: 'Event not found' });
        await persist();
        return send(res, 200, s);
      }
    }

    const photosRoute = url.pathname.match(/^\/api\/matches\/(\d+)\/photos(?:\/([^/]+))?$/);
    if (photosRoute) {
      if (!requireAdmin(req, res)) return;
      const match = findMatch(photosRoute[1]);
      if (!match) return send(res, 404, { error: 'Match not found' });
      if (req.method === 'POST' && !photosRoute[2]) {
        if (match.photos.length >= MAX_PHOTOS) return send(res, 400, { error: `At most ${MAX_PHOTOS} photos per match` });
        const data = await readRaw(req, MAX_PHOTO_BYTES);
        const type = PHOTO_TYPES.find((t) => data.length > 12 && t.test(data));
        if (!type) return send(res, 400, { error: 'Photo must be a JPEG, PNG or WebP image' });
        const name = `${randomBytes(16).toString('hex')}.${type.ext}`;
        await mkdir(uploadsDir, { recursive: true });
        await writeFile(path.join(uploadsDir, name), data);
        match.photos.push(name);
        await persist();
        return send(res, 200, s);
      }
      if (req.method === 'DELETE' && photosRoute[2]) {
        const name = photosRoute[2];
        if (!match.photos.includes(name)) return send(res, 404, { error: 'Photo not found' });
        match.photos = match.photos.filter((p) => p !== name);
        await persist();
        if (PHOTO_NAME.test(name)) await unlink(path.join(uploadsDir, name)).catch(() => {});
        return send(res, 200, s);
      }
    }

    // Availability is open to everyone: players mark themselves for each matchday.
    if (req.method === 'PUT' && url.pathname === '/api/availability') {
      const { date, player, status } = await readBody(req);
      if (!matchdays(s).includes(date)) return send(res, 400, { error: 'Not a matchday' });
      if (!allPlayers(s).includes(player)) return send(res, 400, { error: 'Unknown player' });
      if (status !== null && !AVAILABILITY.includes(status)) return send(res, 400, { error: 'Status must be yes, maybe, no or null' });
      s.availability[date] ??= {};
      if (status === null) delete s.availability[date][player];
      else s.availability[date][player] = status;
      await persist();
      return send(res, 200, s);
    }

    const teamRoute = url.pathname.match(/^\/api\/teams\/([A-Z])$/);
    if (req.method === 'PUT' && teamRoute) {
      if (!requireAdmin(req, res)) return;
      const team = s.teams.find((t) => t.id === teamRoute[1]);
      if (!team) return send(res, 404, { error: 'Team not found' });
      const { name } = await readBody(req);
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean || clean.length > MAX_NAME) return send(res, 400, { error: `Name must be 1–${MAX_NAME} characters` });
      team.name = clean;
      await persist();
      return send(res, 200, s);
    }

    if (url.pathname === '/api/draw' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const { redraw } = await readBody(req);
      // Never silently overwrite a published draw.
      if (s.draw && redraw !== true) return send(res, 409, { error: 'Squads already drawn. Confirm a redraw to replace them.' });
      const { squads } = drawSquads(s.pots, s.teams.map((t) => t.id), randomInt);
      s.draw = { drawnAt: new Date().toISOString(), squads };
      await persist();
      return send(res, 200, s);
    }

    if (url.pathname === '/api/draw' && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      s.draw = null;
      await persist();
      return send(res, 200, s);
    }

    return send(res, 404, { error: 'Not found' });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      const upload = req.method === 'GET' && url.pathname.match(/^\/uploads\/([^/]+)$/);
      if (upload && PHOTO_NAME.test(upload[1])) {
        const ext = upload[1].split('.').pop();
        const content = await readFile(path.join(uploadsDir, upload[1])).catch(() => null);
        if (!content) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': PHOTO_TYPES.find((t) => t.ext === ext).mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(content);
      }
      const entry = req.method === 'GET' && STATIC[url.pathname];
      if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      const content = await readFile(path.join(ROOT, entry[0]));
      res.writeHead(200, { 'Content-Type': entry[1] });
      res.end(content);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(`[server] ${req.method} ${url.pathname} failed:`, err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : err.message });
    }
  });
}

// Vercel entry point: Vercel imports this module and calls the default export per request.
// Its filesystem is read-only apart from /tmp, which is wiped on cold starts, so data saved
// there is TEMPORARY until persistent storage is added. Static files come from public/ via the CDN.
let vercelServer;
export default function handler(req, res) {
  if (!vercelServer) {
    let adminPin = process.env.ADMIN_PIN;
    if (!adminPin) {
      // Never fall back to the well-known default PIN on a public deployment: admin stays locked instead.
      adminPin = randomBytes(32).toString('hex');
      console.error('[server] ADMIN_PIN is not set — admin login is disabled. Add ADMIN_PIN in the Vercel project settings.');
    }
    vercelServer = createLeagueServer({ dataFile: process.env.DATA_FILE || '/tmp/prime-fc/league.json', adminPin });
  }
  vercelServer.emit('request', req, res);
}

// Run directly: `npm start`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  let adminPin = process.env.ADMIN_PIN;
  if (!adminPin) {
    adminPin = 'prime2026';
    console.warn('[server] ADMIN_PIN not set — using default PIN "prime2026". Set ADMIN_PIN before sharing the app.');
  }
  const dataFile = process.env.DATA_FILE || path.join(ROOT, 'data', 'league.json');
  const server = createLeagueServer({ dataFile, adminPin });
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`[server] Port ${port} is already in use by another program.`);
    console.error(`[server] Start on a different port instead, e.g.:  PORT=${port + 1} npm start`);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`[server] PRIME FC League running at http://localhost:${port}`);
  });
}
