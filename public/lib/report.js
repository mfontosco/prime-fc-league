// Printable one-page matchday report (results, goals, cards, awards, table after the day).
// Returns a self-contained HTML document; the browser's print dialog turns it into a PDF.
// Pure string building, shared by the browser and the tests.

import { computeStandings, isPlayed, matchdays } from './league.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const signed = (n) => (n > 0 ? `+${n}` : String(n));

function longDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** The league as it stood at the end of `date`: later results are treated as unplayed. */
export function stateAsOf(state, date) {
  return {
    ...state,
    matches: state.matches.map((m) => (m.date <= date ? m : { ...m, homeGoals: null, awayGoals: null })),
  };
}

function eventText(e) {
  if (e.type === 'goal') return `⚽ ${esc(e.player)}${e.ownGoal ? ' (og)' : ''}${e.assist ? ` <span class="muted">(assist: ${esc(e.assist)})</span>` : ''}`;
  return `${e.type === 'red' ? '🟥' : '🟨'} ${esc(e.player)}`;
}

function matchBlock(m, names) {
  const played = isPlayed(m);
  const side = (team) => m.events.filter((e) => e.team === team).map((e) => `<li>${eventText(e)}</li>`).join('');
  const awards = [
    m.motm ? `⭐ Man of the match: <strong>${esc(m.motm)}</strong>` : '',
    m.bestDefender ? `🛡️ Best defender: <strong>${esc(m.bestDefender)}</strong>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `<section class="match">
  <p class="tag">Match ${m.id}</p>
  <div class="line">
    <span class="team home">${esc(names.get(m.home))}</span>
    <span class="score">${played ? `${m.homeGoals} – ${m.awayGoals}` : 'Not played'}</span>
    <span class="team away">${esc(names.get(m.away))}</span>
  </div>
  ${m.events.length ? `<div class="events"><ul>${side(m.home)}</ul><ul class="right">${side(m.away)}</ul></div>` : ''}
  ${awards ? `<p class="awards">${awards}</p>` : ''}
  ${m.report ? `<p class="report">${esc(m.report)}</p>` : ''}
</section>`;
}

export function matchdayReportHtml(state, date, { origin = '' } = {}) {
  const names = new Map(state.teams.map((t) => [t.id, t.name]));
  const day = matchdays(state).indexOf(date) + 1;
  const matches = state.matches.filter((m) => m.date === date).sort((a, b) => a.id - b.id);
  const table = computeStandings(stateAsOf(state, date));
  const rows = table.map((r) => `<tr>
    <td>${r.tied ? `${r.position}=` : r.position}</td><th>${esc(r.name)}</th>
    <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
    <td>${r.gf}</td><td>${r.ga}</td><td>${signed(r.gd)}</td><td class="pts">${r.points}</td></tr>`).join('');
  const title = `PRIME FC Matchday ${day} · ${longDate(date)}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; background: #fff; margin: 0 auto; max-width: 760px; padding: 16px; }
  header { border-bottom: 3px solid #0b3d2a; padding-bottom: 8px; margin-bottom: 14px; }
  .eyebrow { margin: 0; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #0b3d2a; font-weight: 700; }
  h1 { margin: 2px 0 0; font-size: 22px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #0b3d2a; margin: 18px 0 8px; }
  .match { border: 1px solid #d5ddd8; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; break-inside: avoid; }
  .tag { margin: 0 0 4px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: #667; }
  .line { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; font-size: 15px; font-weight: 700; }
  .home { text-align: right; } .score { min-width: 70px; text-align: center; font-variant-numeric: tabular-nums; }
  .events { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 6px; }
  .events ul { list-style: none; margin: 0; padding: 0; } .events .right { text-align: left; } .events ul:first-child { text-align: right; }
  .awards, .report { margin: 6px 0 0; } .report { color: #333; white-space: pre-wrap; }
  .muted { color: #667; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 5px 6px; border-bottom: 1px solid #e3e8e5; text-align: center; }
  tbody th { text-align: left; } thead th { font-size: 11px; color: #667; text-transform: uppercase; }
  .pts { font-weight: 700; }
  footer { margin-top: 18px; font-size: 11px; color: #667; }
  .print-btn { margin: 12px 0 0; padding: 8px 14px; font: inherit; font-weight: 600; border: 0; border-radius: 6px; background: #0b3d2a; color: #fff; cursor: pointer; }
  @media print { .print-btn { display: none; } body { padding: 0; } }
</style></head>
<body>
<header>
  <p class="eyebrow">PRIME FC Mini 4-a-side League · 2026</p>
  <h1>Matchday ${day} · ${esc(longDate(date))}</h1>
  <button class="print-btn" onclick="print()">Save as PDF / Print</button>
</header>
<h2>Results</h2>
${matches.map((m) => matchBlock(m, names)).join('\n')}
<h2>League table after Matchday ${day}</h2>
<table>
  <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<footer>Generated ${esc(new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}${origin ? ` · ${esc(origin)}` : ''}</footer>
</body></html>`;
}
