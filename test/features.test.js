import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createInitialState, normalizeState, validateEvent, playerStats, recordedGoals, squadOf, teamOf, validateSquads, DEFAULT_POTS,
} from '../public/lib/league.js';
import { createLeagueServer } from '../server.js';

// A fixed draw so tests know who plays where.
function drawnState() {
  const s = createInitialState();
  s.draw = {
    drawnAt: '2026-10-24T10:00:00Z',
    squads: {
      A: ['Theo', 'Ugo', 'Valencia', 'Obilinks', 'Joe', 'Favour'].map((player, i) => ({ pot: 'ABCDEF'[i], player })),
      B: ['Iyke', 'Chinedu', 'Chuks', 'Akpos', 'David', 'Korede'].map((player, i) => ({ pot: 'ABCDEF'[i], player })),
      C: ['Chairman', 'Ororo', 'Obigod', 'Okwelle', 'Olise', 'Lucky'].map((player, i) => ({ pot: 'ABCDEF'[i], player })),
    },
  };
  return s;
}

// ---------- Pure logic ----------

test('new match fields default sensibly, including for old saves', () => {
  const s = createInitialState();
  assert.deepEqual([s.matches[0].events, s.matches[0].motm, s.matches[0].bestDefender, s.matches[0].report, s.matches[0].photos], [[], null, null, '', []]);
  assert.deepEqual(s.availability, {});
  const old = normalizeState({ teams: s.teams, matches: s.matches.map(({ id, home, away, date, leg }) => ({ id, home, away, date, leg })) });
  assert.deepEqual(old.matches[0].events, []);
});

test('squad helpers', () => {
  const s = drawnState();
  assert.equal(squadOf(s, 'A').length, 6);
  assert.equal(teamOf(s, 'Iyke'), 'B');
  assert.equal(teamOf(createInitialState(), 'Iyke'), null);
});

test('validateEvent: goals and cards must come from the right team', () => {
  const s = drawnState();
  const m = s.matches[0]; // A v B
  assert.equal(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Theo' }), null);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Iyke' }), /not in that team/);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'C', player: 'Chairman' }), /two sides/);
  assert.equal(validateEvent(s, m, { type: 'yellow', team: 'B', player: 'Iyke' }), null);
  assert.match(validateEvent(s, m, { type: 'penalty', team: 'A', player: 'Theo' }), /type/);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Messi' }), /Unknown/);
});

test('validateEvent: own goals are credited to the other side', () => {
  const s = drawnState();
  const m = s.matches[0]; // A v B
  assert.equal(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Iyke', ownGoal: true }), null);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Theo', ownGoal: true }), /other team/);
  assert.match(validateEvent(s, m, { type: 'red', team: 'A', player: 'Theo', ownGoal: true }), /Only goals/);
});

test('validateEvent: assists come from a teammate of the scorer, on goals only', () => {
  const s = drawnState();
  const m = s.matches[0]; // A v B
  assert.equal(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Theo', assist: 'Ugo' }), null);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Theo', assist: 'Iyke' }), /scoring team/);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Theo', assist: 'Theo' }), /own goal/);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Theo', assist: 'Messi' }), /Unknown assist/);
  assert.match(validateEvent(s, m, { type: 'yellow', team: 'A', player: 'Theo', assist: 'Ugo' }), /Only goals/);
  assert.match(validateEvent(s, m, { type: 'goal', team: 'A', player: 'Iyke', ownGoal: true, assist: 'Ugo' }), /Only goals/);
});

test('before the draw any registered player is accepted', () => {
  const s = createInitialState();
  assert.equal(validateEvent(s, s.matches[0], { type: 'goal', team: 'A', player: 'Lucky' }), null);
});

