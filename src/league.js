// PRIME FC Mini 4-a-side League — pure league logic.
// Shared by the server (validation, seeding) and the browser (rendering).
// No I/O here, so everything is unit-testable.

export const POINTS = { win: 3, draw: 1, loss: 0 };
export const TEAM_IDS = ['A', 'B', 'C'];
export const MAX_GOALS = 99;

// Fixture progression from the rules: A v B, C v A, B v C.
// The second leg reverses home and away.
const FIRST_LEG = [
  ['A', 'B'],
  ['C', 'A'],
  ['B', 'C'],
];

export const DEFAULT_DATES = { leg1: '2026-10-31', leg2: '2026-12-19' };

// Official Prime FC pot list. Each team gets exactly one player from every pot.
export const DEFAULT_POTS = [
  { id: 'A', players: ['Theo', 'Iyke', 'Chairman'] },
  { id: 'B', players: ['Ugo', 'Chinedu', 'Ororo'] },
  { id: 'C', players: ['Valencia', 'Chuks', 'Obigod'] },
  { id: 'D', players: ['Obilinks', 'Akpos', 'Okwelle'] },
  { id: 'E', players: ['Joe', 'David', 'Olise'] },
  { id: 'F', players: ['Favour', 'Korede', 'Lucky'] },
];

/** Fill in fields added after a data file was first created, so older saves keep working. */
export function normalizeState(state) {
  return {
    ...state,
    pots: state.pots ?? structuredClone(DEFAULT_POTS),
    draw: state.draw ?? null,
  };
}

/**
 * Pot draw: shuffle each pot and hand one player to each team.
 * `randomInt(n)` must return an integer in [0, n); injected so the server can
 * use crypto randomness and tests can be deterministic.
 * Returns { squads: { [teamId]: [{ pot, player }] } }.
 */
export function drawSquads(pots, teamIds, randomInt) {
  for (const pot of pots) {
    if (pot.players.length !== teamIds.length) {
      throw new Error(`Pot ${pot.id} has ${pot.players.length} players; it needs exactly ${teamIds.length}`);
    }
  }
  const squads = Object.fromEntries(teamIds.map((id) => [id, []]));
  for (const pot of pots) {
    const shuffled = [...pot.players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    teamIds.forEach((teamId, i) => squads[teamId].push({ pot: pot.id, player: shuffled[i] }));
  }
  return { squads };
}

/** Build the initial league state: 3 teams, 6 fixtures, no results, pots not yet drawn. */
export function createInitialState(dates = DEFAULT_DATES) {
  const teams = TEAM_IDS.map((id) => ({ id, name: `Team ${id}` }));
  const matches = [];
  FIRST_LEG.forEach(([home, away], i) => {
    matches.push({ id: i + 1, leg: 1, date: dates.leg1, home, away, homeGoals: null, awayGoals: null });
  });
  FIRST_LEG.forEach(([home, away], i) => {
    matches.push({ id: i + 4, leg: 2, date: dates.leg2, home: away, away: home, homeGoals: null, awayGoals: null });
  });
  return { teams, matches, pots: structuredClone(DEFAULT_POTS), draw: null };
}

export function isPlayed(m) {
  return Number.isInteger(m.homeGoals) && Number.isInteger(m.awayGoals);
}

/** A score is valid when both sides are integers 0..MAX_GOALS, or both are null (unplayed). */
export function isValidScore(homeGoals, awayGoals) {
  if (homeGoals === null && awayGoals === null) return true;
  const ok = (g) => Number.isInteger(g) && g >= 0 && g <= MAX_GOALS;
  return ok(homeGoals) && ok(awayGoals);
}

export function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function emptyRow(id) {
  return { id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 };
}

/** Accumulate a table from played matches, optionally restricted to a subset of teams. */
function tally(teamIds, matches) {
  const rows = new Map(teamIds.map((id) => [id, emptyRow(id)]));
  for (const m of matches) {
    if (!isPlayed(m) || !rows.has(m.home) || !rows.has(m.away)) continue;
    const h = rows.get(m.home);
    const a = rows.get(m.away);
    h.played++; a.played++;
    h.gf += m.homeGoals; h.ga += m.awayGoals;
    a.gf += m.awayGoals; a.ga += m.homeGoals;
    if (m.homeGoals > m.awayGoals) { h.won++; a.lost++; }
    else if (m.homeGoals < m.awayGoals) { a.won++; h.lost++; }
    else { h.drawn++; a.drawn++; }
  }
  for (const r of rows.values()) {
    r.gd = r.gf - r.ga;
    r.points = r.won * POINTS.win + r.drawn * POINTS.draw + r.lost * POINTS.loss;
  }
  return rows;
}

/** Split an already-sorted list into runs of rows where keyFn is equal. */
function groupRuns(rows, keyFn) {
  const runs = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && keyFn(last[0]) === keyFn(r)) last.push(r);
    else runs.push([r]);
  }
  return runs;
}

/**
 * Compute the ranked league table.
 *
 * Ranking (from the rules): points → goal difference → head-to-head.
 * Head-to-head is a mini-table of matches *between the tied teams only*:
 * h2h points, then h2h goal difference, then h2h goals scored.
 * Teams still level after that share a position (`tied: true`); the rules
 * define no further criteria, so the app does not invent one.
 */
export function computeStandings(state) {
  const ids = state.teams.map((t) => t.id);
  const overall = tally(ids, state.matches);
  const names = new Map(state.teams.map((t) => [t.id, t.name]));

  const byPtsGd = [...overall.values()].sort((x, y) => y.points - x.points || y.gd - x.gd);
  const ranked = [];
  for (const run of groupRuns(byPtsGd, (r) => `${r.points}|${r.gd}`)) {
    if (run.length === 1) {
      ranked.push({ ...run[0], h2h: null, tied: false });
      continue;
    }
    const h2h = tally(run.map((r) => r.id), state.matches);
    const h2hKey = (r) => `${h2h.get(r.id).points}|${h2h.get(r.id).gd}|${h2h.get(r.id).gf}`;
    const sorted = [...run].sort((x, y) => {
      const hx = h2h.get(x.id);
      const hy = h2h.get(y.id);
      return hy.points - hx.points || hy.gd - hx.gd || hy.gf - hx.gf;
    });
    for (const sub of groupRuns(sorted, h2hKey)) {
      for (const r of sub) ranked.push({ ...r, h2h: h2h.get(r.id), tied: sub.length > 1 });
    }
  }

  // Assign positions; teams that remain level share the same position.
  let position = 0;
  return ranked.map((r, i) => {
    const prev = ranked[i - 1];
    const sameAsPrev = prev && r.tied && prev.tied && prev.points === r.points && prev.gd === r.gd
      && prev.h2h && r.h2h && prev.h2h.points === r.h2h.points && prev.h2h.gd === r.h2h.gd && prev.h2h.gf === r.h2h.gf;
    if (!sameAsPrev) position = i + 1;
    return { ...r, position, name: names.get(r.id) };
  });
}

/**
 * League status.
 * - `complete`: all 6 matches have results.
 * - `champion`: the team at the top once complete, or null when the top spot is
 *   still level after every tie-breaker (`undecided: true`).
 * - `leader`: the current top team(s) while the league is in progress.
 */
export function leagueStatus(state) {
  const table = computeStandings(state);
  const played = state.matches.filter(isPlayed).length;
  const total = state.matches.length;
  const complete = played === total;
  const top = table.filter((r) => r.position === 1);
  return {
    played,
    total,
    complete,
    table,
    leaders: top,
    champion: complete && top.length === 1 ? top[0] : null,
    undecided: complete && top.length > 1,
  };
}
