import { leagueStatus, isPlayed } from '/lib/league.js';

const REFRESH_MS = 30_000;
const PIN_KEY = 'primefc.adminPin';

let state = null;
let adminPin = safeGet(PIN_KEY);

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
  renderStatus(status);
  renderTable(status);
  renderSquads(names);
  renderFixtures(names);
  renderTeamsAdmin();
  renderAdminArea();
}

function renderStatus(status) {
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
  );
  el.classList.toggle('is-champion', Boolean(status.champion));
}

function signed(n) { return n > 0 ? `+${n}` : String(n); }

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

let confirmingRedraw = false;

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
  try {
    state = await api('/api/draw', { method: 'POST', body: JSON.stringify({ redraw }) });
    toast('Squads drawn');
    render();
  } catch (err) {
    if (err.status === 401) { adminPin = null; safeSet(PIN_KEY, null); render(); }
    toast(err.message, 'error');
  }
}

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

function matchRow(m, names) {
  const played = isPlayed(m);
  const legTag = h('span', { class: 'leg' }, `Match ${m.id} · Leg ${m.leg}`);

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
        h('span', { class: `side away ${outcome('away')}` }, names.get(m.away))));
  }

  // Admin editing row
  const homeIn = h('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric', value: played ? String(m.homeGoals) : '', 'aria-label': `${names.get(m.home)} goals` });
  const awayIn = h('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric', value: played ? String(m.awayGoals) : '', 'aria-label': `${names.get(m.away)} goals` });
  const dateIn = h('input', { type: 'date', value: m.date, 'aria-label': `Match ${m.id} date` });

  const save = async (e) => {
    e.preventDefault();
    const parse = (v) => (v.trim() === '' ? null : Number(v));
    const body = { homeGoals: parse(homeIn.value), awayGoals: parse(awayIn.value), date: dateIn.value };
    await mutate(`/api/matches/${m.id}`, body, 'Result saved');
  };
  const clear = async () => {
    await mutate(`/api/matches/${m.id}`, { homeGoals: null, awayGoals: null }, 'Result cleared');
  };

  return h('li', { class: 'match editing' },
    legTag,
    h('form', { class: 'line edit', onsubmit: save },
      h('span', { class: 'side home' }, names.get(m.home)),
      h('span', { class: 'score-inputs' }, homeIn, h('span', { 'aria-hidden': 'true' }, '–'), awayIn),
      h('span', { class: 'side away' }, names.get(m.away)),
      h('div', { class: 'edit-actions' },
        dateIn,
        h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
        played ? h('button', { type: 'button', class: 'btn ghost', onclick: clear }, 'Clear') : null)));
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
      if (name !== t.name) await mutate(`/api/teams/${t.id}`, { name }, 'Team names saved');
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

async function mutate(path, body, okMsg) {
  try {
    state = await api(path, { method: 'PUT', body: JSON.stringify(body) });
    toast(okMsg);
    render();
  } catch (err) {
    if (err.status === 401) { adminPin = null; safeSet(PIN_KEY, null); render(); }
    toast(err.message, 'error');
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
