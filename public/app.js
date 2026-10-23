import {
  leagueStatus, isPlayed, playerStats, recordedGoals, matchPlayers, squadOf, teamOf, allPlayers, matchdays,
  MAX_REPORT, MAX_PHOTOS,
} from '/lib/league.js';

const REFRESH_MS = 30_000;
const PIN_KEY = 'primefc.adminPin';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

let state = null;
let adminPin = safeGet(PIN_KEY);
let confirmingRedraw = false;
let availDate = null;
const openDetails = new Set(); // match ids whose admin details panel is open, kept across re-renders

function safeGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch { /* ignore */ }
}

/** Tiny DOM builder. Text is always set via textContent, so user data can't inject HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);

function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function formatDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function signed(n) { return n > 0 ? `+${n}` : String(n); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(adminPin ? { 'X-Admin-PIN': adminPin } : {}), ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}

// ---------- Rendering ----------

function render() {
  const status = leagueStatus(state);
  const names = new Map(state.teams.map((t) => [t.id, t.name]));
  renderStatus(status, names);
  renderTable(status);
  renderStats(names);
  renderSquads(names);
  renderAvailability(names);
  renderFixtures(names);
  renderTeamsAdmin();
  renderAdminArea();
}

function renderStatus(status, names) {
  const el = $('status');
  const pct = Math.round((status.played / status.total) * 100);
  let headline;
  let sub;
  if (status.champion) {
    headline = h('div', { class: 'champion' },
      h('span', { class: 'trophy', 'aria-hidden': 'true' }, '🏆'),
      h('div', {},
        h('p', { class: 'label' }, 'League Champion'),
        h('p', { class: 'name' }, status.champion.name)));
    sub = `${status.champion.points} points · GD ${signed(status.champion.gd)}`;
  } else if (status.undecided) {
    headline = h('p', { class: 'name' }, `Level at the top: ${status.leaders.map((r) => r.name).join(' & ')}`);
    sub = 'Still level after points, goal difference and head-to-head. The rules set no further tie-breaker.';
  } else if (status.played === 0) {
    headline = h('p', { class: 'name' }, 'Kick-off: Saturday 31 October');
    sub = 'No results yet. The table updates as soon as scores are entered.';
  } else {
    const leaders = status.leaders.map((r) => r.name).join(' & ');
    headline = h('div', {}, h('p', { class: 'label' }, status.leaders.length > 1 ? 'Joint leaders' : 'Top of the table'), h('p', { class: 'name' }, leaders));
    sub = `${status.leaders[0].points} points`;
  }
  el.replaceChildren(
    headline,
    h('p', { class: 'sub' }, sub),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(status.total), 'aria-valuenow': String(status.played) },
      h('span', { style: `width:${pct}%` })),
    h('p', { class: 'progress-label' }, `${status.played} of ${status.total} matches played`),
    h('a', { class: 'btn whatsapp', href: `https://wa.me/?text=${encodeURIComponent(shareText(status, names))}`, target: '_blank', rel: 'noopener' },
      h('span', { 'aria-hidden': 'true' }, '💬'), ' Share table on WhatsApp'),
  );
  el.classList.toggle('is-champion', Boolean(status.champion));
}

/** Plain-text summary for WhatsApp: table, latest results and top scorer. */
function shareText(status, names) {
  const lines = ['🏆 *PRIME FC Mini 4-a-side League*', ''];
  if (status.champion) lines.push(`👑 Champion: *${status.champion.name}*`, '');
  for (const r of status.table) {
    lines.push(`${r.tied ? `${r.position}=` : r.position}. ${r.name}: ${r.points} pts (P${r.played}, GD ${signed(r.gd)})`);
  }
  const results = state.matches.filter(isPlayed);
  if (results.length) {
    lines.push('', '*Results*');
    for (const m of results) lines.push(`${names.get(m.home)} ${m.homeGoals}–${m.awayGoals} ${names.get(m.away)}`);
  }
  const top = playerStats(state).find((r) => r.goals > 0);
  if (top) lines.push('', `⚽ Top scorer: ${top.player} (${top.goals})`);
  lines.push('', `${status.played}/${status.total} matches played`, location.origin);
  return lines.join('\n');
}

