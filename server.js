// PRIME FC Mini League — zero-dependency Node server.
// Serves the web app and a small JSON API; results persist to data/league.json.
// Anyone can view; editing requires the admin PIN (env ADMIN_PIN).

import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { timingSafeEqual, createHash, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialState, normalizeState, drawSquads, isValidScore, isValidDate,
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
const MAX_NAME = 30;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function createLeagueServer({ dataFile, adminPin }) {
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
      Object.assign(match, { homeGoals, awayGoals }, 'date' in body ? { date: body.date } : {});
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
