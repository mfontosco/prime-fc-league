import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState, computeStandings, leagueStatus, isValidScore, isValidDate, drawSquads, normalizeState,
} from '../public/lib/league.js';

/** Apply results keyed by "HOME-AWAY", e.g. { 'A-B': [2, 1] }. */
function withResults(results) {
  const state = createInitialState();
  for (const m of state.matches) {
    const r = results[`${m.home}-${m.away}`];
    if (r) [m.homeGoals, m.awayGoals] = r;
  }
  return state;
}

const order = (table) => table.map((r) => r.id).join('');

test('fixtures follow the rules: a full round every Saturday, 31 Oct – 19 Dec, home and away alternating', () => {
  const { matches } = createInitialState();
  assert.equal(matches.length, 24);
  assert.deepEqual(matches.slice(0, 6).map((m) => `${m.home}-${m.away}`), ['A-B', 'C-A', 'B-C', 'B-A', 'A-C', 'C-B']);
  const days = [...new Set(matches.map((m) => m.date))];
  assert.deepEqual(days, ['2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12', '2026-12-19']);
  for (const day of days) {
    assert.equal(new Date(`${day}T12:00:00Z`).getUTCDay(), 6, `${day} is a Saturday`);
    const dayMatches = matches.filter((m) => m.date === day);
    // Each team plays 2 matches per matchday.
    for (const id of ['A', 'B', 'C']) {
      assert.equal(dayMatches.filter((m) => m.home === id || m.away === id).length, 2);
    }
  }
  for (const id of ['A', 'B', 'C']) {
    assert.equal(matches.filter((m) => m.home === id || m.away === id).length, 16);
    assert.equal(matches.filter((m) => m.home === id).length, 8);
  }
  assert.deepEqual(matches.map((m) => m.id), matches.map((_, i) => i + 1));
});

test('old 2-matchday saves move to the weekly schedule only while nothing is recorded', () => {
  const oldMatch = (id, extra = {}) => ({ id, leg: id <= 3 ? 1 : 2, date: id <= 3 ? '2026-10-31' : '2026-12-19', home: 'A', away: 'B', homeGoals: null, awayGoals: null, ...extra });
  const old = (extra) => ({ teams: [], matches: [1, 2, 3, 4, 5, 6].map((id) => oldMatch(id, id === 1 ? extra : {})) });
  assert.equal(normalizeState(old({})).matches.length, 24);
  const kept = normalizeState(old({ homeGoals: 2, awayGoals: 1 }));
  assert.equal(kept.matches.length, 6);
  assert.equal(kept.matches[0].homeGoals, 2);
  assert.equal(kept.matches[3].round, 2);
});

test('points: win 3, draw 1, loss 0', () => {
  const table = computeStandings(withResults({ 'A-B': [2, 0], 'C-A': [1, 1] }));
  const row = Object.fromEntries(table.map((r) => [r.id, r]));
  // Each pairing is played 4 times in the season; the same result is applied to all of them.
  assert.equal(row.A.points, 16);
  assert.equal(row.B.points, 0);
  assert.equal(row.C.points, 4);
  assert.equal(row.A.played, 8);
  assert.equal(row.A.gd, 8);
});

test('unplayed matches do not count', () => {
  const table = computeStandings(createInitialState());
  assert.ok(table.every((r) => r.played === 0 && r.points === 0));
});

test('tie-break 1: goal difference ranks level-on-points teams', () => {
  // A and B both 6 pts; A has better GD.
  const state = withResults({
    'A-B': [1, 0], 'B-A': [1, 0],
    'A-C': [5, 0], 'C-A': [0, 1],
    'B-C': [1, 0], 'C-B': [0, 1],
  });
  const table = computeStandings(state);
  assert.equal(order(table), 'ABC');
  assert.equal(table[0].points, table[1].points);
  assert.ok(table[0].gd > table[1].gd);
});

test('tie-break 2: head-to-head decides when points and GD are level', () => {
  // A and B: equal points and GD; A beat B 2-0 and lost 0-1 → A wins h2h on GD.
  const state = withResults({
    'A-B': [2, 0], 'B-A': [1, 0],
    'C-A': [1, 1], 'A-C': [2, 0],
    'B-C': [4, 0], 'C-B': [1, 1],
  });
  const table = computeStandings(state);
  const a = table.find((r) => r.id === 'A');
  const b = table.find((r) => r.id === 'B');
  assert.equal(a.points, b.points);
  assert.equal(a.gd, b.gd);
  assert.equal(order(table), 'ABC');
  assert.equal(a.position, 1);
  assert.equal(b.position, 2);
  assert.equal(a.tied, false);
});