function renderTable(status) {
  const rows = status.table.map((r) => h('tr', { class: r.position === 1 && status.played > 0 ? 'leader' : '' },
    h('td', { class: 'pos' }, r.tied ? `${r.position}=` : r.position),
    h('th', { scope: 'row', class: 'team' }, r.name),
    h('td', {}, r.played), h('td', {}, r.won), h('td', {}, r.drawn), h('td', {}, r.lost),
    h('td', { class: 'hide-sm' }, r.gf), h('td', { class: 'hide-sm' }, r.ga),
    h('td', {}, signed(r.gd)),
    h('td', { class: 'pts' }, r.points)));
  $('table-body').replaceChildren(...rows);

  const usedH2h = status.played > 0 && status.table.some((r) => r.h2h);
  $('table-note').textContent = usedH2h
    ? 'Teams level on points and goal difference are separated by head-to-head record. "=" marks a shared position.'
    : 'Ranked by points, then goal difference, then head-to-head.';
}

function renderStats(names) {
  const stats = playerStats(state);
  const teamLabel = (r) => (r.team ? names.get(r.team) : '');

  const block = (title, rows, cols, empty) => h('div', { class: 'stat-block' },
    h('h3', {}, title),
    rows.length
      ? h('table', { class: 'mini' },
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col', class: c.cls || '' }, c.label)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h(c.head ? 'th' : 'td', { class: c.cls || '', ...(c.head ? { scope: 'row' } : {}) }, c.value(r)))))))
      : h('p', { class: 'empty' }, empty));

  const scorers = stats.filter((r) => r.goals > 0);
  const motm = stats.filter((r) => r.motm > 0).sort((a, b) => b.motm - a.motm || a.player.localeCompare(b.player));
  const cards = stats.filter((r) => r.yellow || r.red).sort((a, b) => b.red - a.red || b.yellow - a.yellow);

  $('stats').replaceChildren(
    block('⚽ Top scorers', scorers, [
      { label: 'Player', head: true, value: (r) => r.player },
      { label: 'Team', cls: 'muted', value: teamLabel },
      { label: 'Goals', cls: 'num', value: (r) => r.goals },
    ], 'No goals recorded yet.'),
    block('⭐ Man of the match', motm, [
      { label: 'Player', head: true, value: (r) => r.player },
      { label: 'Team', cls: 'muted', value: teamLabel },
      { label: 'Awards', cls: 'num', value: (r) => r.motm },
    ], 'No awards yet.'),
    block('🟨 Discipline', cards, [
      { label: 'Player', head: true, value: (r) => r.player },
      { label: 'Team', cls: 'muted', value: teamLabel },
      { label: '🟨', cls: 'num', value: (r) => r.yellow },
      { label: '🟥', cls: 'num', value: (r) => r.red },
    ], 'No cards. Clean game so far.'),
  );
}

function renderSquads(names) {
  const { draw, pots } = state;

  $('pots').replaceChildren(...pots.map((p) => h('div', { class: 'pot' },
    h('p', { class: 'pot-name' }, `Pot ${p.id}`),
    h('ul', {}, p.players.map((name) => h('li', {}, name))))));

  const parts = [];
  if (draw) {
    parts.push(h('div', { class: 'squads' }, state.teams.map((t) => h('div', { class: 'squad' },
      h('p', { class: 'squad-name' }, names.get(t.id)),
      h('ol', {}, (draw.squads[t.id] || []).map(({ pot, player }) => h('li', {},
        h('span', {}, player),
        h('span', { class: 'pot-tag', title: `From Pot ${pot}` }, pot))))))));
    parts.push(h('p', { class: 'note' }, `Drawn ${new Date(draw.drawnAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}. One player from each pot per team.`));
  } else {
    parts.push(h('p', { class: 'empty' }, 'Squads haven\'t been drawn yet. Each team will get one player from every pot.'));
  }

  if (adminPin) {
    const actions = h('div', { class: 'draw-actions' });
    if (!draw) {
      actions.append(h('button', { class: 'btn primary', onclick: () => runDraw(false) }, 'Run the draw'));
    } else if (confirmingRedraw) {
      actions.append(
        h('span', { class: 'warn' }, 'Replace the current squads?'),
        h('button', { class: 'btn primary', onclick: () => { confirmingRedraw = false; runDraw(true); } }, 'Yes, redraw'),
        h('button', { class: 'btn ghost', onclick: () => { confirmingRedraw = false; render(); } }, 'Cancel'));
    } else {
      actions.append(h('button', { class: 'btn ghost', onclick: () => { confirmingRedraw = true; render(); } }, 'Redraw squads'));
    }
    parts.push(actions);
  }
  $('squads').replaceChildren(...parts);
}

async function runDraw(redraw) {
  await send('POST', '/api/draw', { redraw }, 'Squads drawn');
}

// ---------- Availability ----------

const AVAIL_LABELS = { yes: ['✅', 'Available'], maybe: ['❔', 'Maybe'], no: ['❌', 'Not available'] };
const NEEDED = 4; // 4-a-side

function defaultAvailDate() {
  const days = matchdays(state);
  const today = new Date().toISOString().slice(0, 10);
  return days.find((d) => d >= today) ?? days[days.length - 1];
}

function renderAvailability(names) {
  const days = matchdays(state);
  if (!days.includes(availDate)) availDate = defaultAvailDate();
  const marks = state.availability[availDate] ?? {};

  const picker = h('div', { class: 'day-picker', role: 'tablist', 'aria-label': 'Matchday' }, days.map((d, i) => h('button', {
    class: `chip ${d === availDate ? 'active' : ''}`,
    role: 'tab',
    'aria-selected': String(d === availDate),
    onclick: () => { availDate = d; render(); },
  }, `Matchday ${i + 1} · ${formatDate(d)}`)));

  const playerRow = (player) => h('li', { class: 'avail-row' },
    h('span', { class: 'avail-name' }, player),
    h('span', { class: 'seg', role: 'group', 'aria-label': `${player} availability` },
      Object.entries(AVAIL_LABELS).map(([status, [icon, label]]) => h('button', {
        class: `seg-btn ${marks[player] === status ? `on ${status}` : ''}`,
        'aria-pressed': String(marks[player] === status),
        title: label,
        onclick: () => setAvailability(player, marks[player] === status ? null : status),
      }, h('span', { 'aria-hidden': 'true' }, icon), h('span', { class: 'sr-only' }, label)))));

  const summary = (players) => {
    const count = (st) => players.filter((p) => marks[p] === st).length;
    const yes = count('yes');
    return h('p', { class: `avail-summary ${state.draw && yes < NEEDED ? 'short' : ''}` },
      `✅ ${yes} · ❔ ${count('maybe')} · ❌ ${count('no')}`,
      state.draw && yes < NEEDED ? ` · needs ${NEEDED - yes} more` : '');
  };

  const groups = state.draw
    ? state.teams.map((t) => {
      const players = squadOf(state, t.id);
      return h('div', { class: 'avail-team' }, h('p', { class: 'squad-name' }, names.get(t.id)), summary(players), h('ul', {}, players.map(playerRow)));
    })
    : [h('div', { class: 'avail-team' }, summary(allPlayers(state)), h('ul', {}, [...allPlayers(state)].sort().map(playerRow)))];

  $('availability').replaceChildren(
    picker,
    h('p', { class: 'note' }, 'Tap your name\'s button to say if you can play. Tap it again to clear.'),
    h('div', { class: 'avail-grid' }, groups));
}

async function setAvailability(player, status) {
  try {
    state = await api('/api/availability', { method: 'PUT', body: JSON.stringify({ date: availDate, player, status }) });
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Fixtures ----------

function renderFixtures(names) {
  const byDate = new Map();
  for (const m of [...state.matches].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)) {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  let matchday = 0;
  const groups = [...byDate].map(([date, matches]) => h('div', { class: 'matchday' },
    h('h3', {}, h('span', { class: 'md' }, `Matchday ${++matchday}`), ' ', formatDate(date)),
    h('ol', { class: 'matches' }, matches.map((m) => matchRow(m, names)))));
  $('fixtures').replaceChildren(...groups);
}

function eventLabel(e) {
  if (e.type === 'goal') return `⚽ ${e.player}${e.ownGoal ? ' (og)' : ''}`;
  return `${e.type === 'red' ? '🟥' : '🟨'} ${e.player}`;
}

/** Scorers, cards, MOTM, report and photos, shown to everyone. */
function matchExtras(m) {
  const side = (team) => h('ul', { class: 'events' }, m.events.filter((e) => e.team === team).map((e) => h('li', {}, eventLabel(e))));
  const parts = [];
  if (m.events.length) parts.push(h('div', { class: 'events-row' }, side(m.home), side(m.away)));
  if (m.motm) parts.push(h('p', { class: 'motm' }, '⭐ Man of the match: ', h('strong', {}, m.motm)));
  if (m.report) parts.push(h('p', { class: 'report' }, m.report));
  if (m.photos.length) {
    parts.push(h('div', { class: 'photos' }, m.photos.map((p) => h('a', { href: `/uploads/${p}`, target: '_blank', rel: 'noopener' },
      h('img', { src: `/uploads/${p}`, alt: `Match ${m.id} photo`, loading: 'lazy' })))));
  }
  return parts;
}

function matchRow(m, names) {
  const played = isPlayed(m);
  const legTag = h('span', { class: 'leg' }, `Match ${m.id}`);

  if (!adminPin) {
    const score = played
      ? h('span', { class: 'score' }, `${m.homeGoals} – ${m.awayGoals}`)
      : h('span', { class: 'score vs' }, 'vs');
    const outcome = (side) => {
      if (!played) return '';
      const [mine, theirs] = side === 'home' ? [m.homeGoals, m.awayGoals] : [m.awayGoals, m.homeGoals];
      return mine > theirs ? 'win' : mine < theirs ? 'loss' : 'draw';
    };
    return h('li', { class: `match ${played ? 'played' : ''}` },
      legTag,
      h('div', { class: 'line' },
        h('span', { class: `side home ${outcome('home')}` }, names.get(m.home)),
        score,
        h('span', { class: `side away ${outcome('away')}` }, names.get(m.away))),
      matchExtras(m));
  }

  // Admin editing row
  const homeIn = h('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric', value: played ? String(m.homeGoals) : '', 'aria-label': `${names.get(m.home)} goals` });
  const awayIn = h('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric', value: played ? String(m.awayGoals) : '', 'aria-label': `${names.get(m.away)} goals` });
  const dateIn = h('input', { type: 'date', value: m.date, 'aria-label': `Match ${m.id} date` });

  const save = async (e) => {
    e.preventDefault();
    const parse = (v) => (v.trim() === '' ? null : Number(v));
    await send('PUT', `/api/matches/${m.id}`, { homeGoals: parse(homeIn.value), awayGoals: parse(awayIn.value), date: dateIn.value }, 'Result saved');
  };
  const clear = () => send('PUT', `/api/matches/${m.id}`, { homeGoals: null, awayGoals: null }, 'Result cleared');

  return h('li', { class: 'match editing' },
    legTag,
    h('form', { class: 'line edit', onsubmit: save },
      h('span', { class: 'side home' }, names.get(m.home)),
      h('span', { class: 'score-inputs' }, homeIn, h('span', { 'aria-hidden': 'true' }, '–'), awayIn),
      h('span', { class: 'side away' }, names.get(m.away)),
      h('div', { class: 'edit-actions' },
        dateIn,
        h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
        played ? h('button', { type: 'button', class: 'btn ghost', onclick: clear }, 'Clear') : null)),
    matchDetailsAdmin(m, names));
}

/** Admin panel: goal/card events, man of the match, report and photos. */
function matchDetailsAdmin(m, names) {
  const players = matchPlayers(state, m);
  const other = (team) => (team === m.home ? m.away : m.home);

  // Events list
  const eventsList = m.events.length
    ? h('ul', { class: 'event-list' }, m.events.map((e) => h('li', {},
      h('span', {}, eventLabel(e), h('span', { class: 'muted' }, ` · ${names.get(e.team)}`)),
      h('button', { type: 'button', class: 'btn ghost small', 'aria-label': `Remove ${eventLabel(e)}`, onclick: () => send('DELETE', `/api/matches/${m.id}/events/${e.id}`, undefined, 'Removed') }, 'Remove'))))
    : h('p', { class: 'empty' }, 'No goals or cards recorded.');

  // Score vs recorded goals check
  const rec = recordedGoals(m);
  const mismatch = isPlayed(m) && m.events.some((e) => e.type === 'goal') && (rec.home !== m.homeGoals || rec.away !== m.awayGoals);

  // Add event form. After the draw the team is worked out from the player.
  const typeSel = h('select', { 'aria-label': 'Event type' },
    h('option', { value: 'goal' }, '⚽ Goal'), h('option', { value: 'og' }, '⚽ Own goal'),
    h('option', { value: 'yellow' }, '🟨 Yellow card'), h('option', { value: 'red' }, '🟥 Red card'));
  const playerSel = playerSelect(players, names, 'Player');
  const teamSel = state.draw ? null : h('select', { 'aria-label': 'Credited to' },
    [m.home, m.away].map((t) => h('option', { value: t }, names.get(t))));
  const addEvent = async (e) => {
    e.preventDefault();
    const player = playerSel.value;
    if (!player) return toast('Pick a player', 'error');
    const ownGoal = typeSel.value === 'og';
    let team = teamSel?.value;
    if (state.draw) team = ownGoal ? other(teamOf(state, player)) : teamOf(state, player);
    await send('POST', `/api/matches/${m.id}/events`, { type: ownGoal ? 'goal' : typeSel.value, team, player, ownGoal }, 'Added');
  };

  // MOTM + report
  const motmSel = playerSelect(players, names, 'Man of the match', m.motm);
  const reportIn = h('textarea', { rows: '3', maxlength: String(MAX_REPORT), placeholder: 'Match report (optional)', 'aria-label': 'Match report' });
  reportIn.value = m.report;
  const saveDetails = (e) => {
    e.preventDefault();
    send('PUT', `/api/matches/${m.id}`, { motm: motmSel.value || null, report: reportIn.value }, 'Details saved');
  };

  // Photos
  const fileIn = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Add photo', onchange: () => uploadPhoto(m, fileIn) });
  const photos = h('div', { class: 'photos admin' },
    m.photos.map((p) => h('div', { class: 'photo' },
      h('img', { src: `/uploads/${p}`, alt: `Match ${m.id} photo`, loading: 'lazy' }),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => send('DELETE', `/api/matches/${m.id}/photos/${p}`, undefined, 'Photo removed') }, 'Remove'))),
    m.photos.length < MAX_PHOTOS ? h('label', { class: 'upload' }, '＋ Add photo', fileIn) : null);

  const details = h('details', { class: 'match-details', open: openDetails.has(m.id) },
    h('summary', {}, `Goals, cards & report${m.events.length ? ` (${m.events.length})` : ''}`),
    h('div', { class: 'detail-section' },
      h('h4', {}, 'Goals & cards'),
      eventsList,
      mismatch ? h('p', { class: 'warn' }, `Recorded goals (${rec.home}–${rec.away}) don't match the score (${m.homeGoals}–${m.awayGoals}).`) : null,
      h('form', { class: 'inline-form', onsubmit: addEvent }, typeSel, playerSel, teamSel, h('button', { type: 'submit', class: 'btn primary' }, 'Add'))),
    h('form', { class: 'detail-section', onsubmit: saveDetails },
      h('h4', {}, 'Man of the match & report'),
      motmSel,
      reportIn,
      h('button', { type: 'submit', class: 'btn primary' }, 'Save details')),
    h('div', { class: 'detail-section' }, h('h4', {}, `Photos (${m.photos.length}/${MAX_PHOTOS})`), photos));
  details.addEventListener('toggle', () => (details.open ? openDetails.add(m.id) : openDetails.delete(m.id)));
  return details;
}

