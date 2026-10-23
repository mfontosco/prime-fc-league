import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLeagueServer } from '../server.js';

const PIN = 'test-pin';
let server;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'prime-league-'));
  server = createLeagueServer({ dataFile: path.join(dir, 'league.json'), adminPin: PIN });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const put = (p, body, pin = PIN) => fetch(base + p, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...(pin ? { 'X-Admin-PIN': pin } : {}) },
  body: JSON.stringify(body),
});

test('GET /api/state seeds the league', async () => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.teams.length, 3);
  assert.equal(s.matches.length, 24);
});

test('serves the app and shared league module', async () => {
  for (const p of ['/', '/app.js', '/styles.css', '/lib/league.js']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  assert.equal((await fetch(`${base}/data/league.json`)).status, 404);
});

test('login checks the PIN', async () => {
  const ok = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ pin: PIN }) });
  const bad = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ pin: 'nope' }) });
  assert.equal(ok.status, 200);
  assert.equal(bad.status, 401);
});

test('editing requires the admin PIN', async () => {
  assert.equal((await put('/api/matches/1', { homeGoals: 1, awayGoals: 0 }, null)).status, 401);
  assert.equal((await put('/api/matches/1', { homeGoals: 1, awayGoals: 0 }, 'wrong')).status, 401);
  assert.equal((await put('/api/teams/A', { name: 'X' }, null)).status, 401);
});

test('records a result and persists it to disk', async () => {
  const res = await put('/api/matches/1', { homeGoals: 3, awayGoals: 2 });
  assert.equal(res.status, 200);
  const saved = JSON.parse(readFileSync(path.join(dir, 'league.json'), 'utf8'));
  const m = saved.matches.find((x) => x.id === 1);
  assert.deepEqual([m.homeGoals, m.awayGoals], [3, 2]);
});

test('clearing a result is allowed; half or invalid scores are rejected', async () => {
  assert.equal((await put('/api/matches/1', { homeGoals: null, awayGoals: null })).status, 200);
  assert.equal((await put('/api/matches/1', { homeGoals: 2, awayGoals: null })).status, 400);
  assert.equal((await put('/api/matches/1', { homeGoals: -1, awayGoals: 0 })).status, 400);
  assert.equal((await put('/api/matches/1', { homeGoals: 'x', awayGoals: 0 })).status, 400);
  assert.equal((await put('/api/matches/99', { homeGoals: 1, awayGoals: 0 })).status, 404);
});

test('match dates can be changed and are validated', async () => {
  assert.equal((await put('/api/matches/4', { date: '2026-11-07' })).status, 200);
  assert.equal((await put('/api/matches/4', { date: 'next week' })).status, 400);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.matches.find((m) => m.id === 4).date, '2026-11-07');
});

test('team names can be renamed and are validated', async () => {
  assert.equal((await put('/api/teams/A', { name: '  Prime Lions ' })).status, 200);
  assert.equal((await put('/api/teams/A', { name: '' })).status, 400);
  assert.equal((await put('/api/teams/A', { name: 'x'.repeat(31) })).status, 400);
  assert.equal((await put('/api/teams/Z', { name: 'Nope' })).status, 404);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.teams.find((t) => t.id === 'A').name, 'Prime Lions');
});

test('rejects malformed JSON', async () => {
  const res = await fetch(`${base}/api/matches/1`, {
    method: 'PUT', headers: { 'X-Admin-PIN': PIN }, body: '{not json',
  });
  assert.equal(res.status, 400);
});

const post = (p, body, pin = PIN) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(pin ? { 'X-Admin-PIN': pin } : {}) },
  body: JSON.stringify(body),
});

test('pot draw: admin only, saved, and never silently overwritten', async () => {
  assert.equal((await post('/api/draw', {}, null)).status, 401);

  const first = await post('/api/draw', {});
  assert.equal(first.status, 200);
  const s1 = await first.json();
  assert.ok(s1.draw.drawnAt);
  assert.deepEqual(Object.keys(s1.draw.squads).sort(), ['A', 'B', 'C']);
  assert.ok(Object.values(s1.draw.squads).every((sq) => sq.length === 6));

  assert.equal((await post('/api/draw', {})).status, 409);
  assert.equal((await post('/api/draw', { redraw: true })).status, 200);

  const saved = JSON.parse(readFileSync(path.join(dir, 'league.json'), 'utf8'));
  assert.ok(saved.draw);

  const del = await fetch(`${base}/api/draw`, { method: 'DELETE', headers: { 'X-Admin-PIN': PIN } });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).draw, null);
});
