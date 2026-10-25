// PRIME FC Mini 4-a-side League — pure league logic.
// Shared by the server (validation, seeding) and the browser (rendering).
// No I/O here, so everything is unit-testable.

export const POINTS = { win: 3, draw: 1, loss: 0 };
export const TEAM_IDS = ['A', 'B', 'C'];
export const MAX_GOALS = 99;

// Fixture progression from the rules: A v B, C v A, B v C.
// One full round every Saturday; home and away swap each week.
const ROUND = [
  ['A', 'B'],
  ['C', 'A'],
  ['B', 'C'],
];

// Every Saturday from 31 Oct to 19 Dec 2026. Strictly a league: no final.
export const SEASON_START = '2026-10-31';
export const ROUNDS = 8;

// Official Prime FC pot list. Each team gets exactly one player from every pot.
export const DEFAULT_POTS = [
  { id: 'A', players: ['Theo', 'Iyke', 'Chairman'] },
  { id: 'B', players: ['Ugo', 'Chinedu', 'Ororo'] },
  { id: 'C', players: ['Valencia', 'Chuks', 'Obigod'] },
  { id: 'D', players: ['Obilinks', 'Akpos', 'Okwelle'] },
  { id: 'E', players: ['Joe', 'David', 'Olise'] },
  { id: 'F', players: ['Favour', 'Korede', 'Lucky'] },
];

export const EVENT_TYPES = ['goal', 'yellow', 'red'];
export const AVAILABILITY = ['yes', 'maybe', 'no'];
export const MAX_REPORT = 2000;
export const MAX_PHOTOS = 6;

/** Fill in fields added after a data file was first created, so older saves keep working. */
export function normalizeState(state) {
  return {
    ...state,
    matches: migrateFixtures(state.matches).map((m) => ({
      events: [], motm: null, bestDefender: null, report: '', photos: [], ...m,
    })),
    pots: state.pots ?? structuredClone(DEFAULT_POTS),
    draw: state.draw ?? null,
    availability: state.availability ?? {},
  };
}

/**
 * Saves from the original 2-matchday format (6 matches with `leg`) get the weekly schedule,
 * but only while nothing has been recorded on them, so no result is ever thrown away.
 */
function migrateFixtures(matches) {
  if (!matches.some((m) => 'leg' in m)) return matches;
  const untouched = matches.every((m) => !isPlayed(m) && !m.events?.length && !m.motm && !m.report && !m.photos?.length);
  return untouched ? buildFixtures() : matches.map(({ leg, ...m }) => ({ round: leg, ...m }));
}

// ---------- Players ----------

/** Every registered player (from the pot list). */
export function allPlayers(state) {
  return state.pots.flatMap((p) => p.players);
}

/** A team's squad as player names, or [] before the draw. */
export function squadOf(state, teamId) {
  return (state.draw?.squads[teamId] ?? []).map((s) => s.player);
}

/** The team a player was drawn into, or null. */
export function teamOf(state, player) {
  if (!state.draw) return null;
  for (const [teamId, squad] of Object.entries(state.draw.squads)) {
    if (squad.some((s) => s.player === player)) return teamId;
  }
  return null;
}

/** Players who can feature in a match: both squads after the draw, everyone before it. */
export function matchPlayers(state, match) {
  return state.draw ? [...squadOf(state, match.home), ...squadOf(state, match.away)] : allPlayers(state);
}

/**
 * Validate a match event. Returns an error message, or null when valid.
 * Event: { type: 'goal'|'yellow'|'red', team, player, ownGoal?, assist? }.
 * `team` is the side credited: the scoring side for goals (including own goals),
 * the offending side for cards. `assist` is the teammate who set up a goal.
 */
export function validateEvent(state, match, ev) {
  if (!ev || !EVENT_TYPES.includes(ev.type)) return 'Event type must be goal, yellow or red';
  if (ev.team !== match.home && ev.team !== match.away) return 'Team must be one of the two sides in this match';
  if (!allPlayers(state).includes(ev.player)) return 'Unknown player';
  if (ev.ownGoal !== undefined && typeof ev.ownGoal !== 'boolean') return 'ownGoal must be true or false';
  if (ev.ownGoal && ev.type !== 'goal') return 'Only goals can be own goals';
  if (ev.assist !== undefined && ev.assist !== null) {
    if (ev.type !== 'goal' || ev.ownGoal) return 'Only goals can have an assist';
    if (!allPlayers(state).includes(ev.assist)) return 'Unknown assist player';
    if (ev.assist === ev.player) return 'A player cannot assist their own goal';
    if (state.draw && teamOf(state, ev.assist) !== ev.team) return 'The assist must come from the scoring team';
  }
  if (state.draw) {
    const other = ev.team === match.home ? match.away : match.home;
    const expected = ev.ownGoal ? other : ev.team;
    if (teamOf(state, ev.player) !== expected) {
      return ev.ownGoal ? 'An own goal must be scored by a player from the other team' : 'Player is not in that team';
    }
  }
  return null;
}

/** Goals recorded as events per side, to compare against the entered score. */
export function recordedGoals(match) {
  const goals = match.events.filter((e) => e.type === 'goal');
  return {
    home: goals.filter((e) => e.team === match.home).length,
    away: goals.filter((e) => e.team === match.away).length,
  };
}

/**
 * Per-player season stats: goals (own goals excluded), assists, cards, and man-of-the-match
 * and best-defender awards.
 * Only players with at least one entry are returned, top scorers first.
 */
export function playerStats(state) {
  const rows = new Map();
  const row = (player) => {
    if (!rows.has(player)) rows.set(player, { player, team: teamOf(state, player), goals: 0, ownGoals: 0, assists: 0, yellow: 0, red: 0, motm: 0, bestDefender: 0 });
    return rows.get(player);
  };
  for (const m of state.matches) {
    for (const e of m.events) {
      if (e.type === 'goal') row(e.player)[e.ownGoal ? 'ownGoals' : 'goals']++;
      else row(e.player)[e.type]++;
      if (e.assist) row(e.assist).assists++;
    }
    if (m.motm) row(m.motm).motm++;
    if (m.bestDefender) row(m.bestDefender).bestDefender++;
  }
  return [...rows.values()].sort((a, b) => b.goals - a.goals || b.motm - a.motm || a.player.localeCompare(b.player));
}

/** Unique matchday dates, in order. */
export function matchdays(state) {
  return [...new Set(state.matches.map((m) => m.date))].sort();
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

/** Add whole days to a YYYY-MM-DD date. */
function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One full round per week for ROUNDS weeks; even rounds reverse home and away. */
function buildFixtures(start = SEASON_START) {
  const matches = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const date = addDays(start, (round - 1) * 7);
    for (const [home, away] of ROUND) {
      const [h, a] = round % 2 ? [home, away] : [away, home];
      matches.push({ id: matches.length + 1, round, date, home: h, away: a, homeGoals: null, awayGoals: null });
    }
  }
  return matches;
}

/** Build the initial league state: 3 teams, a weekly fixture list, no results, pots not yet drawn. */
export function createInitialState(start = SEASON_START) {
  const teams = TEAM_IDS.map((id) => ({ id, name: `Team ${id}` }));
  return normalizeState({ teams, matches: buildFixtures(start), pots: structuredClone(DEFAULT_POTS), draw: null });
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
 * - `complete`: every match has a result.
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