/** Player <select>, grouped by team after the draw. */
function playerSelect(players, names, label, selected = null) {
  const opt = (p) => h('option', { value: p, selected: p === selected }, p);
  const groups = state.draw
    ? state.teams.map((t) => {
      const squad = squadOf(state, t.id).filter((p) => players.includes(p));
      return squad.length ? h('optgroup', { label: names.get(t.id) }, squad.map(opt)) : null;
    })
    : [...players].sort().map(opt);
  return h('select', { 'aria-label': label }, h('option', { value: '' }, `${label}…`), groups);
}

async function uploadPhoto(m, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > MAX_PHOTO_BYTES) { input.value = ''; return toast('Photo must be 5 MB or smaller', 'error'); }
  try {
    state = await api(`/api/matches/${m.id}/photos`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    toast('Photo added');
    render();
  } catch (err) {
    handleError(err);
  }
}

function renderTeamsAdmin() {
  const section = $('teams-admin');
  section.hidden = !adminPin;
  if (!adminPin) return;
  const form = $('teams-form');
  const fields = state.teams.map((t) => h('label', {},
    h('span', {}, `Team ${t.id}`),
    h('input', { type: 'text', name: t.id, value: t.name, maxlength: '30', required: true })));
  form.onsubmit = async (e) => {
    e.preventDefault();
    for (const t of state.teams) {
      const name = form.elements[t.id].value.trim();
      if (name !== t.name) await send('PUT', `/api/teams/${t.id}`, { name }, 'Team names saved');
    }
  };
  form.replaceChildren(...fields, h('button', { type: 'submit', class: 'btn primary' }, 'Save names'));
}