test('playerStats: top scorers, own goals separate, cards and MOTM counted', () => {
  const s = drawnState();
  s.matches[0].events = [
    { id: '1', type: 'goal', team: 'A', player: 'Theo' },
    { id: '2', type: 'goal', team: 'A', player: 'Theo' },
    { id: '3', type: 'goal', team: 'A', player: 'Iyke', ownGoal: true },
    { id: '4', type: 'goal', team: 'B', player: 'Chuks' },
    { id: '5', type: 'yellow', team: 'B', player: 'Chuks' },
    { id: '6', type: 'red', team: 'B', player: 'Akpos' },
  ];
  s.matches[0].events[0].assist = 'Ugo';
  s.matches[0].events[1].assist = 'Ugo';
  s.matches[0].motm = 'Theo';
  s.matches[1].motm = 'Theo';
  s.matches[0].bestDefender = 'Akpos';
  const stats = playerStats(s);
  const by = Object.fromEntries(stats.map((r) => [r.player, r]));
  assert.equal(stats[0].player, 'Theo');
  assert.equal(by.Theo.goals, 2);
  assert.equal(by.Theo.motm, 2);
  assert.equal(by.Theo.team, 'A');
  assert.equal(by.Iyke.goals, 0);
  assert.equal(by.Iyke.ownGoals, 1);
  assert.equal(by.Chuks.yellow, 1);
  assert.equal(by.Akpos.red, 1);
  assert.equal(by.Ugo.assists, 2);
  assert.equal(by.Ugo.goals, 0);
  assert.equal(by.Akpos.bestDefender, 1);
  assert.equal(by.Theo.bestDefender, 0);
  assert.deepEqual(recordedGoals(s.matches[0]), { home: 3, away: 1 });
});

// The squads the team picked by hand for the 2026 season.
const PICKED = {
  A: ['Theo', 'Ugo', 'Valencia', 'Obilinks', 'David', 'Favour'],
  B: ['Iyke', 'Chinedu', 'Obigod', 'Okwelle', 'Joe', 'Korede'],
  C: ['Chairman', 'Ororo', 'Chuks', 'Akpos', 'Olise', 'Lucky'],
};

test('validateSquads: accepts one player per pot per team, rejects anything else', () => {
  const { squads, error } = validateSquads(DEFAULT_POTS, ['A', 'B', 'C'], PICKED);
  assert.equal(error, undefined);
  assert.deepEqual(squads.A.map((e) => e.pot), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(squads.A.find((e) => e.pot === 'E').player, 'David');
  const swap = (team, i, player) => ({ ...PICKED, [team]: PICKED[team].map((p, j) => (j === i ? player : p)) });
  assert.match(validateSquads(DEFAULT_POTS, ['A', 'B', 'C'], swap('A', 4, 'Joe')).error, /more than one team/);
  assert.match(validateSquads(DEFAULT_POTS, ['A', 'B', 'C'], swap('A', 4, 'Korede')).error, /two players from Pot F/);
  assert.match(validateSquads(DEFAULT_POTS, ['A', 'B', 'C'], swap('A', 0, 'Messi')).error, /Unknown player/);
  assert.match(validateSquads(DEFAULT_POTS, ['A', 'B', 'C'], { ...PICKED, A: PICKED.A.slice(0, 5) }).error, /exactly 6/);
});

// ---------- API ----------

const PIN = 'test-pin';
let server;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'prime-features-'));
  server = createLeagueServer({ dataFile: path.join(dir, 'league.json'), adminPin: PIN });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method, p, body, { pin = PIN, raw, type = 'application/json' } = {}) => fetch(base + p, {
  method,
  headers: { 'Content-Type': type, ...(pin ? { 'X-Admin-PIN': pin } : {}) },
  body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('API: add and remove goal events (admin only)', async () => {
  assert.equal((await call('POST', '/api/matches/1/events', { type: 'goal', team: 'A', player: 'Theo' }, { pin: null })).status, 401);
  const res = await call('POST', '/api/matches/1/events', { type: 'goal', team: 'A', player: 'Theo' });
  assert.equal(res.status, 200);
  const ev = (await res.json()).matches[0].events[0];
  assert.equal(ev.player, 'Theo');
  assert.ok(ev.id);
  assert.equal((await call('POST', '/api/matches/1/events', { type: 'goal', team: 'C', player: 'Theo' })).status, 400);
  assert.equal((await call('DELETE', `/api/matches/1/events/${ev.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/matches/1/events/${ev.id}`)).status, 404);
});

test('API: man of the match and match report', async () => {
  assert.equal((await call('PUT', '/api/matches/1', { motm: 'Theo', report: '  Great game!  ' })).status, 200);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.matches[0].motm, 'Theo');
  assert.equal(s.matches[0].report, 'Great game!');
  assert.equal((await call('PUT', '/api/matches/1', { motm: 'Messi' })).status, 400);
  assert.equal((await call('PUT', '/api/matches/1', { report: 'x'.repeat(2001) })).status, 400);
  assert.equal((await call('PUT', '/api/matches/1', { motm: null })).status, 200);
});

test('API: best defender award and goal assists', async () => {
  assert.equal((await call('PUT', '/api/matches/1', { bestDefender: 'Iyke' })).status, 200);
  let s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.matches[0].bestDefender, 'Iyke');
  assert.equal((await call('PUT', '/api/matches/1', { bestDefender: 'Messi' })).status, 400);
  assert.equal((await call('PUT', '/api/matches/1', { bestDefender: null })).status, 200);

  const res = await call('POST', '/api/matches/1/events', { type: 'goal', team: 'A', player: 'Theo', assist: 'Ugo' });
  assert.equal(res.status, 200);
  s = await res.json();
  const ev = s.matches[0].events.at(-1);
  assert.equal(ev.assist, 'Ugo');
  assert.equal((await call('POST', '/api/matches/1/events', { type: 'goal', team: 'A', player: 'Theo', assist: 'Theo' })).status, 400);
  await call('DELETE', `/api/matches/1/events/${ev.id}`);
});

