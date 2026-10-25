import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, computeStandings } from '../public/lib/league.js';
import { matchdayReportHtml, stateAsOf } from '../public/lib/report.js';

function seasonWithTwoDays() {
  const s = createInitialState();
  s.teams = [{ id: 'A', name: 'Mega Primers' }, { id: 'B', name: 'Veteran Primers' }, { id: 'C', name: 'Legendary <Primers>' }];
  const day1 = s.matches.filter((m) => m.date === '2026-10-31');
  const day2 = s.matches.filter((m) => m.date === '2026-11-07');
  for (const m of day1) [m.homeGoals, m.awayGoals] = [2, 1];
  for (const m of day2) [m.homeGoals, m.awayGoals] = [0, 3];
  day1[0].events = [{ id: '1', type: 'goal', team: 'A', player: 'Theo', assist: 'Ugo' }, { id: '2', type: 'yellow', team: 'B', player: 'Iyke' }];
  day1[0].motm = 'Theo';
  day1[0].bestDefender = 'Ugo';
  day1[0].report = 'Tight game <b>in the rain</b>';
  return s;
}

test('stateAsOf: results after the date are treated as unplayed', () => {
  const s = seasonWithTwoDays();
  const after1 = computeStandings(stateAsOf(s, '2026-10-31'));
  assert.ok(after1.every((r) => r.played === 2));
  const after2 = computeStandings(stateAsOf(s, '2026-11-07'));
  assert.ok(after2.every((r) => r.played === 4));
});

test('matchday report: results, goal details, awards and the table after that day', () => {
  const html = matchdayReportHtml(seasonWithTwoDays(), '2026-10-31', { origin: 'https://example.test' });
  assert.match(html, /Matchday 1 · Saturday,? 31 October 2026/);
  assert.match(html, /Mega Primers/);
  assert.match(html, /2 – 1/);
  assert.doesNotMatch(html, /0 – 3/, 'only that day\'s matches are listed');
  assert.match(html, /⚽ Theo <span class="muted">\(assist: Ugo\)<\/span>/);
  assert.match(html, /🟨 Iyke/);
  assert.match(html, /Man of the match: <strong>Theo<\/strong>/);
  assert.match(html, /Best defender: <strong>Ugo<\/strong>/);
  assert.match(html, /League table after Matchday 1/);
  assert.equal((html.match(/<tr>\s*<td>/g) || []).length, 3);
});

test('matchday report: names and reports are HTML-escaped', () => {
  const html = matchdayReportHtml(seasonWithTwoDays(), '2026-10-31');
  assert.match(html, /Legendary &lt;Primers&gt;/);
  assert.match(html, /Tight game &lt;b&gt;in the rain&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>in the rain/);
});