function renderAdminArea() {
  const area = $('admin-area');
  if (adminPin) {
    area.replaceChildren(
      h('span', { class: 'admin-badge' }, 'Admin mode'),
      h('button', { class: 'btn ghost', onclick: () => { adminPin = null; safeSet(PIN_KEY, null); render(); } }, 'Log out'));
    return;
  }
  const pinIn = h('input', { type: 'password', placeholder: 'Admin PIN', autocomplete: 'current-password', 'aria-label': 'Admin PIN', required: true });
  const form = h('form', { class: 'login', hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    try {
      await fetch('/api/login', { method: 'POST', body: JSON.stringify({ pin: pinIn.value }) })
        .then((r) => { if (!r.ok) throw new Error('Wrong PIN'); });
      adminPin = pinIn.value;
      safeSet(PIN_KEY, adminPin);
      toast('Admin mode on');
      render();
    } catch (err) {
      toast(err.message, 'error');
      pinIn.select();
    }
  } }, pinIn, h('button', { type: 'submit', class: 'btn primary' }, 'Enter'));
  const open = h('button', { class: 'btn ghost small', onclick: () => { open.hidden = true; form.hidden = false; pinIn.focus(); } }, 'Admin');
  area.replaceChildren(open, form);
}

// ---------- Data ----------

function handleError(err) {
  if (err.status === 401) { adminPin = null; safeSet(PIN_KEY, null); render(); }
  toast(err.message, 'error');
}

async function send(method, path, body, okMsg) {
  try {
    state = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    toast(okMsg);
    render();
  } catch (err) {
    handleError(err);
  }
}

async function refresh() {
  try {
    state = await api('/api/state');
    render();
  } catch (err) {
    console.error('[app] failed to load league', err);
    if (!state) $('status').replaceChildren(h('p', { class: 'name' }, 'Could not load the league. Is the server running?'));
  }
}

refresh();
// Viewers get live updates; admins are left alone so a refresh never wipes a half-typed score.
setInterval(() => { if (!adminPin && document.visibilityState === 'visible') refresh(); }, REFRESH_MS);