test('API: photo upload accepts real images only and serves them back', async () => {
  assert.equal((await call('POST', '/api/matches/1/photos', undefined, { raw: PNG, type: 'image/png', pin: null })).status, 401);
  assert.equal((await call('POST', '/api/matches/1/photos', undefined, { raw: Buffer.from('<script>alert(1)</script> not an image'), type: 'image/png' })).status, 400);

  const res = await call('POST', '/api/matches/1/photos', undefined, { raw: PNG, type: 'image/png' });
  assert.equal(res.status, 200);
  const name = (await res.json()).matches[0].photos[0];
  assert.match(name, /^[a-f0-9]{32}\.png$/);

  const img = await fetch(`${base}/uploads/${name}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/uploads/..%2Fleague.json`)).status, 404);

  assert.equal((await call('DELETE', `/api/matches/1/photos/${name}`)).status, 200);
  assert.equal(existsSync(path.join(dir, 'uploads', name)), false);
});

test('API: photo upload rejects files over 5 MB', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  const res = await call('POST', '/api/matches/1/photos', undefined, { raw: big, type: 'image/png' }).catch(() => null);
  // The server answers 413 and drops the connection; either outcome means the upload was refused.
  assert.ok(!res || res.status === 413);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.matches[0].photos.length, 0);
});

test('API: anyone can mark availability, with validation', async () => {
  const ok = await call('PUT', '/api/availability', { date: '2026-10-31', player: 'Lucky', status: 'yes' }, { pin: null });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).availability['2026-10-31'].Lucky, 'yes');
  assert.equal((await call('PUT', '/api/availability', { date: '2026-11-01', player: 'Lucky', status: 'yes' }, { pin: null })).status, 400);
  assert.equal((await call('PUT', '/api/availability', { date: '2026-10-31', player: 'Messi', status: 'yes' }, { pin: null })).status, 400);
  assert.equal((await call('PUT', '/api/availability', { date: '2026-10-31', player: 'Lucky', status: 'perhaps' }, { pin: null })).status, 400);
  const cleared = await call('PUT', '/api/availability', { date: '2026-10-31', player: 'Lucky', status: null }, { pin: null });
  assert.equal((await cleared.json()).availability['2026-10-31'].Lucky, undefined);
});

// Runs last: it sets squads, which changes event validation for the shared server.
test('API: squads can be set by hand (admin only, confirm to replace)', async () => {
  assert.equal((await call('PUT', '/api/squads', { squads: PICKED }, { pin: null })).status, 401);
  assert.equal((await call('PUT', '/api/squads', { squads: { ...PICKED, A: PICKED.B } })).status, 400);
  const res = await call('PUT', '/api/squads', { squads: PICKED });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.draw.manual, true);
  assert.equal(teamOf(s, 'David'), 'A');
  assert.equal(teamOf(s, 'Joe'), 'B');
  assert.equal((await call('PUT', '/api/squads', { squads: PICKED })).status, 409);
  assert.equal((await call('PUT', '/api/squads', { squads: PICKED, replace: true })).status, 200);
});