test('teams level after every tie-breaker share a position', () => {
  const state = withResults({
    'A-B': [1, 1], 'B-A': [1, 1],
    'C-A': [0, 2], 'A-C': [2, 0],
    'B-C': [2, 0], 'C-B': [0, 2],
  });
  const status = leagueStatus(state);
  assert.equal(status.complete, true);
  assert.equal(status.champion, null);
  assert.equal(status.undecided, true);
  assert.deepEqual(status.leaders.map((r) => r.id).sort(), ['A', 'B']);
  assert.ok(status.leaders.every((r) => r.position === 1 && r.tied));
  assert.equal(status.table[2].position, 3);
});

test('three-way tie on points and GD uses a head-to-head mini-league among all three', () => {
  // Everyone wins once at home and loses once; GD all 0 overall. h2h is the whole league here,
  // so h2h goals scored separates them: A scored most.
  const state = withResults({
    'A-B': [3, 0], 'B-A': [3, 0],
    'C-A': [2, 0], 'A-C': [2, 0],
    'B-C': [1, 0], 'C-B': [1, 0],
  });
  const table = computeStandings(state);
  assert.ok(table.every((r) => r.points === 24 && r.gd === 0));
  assert.equal(order(table), 'ABC');
  assert.deepEqual(table.map((r) => r.position), [1, 2, 3]);
});

test('champion only once every match is played', () => {
  const partial = withResults({ 'A-B': [3, 0] });
  const s1 = leagueStatus(partial);
  assert.equal(s1.complete, false);
  assert.equal(s1.champion, null);
  assert.equal(s1.leaders[0].id, 'A');

  const full = withResults({
    'A-B': [3, 0], 'C-A': [0, 1], 'B-C': [2, 2],
    'B-A': [0, 1], 'A-C': [1, 1], 'C-B': [1, 0],
  });
  const s2 = leagueStatus(full);
  assert.equal(s2.complete, true);
  assert.equal(s2.champion.id, 'A');
  assert.equal(s2.champion.points, 40);
});

test('score validation', () => {
  assert.ok(isValidScore(0, 0));
  assert.ok(isValidScore(null, null));
  assert.ok(!isValidScore(1, null));
  assert.ok(!isValidScore(-1, 0));
  assert.ok(!isValidScore(1.5, 0));
  assert.ok(!isValidScore('2', 0));
  assert.ok(!isValidScore(100, 0));
});

test('date validation', () => {
  assert.ok(isValidDate('2026-10-31'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('31/10/2026'));
  assert.ok(!isValidDate(20261031));
});

test('pot list: 6 pots of 3 players, 18 unique players', () => {
  const { pots, draw } = createInitialState();
  assert.equal(pots.length, 6);
  assert.ok(pots.every((p) => p.players.length === 3));
  assert.equal(new Set(pots.flatMap((p) => p.players)).size, 18);
  assert.equal(draw, null);
});

test('pot draw gives every team exactly one player from each pot', () => {
  const { pots } = createInitialState();
  for (let seed = 0; seed < 50; seed++) {
    let x = seed;
    const rand = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
    const { squads } = drawSquads(pots, ['A', 'B', 'C'], rand);
    const all = Object.values(squads).flat();
    assert.equal(all.length, 18);
    assert.equal(new Set(all.map((s) => s.player)).size, 18, 'no player drawn twice');
    for (const squad of Object.values(squads)) {
      assert.deepEqual(squad.map((s) => s.pot), ['A', 'B', 'C', 'D', 'E', 'F']);
      for (const { pot, player } of squad) {
        assert.ok(pots.find((p) => p.id === pot).players.includes(player));
      }
    }
  }
});

test('pot draw is actually random across draws', () => {
  const { pots } = createInitialState();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const { squads } = drawSquads(pots, ['A', 'B', 'C'], (n) => Math.floor(Math.random() * n));
    seen.add(squads.A[0].player);
  }
  assert.equal(seen.size, 3, 'each Pot A player can land in Team A');
});

test('pot draw rejects a pot that does not match the number of teams', () => {
  const pots = [{ id: 'A', players: ['x', 'y'] }];
  assert.throws(() => drawSquads(pots, ['A', 'B', 'C'], () => 0), /Pot A/);
});

test('normalizeState upgrades a save from before pots existed', () => {
  const { teams, matches } = createInitialState();
  const s = normalizeState({ teams, matches });
  assert.equal(s.pots.length, 6);
  assert.equal(s.draw, null);
});
