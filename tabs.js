/* Attendance & Referees tabs.
   Past seasons: static snapshots in data/<season>.json (built with scripts/scrape.py).
   Current season (E2026): snapshot + live top-up — on every load/refresh the browser asks the
   Euroleague games feed which games are finished and fetches any boxscore missing from the snapshot. */
(function () {
  'use strict';

  const CURRENT = 'E2026';
  const SEASONS = [
    { code:'E2026', label:'2026–27' }, { code:'E2025', label:'2025–26' },
    { code:'E2024', label:'2024–25' }, { code:'E2023', label:'2023–24' },
    { code:'E2022', label:'2022–23' }, { code:'E2021', label:'2021–22' }
  ];
  const GAMES_FEED = s => 'https://api-live.euroleague.net/v2/competitions/E/seasons/' + s + '/games';
  const RESULTS_URL = s => 'https://api-live.euroleague.net/v1/results?seasonCode=' + s;
  const BOX_URL = (s, c) => 'https://live.euroleague.net/api/Boxscore?gamecode=' + c + '&seasoncode=' + s;
  const LTU_KEYS = ['SUKYS', 'VILIUS', 'JURGIS', 'RACYS'];     // same keywords as tempScrapeAttendance.py
  const PLAYOFF_PHASES = ['PI', 'PO', 'FF'];
  // row layout: [code, phase, round, date, home, away, homeScore, awayScore, attendance, ref1, ref2, ref3]
  const C = { code:0, phase:1, round:2, date:3, home:4, away:5, hs:6, as:7, att:8, refs:[9, 10, 11] };

  const state = { tab:'standings', season:CURRENT, phase:'ALL', search:'', ltu:false, openRef:null,
                  sort:{ att:{ k:'avg', d:-1 }, ref:{ k:'games', d:-1 } } };
  const cache = {};            // season -> data
  const loading = {};          // season -> promise

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits:1, maximumFractionDigits:1 });
  const fmtDate = d => { const x = new Date(d + 'T12:00:00Z'); return isNaN(x) ? d : x.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' }); };
  const seasonLabel = c => (SEASONS.find(s => s.code === c) || {}).label || c;
  const titleCase = s => s.toLowerCase().replace(/(^|[\s\-'])([a-zÀ-ɏ])/g, (m, a, b) => a + b.toUpperCase());
  function refName(raw) {        // "GARCIA, JUAN CARLOS" -> "Juan Carlos Garcia"
    const i = raw.indexOf(',');
    return titleCase(i < 0 ? raw : raw.slice(i + 1).trim() + ' ' + raw.slice(0, i).trim());
  }
  const isLtu = raw => LTU_KEYS.some(k => raw.indexOf(k) >= 0);

  /* ── DATA ── */
  async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' → ' + r.status); return r.json(); }

  function parseRefs(raw) {
    const p = String(raw || '').split(',').map(x => x.trim()).filter(Boolean), out = [];
    for (let i = 0; i < p.length; i += 2) out.push(p.slice(i, i + 2).join(', '));
    while (out.length < 3) out.push('');
    return out.slice(0, 3);
  }

  // List of finished games. Primary: v2 JSON feed. Fallback: v1 XML results (the v2 feed is not
  // CORS-readable from every origin, which is why the standings page has the same fallback).
  async function listPlayed(season) {
    try {
      const feed = await fetchJson(GAMES_FEED(season)), out = [];
      for (const g of (feed.data || [])) {
        const h = g.local && g.local.club, a = g.road && g.road.club;
        if (!h || !a || h.isVirtual || a.isVirtual) continue;
        out.push({ code:g.gameCode, phase:g.phaseType.code, round:g.round, date:String(g.utcDate || g.date).slice(0, 10),
                   hc:h.code, hn:h.name, ac:a.code, an:a.name, hs:g.local.score, as:g.road.score, played:!!g.played });
      }
      return out;
    } catch (e) {
      const r = await fetch(RESULTS_URL(season));
      if (!r.ok) throw new Error('Results feed \u2192 ' + r.status);
      const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
      if (xml.querySelector('parsererror')) throw new Error('Results feed could not be read');
      const PH = { RS:'RS', PI:'PI', PO:'PO', FF:'FF' }, out = [];
      for (const g of xml.querySelectorAll('game')) {
        const get = t => { const el = g.querySelector(t); return el ? el.textContent.trim() : ''; };
        const num = parseInt(get('gamecode').split('_')[1], 10), d = new Date(get('date') + ' 12:00 UTC');
        if (!num) continue;
        out.push({ code:num, phase:PH[get('round')] || (get('round') ? 'PO' : 'RS'), round:parseInt(get('gameday'), 10) || 0, date:isNaN(d) ? '' : d.toISOString().slice(0, 10),
                   hc:get('homecode'), hn:get('hometeam'), ac:get('awaycode'), an:get('awayteam'),
                   hs:parseInt(get('homescore'), 10), as:parseInt(get('awayscore'), 10), played:get('played').toLowerCase() === 'true' });
      }
      return out;
    }
  }

  async function topUp(data) {
    const feed = await listPlayed(data.season);
    const have = new Set(data.games.map(r => r[C.code]));
    const todo = [];
    for (const g of feed) {
      if (!data.teams[g.hc]) data.teams[g.hc] = titleCase(g.hn);
      if (!data.teams[g.ac]) data.teams[g.ac] = titleCase(g.an);
      if (g.played && !have.has(g.code)) todo.push(g);
    }
    let added = 0, failed = 0, i = 0;
    async function worker() {
      while (i < todo.length) {
        const g = todo[i++];
        try {
          const b = await fetchJson(BOX_URL(data.season, g.code));
          if (b.Live) continue;                                 // still in progress
          const att = parseInt(String(b.Attendance || '0').replace(/\D/g, ''), 10) || null;
          const r = parseRefs(b.Referees);
          data.games.push([g.code, g.phase, g.round, g.date, g.hc, g.ac, g.hs, g.as, att, r[0], r[1], r[2]]);
          added++;
        } catch (e) { failed++; }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    data.games.sort((a, b) => a[C.code] - b[C.code]);
    data.live = { added, failed, at: new Date() };
  }

  function loadSeason(code, force) {
    if (!force && cache[code]) return Promise.resolve(cache[code]);
    if (!force && loading[code]) return loading[code];
    loading[code] = (async () => {
      let data;
      try { data = await fetchJson('data/' + code + '.json'); }
      catch (e) {
        if (code !== CURRENT) throw e;                           // current season can run without a snapshot
        data = { season:code, teams:{}, games:[] };
      }
      if (code === CURRENT) {
        try { await topUp(data); } catch (e) { data.liveError = e.message; }
      }
      cache[code] = data;
      return data;
    })();
    loading[code].then(() => { delete loading[code]; }, () => { delete loading[code]; });
    return loading[code];
  }

  /* ── SHARED UI ── */
  function toolbar(extra) {
    const seasonOpts = SEASONS.map(s => '<option value="' + s.code + '"' + (s.code === state.season ? ' selected' : '') + '>' + s.label + (s.code === CURRENT ? ' (live)' : '') + '</option>').join('');
    const phaseOpts = [['ALL', 'All games'], ['RS', 'Regular season'], ['PO', 'Playoffs & Final Four']]
      .map(p => '<option value="' + p[0] + '"' + (p[0] === state.phase ? ' selected' : '') + '>' + p[1] + '</option>').join('');
    return '<div class="toolbar"><label>Season <select data-act="season">' + seasonOpts + '</select></label>' +
      '<label>Games <select data-act="phase">' + phaseOpts + '</select></label>' + (extra || '') + '</div>';
  }
  function liveNote(data) {
    if (data.season !== CURRENT) return '';
    let h = '';
    if (data.liveError) h += '<div class="warn-box">Could not reach the live Euroleague feed (' + esc(data.liveError) + '). Showing the last saved snapshot — try Refresh.</div>';
    else if (data.live && data.live.failed) h += '<div class="warn-box">' + data.live.failed + ' recent game(s) could not be loaded yet — try Refresh in a moment.</div>';
    return h;
  }
  function inPhase(r) {
    return state.phase === 'ALL' || (state.phase === 'RS' ? r[C.phase] === 'RS' : PLAYOFF_PHASES.indexOf(r[C.phase]) >= 0);
  }
  function stamp(data) {
    if (data.season === CURRENT && data.live && !data.liveError)
      return '<span class="live-note"><span class="live-dot"></span>Live — checked ' + data.live.at.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) + (data.live.added ? ', +' + data.live.added + ' new game' + (data.live.added > 1 ? 's' : '') : '') + '</span>';
    return '';
  }
  function teamName(data, code) { return esc(data.teams[code] || code); }
  function sortRows(rows, s) {
    return rows.sort((a, b) => {
      const x = a[s.k], y = b[s.k];
      const c = typeof x === 'string' ? x.localeCompare(y) : (x - y);
      return (c * s.d) || String(a.name).localeCompare(String(b.name));
    });
  }
  function th(tableKey, k, label, num) {
    const s = state.sort[tableKey], on = s.k === k;
    return '<th class="sortable' + (num ? ' num' : '') + (on ? ' sorted' : '') + '" data-sort="' + tableKey + ':' + k + '">' + label + (on ? (s.d < 0 ? ' ▾' : ' ▴') : '') + '</th>';
  }

  /* ── ATTENDANCE ── */
  function renderAttendance(data) {
    const games = data.games.filter(inPhase);
    const withAtt = games.filter(r => r[C.att] > 0);
    const missing = games.length - withAtt.length;
    const by = {};
    for (const r of withAtt) {
      const t = by[r[C.home]] || (by[r[C.home]] = { code:r[C.home], n:0, total:0, max:0, min:Infinity });
      t.n++; t.total += r[C.att]; t.max = Math.max(t.max, r[C.att]); t.min = Math.min(t.min, r[C.att]);
    }
    const rows = Object.values(by).map(t => ({ code:t.code, name:data.teams[t.code] || t.code, n:t.n, total:t.total, avg:t.total / t.n, max:t.max, min:t.min, pct:100 * (t.total / t.n) / t.max }));
    sortRows(rows, state.sort.att);
    const topAvg = Math.max.apply(null, rows.map(r => r.avg).concat([1]));

    let h = toolbar() + liveNote(data);
    if (!withAtt.length) return h + '<div class="tcard"><div class="empty">No attendance data available for this selection yet.</div></div>';

    const total = withAtt.reduce((s, r) => s + r[C.att], 0);
    const big = withAtt.reduce((m, r) => r[C.att] > m[C.att] ? r : m);
    h += '<div class="kpis">' +
      '<div class="kpi"><div class="kpi-label">Games with attendance</div><div class="kpi-value">' + fmt(withAtt.length) + '</div><div class="kpi-sub">' + (missing ? missing + ' without a reported figure' : 'all games reported') + '</div></div>' +
      '<div class="kpi"><div class="kpi-label">Total attendance</div><div class="kpi-value">' + fmt(total) + '</div><div class="kpi-sub">' + seasonLabel(data.season) + '</div></div>' +
      '<div class="kpi"><div class="kpi-label">Average per game</div><div class="kpi-value">' + fmt(total / withAtt.length) + '</div><div class="kpi-sub">across all home arenas</div></div>' +
      '<div class="kpi"><div class="kpi-label">Biggest crowd</div><div class="kpi-value">' + fmt(big[C.att]) + '</div><div class="kpi-sub" title="' + esc(fmtDate(big[C.date])) + '">' + teamName(data, big[C.home]) + ' vs ' + teamName(data, big[C.away]) + '</div></div></div>';

    const body = rows.map((r, i) =>
      '<tr><td class="rank">' + (i + 1) + '</td><td class="name">' + teamName(data, r.code) + '</td>' +
      '<td class="num">' + r.n + '</td><td class="num">' + fmt(r.total) + '</td>' +
      '<td class="num">' + fmt(r.avg) + '<span class="bar" style="width:' + Math.round(60 * r.avg / topAvg) + 'px"></span></td>' +
      '<td class="num">' + fmt(r.max) + '</td><td class="num">' + fmt(r.min) + '</td><td class="num">' + fmt1(r.pct) + '%</td></tr>').join('');
    const top = withAtt.slice().sort((a, b) => b[C.att] - a[C.att]).slice(0, 10).map((r, i) =>
      '<tr><td class="rank">' + (i + 1) + '</td><td class="wrap">' + teamName(data, r[C.home]) + ' <span class="muted">vs</span> ' + teamName(data, r[C.away]) +
      '<div class="muted" style="font-size:11px">' + esc(fmtDate(r[C.date])) + '</div></td><td class="num">' + fmt(r[C.att]) + '</td></tr>').join('');

    h += '<div class="split"><div><div class="section-label">Home attendance by team</div><div class="tcard"><table><thead><tr><th></th>' +
      th('att', 'name', 'Team') + th('att', 'n', 'Home games', 1) + th('att', 'total', 'Total', 1) + th('att', 'avg', 'Average', 1) +
      th('att', 'max', 'Max', 1) + th('att', 'min', 'Min', 1) + th('att', 'pct', 'Avg % of max', 1) +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>' +
      '<div><div class="section-label">Ten biggest crowds</div><div class="tcard"><table><tbody>' + top + '</tbody></table></div></div></div>' +
      '<div class="foot-note">Attendance is the figure published in each official boxscore. Games with no figure are left out of totals and averages. “Avg % of max” compares a team’s average with its own biggest home crowd of the season.</div>';
    return h;
  }

  /* ── REFEREES ── */
  function renderReferees(data) {
    const games = data.games.filter(inPhase);
    const by = {};
    for (const r of games) {
      for (const raw of C.refs.map(i => r[i]).filter(Boolean)) {
        const t = by[raw] || (by[raw] = { raw:raw, games:[], n:0, homeWins:0, pts:0, margin:0 });
        t.games.push(r); t.n++; t.homeWins += r[C.hs] > r[C.as] ? 1 : 0; t.pts += r[C.hs] + r[C.as]; t.margin += Math.abs(r[C.hs] - r[C.as]);
      }
    }
    const q = state.search.trim().toLowerCase();
    let rows = Object.values(by).map(t => ({ raw:t.raw, name:refName(t.raw), ltu:isLtu(t.raw), games:t.n, homePct:100 * t.homeWins / t.n, pts:t.pts / t.n, margin:t.margin / t.n, list:t.games }));
    const totalRefs = rows.length;
    if (state.ltu) rows = rows.filter(r => r.ltu);
    if (q) rows = rows.filter(r => r.name.toLowerCase().indexOf(q) >= 0);
    sortRows(rows, state.sort.ref);

    const extra = '<label>Search <input type="search" data-act="search" placeholder="Referee name" value="' + esc(state.search) + '"></label>' +
      '<label class="check"><input type="checkbox" data-act="ltu"' + (state.ltu ? ' checked' : '') + '> Lithuanian referees only</label>';
    let h = toolbar(extra) + liveNote(data);
    if (!games.length) return h + '<div class="tcard"><div class="empty">No games available for this selection yet.</div></div>';

    const avgGames = games.length ? (games.length * 3) / (totalRefs || 1) : 0;
    const busiest = Object.values(by).reduce((m, t) => !m || t.n > m.n ? t : m, null);
    h += '<div class="kpis">' +
      '<div class="kpi"><div class="kpi-label">Games</div><div class="kpi-value">' + fmt(games.length) + '</div><div class="kpi-sub">' + seasonLabel(data.season) + '</div></div>' +
      '<div class="kpi"><div class="kpi-label">Referees used</div><div class="kpi-value">' + totalRefs + '</div><div class="kpi-sub">avg ' + fmt1(avgGames) + ' games each</div></div>' +
      '<div class="kpi"><div class="kpi-label">Busiest referee</div><div class="kpi-value">' + busiest.n + '</div><div class="kpi-sub">' + esc(refName(busiest.raw)) + '</div></div>' +
      '<div class="kpi"><div class="kpi-label">Home win rate</div><div class="kpi-value">' + fmt1(100 * games.filter(r => r[C.hs] > r[C.as]).length / games.length) + '%</div><div class="kpi-sub">all games in selection</div></div></div>';

    let body = '';
    rows.forEach((r, i) => {
      const open = state.openRef === r.raw;
      body += '<tr class="ref-row' + (open ? ' open' : '') + '" data-ref="' + esc(r.raw) + '"><td class="rank">' + (i + 1) + '</td><td class="name">' + (open ? '▾ ' : '▸ ') + esc(r.name) +
        (r.ltu ? '<span class="ltu-tag">LTU</span>' : '') + '</td><td class="num">' + r.games + '</td><td class="num">' + fmt1(r.homePct) + '%</td><td class="num">' + fmt1(r.pts) + '</td><td class="num">' + fmt1(r.margin) + '</td></tr>';
      if (open) {
        const list = r.list.slice().sort((a, b) => b[C.date].localeCompare(a[C.date]) || b[C.code] - a[C.code]).map(g => {
          const mates = C.refs.map(k => g[k]).filter(x => x && x !== r.raw).map(refName).join(', ');
          return '<div class="ref-game"><span>' + esc(fmtDate(g[C.date])) + '</span><b>' + teamName(data, g[C.home]) + ' ' + g[C.hs] + '–' + g[C.as] + ' ' + teamName(data, g[C.away]) + '</b><span>with ' + esc(mates) + '</span></div>';
        }).join('');
        body += '<tr class="ref-detail"><td colspan="6">' + list + '</td></tr>';
      }
    });
    h += '<div class="section-label">Referee assignments</div><div class="tcard"><table><thead><tr><th></th>' +
      th('ref', 'name', 'Referee') + th('ref', 'games', 'Games', 1) + th('ref', 'homePct', 'Home win %', 1) + th('ref', 'pts', 'Avg total pts', 1) + th('ref', 'margin', 'Avg margin', 1) +
      '</tr></thead><tbody>' + (body || '<tr><td colspan="6" class="empty">No referees match.</td></tr>') + '</tbody></table></div>' +
      '<div class="foot-note">Each game has three referees; every one of them is credited with the game. Home win %, average total points and average margin describe the games a referee worked, not the referee’s own decisions. Click a row to see the games. “Lithuanian” uses the name keywords from the original script (' + LTU_KEYS.join(', ') + ').</div>';
    return h;
  }

  /* ── ROUTING / RENDERING ── */
  const views = { attendance:document.getElementById('view-attendance'), referees:document.getElementById('view-referees') };
  const renderers = { attendance:renderAttendance, referees:renderReferees };

  async function render(force) {
    const tab = state.tab, view = views[tab];
    if (!view) return;
    const focused = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-act') === 'search';
    if (!cache[state.season] || force) view.innerHTML = toolbar() + '<div class="loader"><div class="spinner"></div> Loading ' + seasonLabel(state.season) + ' data…</div>';
    let data;
    try { data = await loadSeason(state.season, force); }
    catch (e) { view.innerHTML = toolbar() + '<div class="error-box"><strong>Could not load ' + seasonLabel(state.season) + ' data.</strong><br>' + esc(e.message) + '</div>'; return; }
    if (state.tab !== tab) return;                                  // user switched tabs while loading
    view.innerHTML = renderers[tab](data);
    const stampEl = view.querySelector('.toolbar');
    if (stampEl && stamp(data)) stampEl.insertAdjacentHTML('beforeend', '<span class="spacer"></span>' + stamp(data));
    if (focused) { const el = view.querySelector('[data-act=search]'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }

  function showTab(tab, push) {
    if (tab !== 'standings' && !views[tab]) tab = 'standings';
    state.tab = tab;
    document.getElementById('main').hidden = tab !== 'standings';
    for (const k in views) views[k].hidden = k !== tab;
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
    if (push && location.hash.slice(1) !== tab) history.replaceState(null, '', tab === 'standings' ? location.pathname + location.search : '#' + tab);
    if (tab !== 'standings') render(false);
  }

  document.querySelector('.tab-nav').addEventListener('click', e => { const b = e.target.closest('.tab-btn'); if (b) showTab(b.dataset.tab, true); });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'standings', false));

  for (const k in views) {
    views[k].addEventListener('change', e => {
      const act = e.target.getAttribute('data-act');
      if (act === 'season') { state.season = e.target.value; state.openRef = null; }
      else if (act === 'phase') { state.phase = e.target.value; state.openRef = null; }
      else if (act === 'ltu') state.ltu = e.target.checked;
      else return;
      render(false);
    });
    views[k].addEventListener('input', e => { if (e.target.getAttribute('data-act') === 'search') { state.search = e.target.value; render(false); } });
    views[k].addEventListener('click', e => {
      const t = e.target.closest('[data-sort]');
      if (t) {
        const p = t.getAttribute('data-sort').split(':'), s = state.sort[p[0]];
        if (s.k === p[1]) s.d = -s.d; else { s.k = p[1]; s.d = p[1] === 'name' ? 1 : -1; }
        render(false); return;
      }
      const r = e.target.closest('.ref-row');
      if (r) { const id = r.getAttribute('data-ref'); state.openRef = state.openRef === id ? null : id; render(false); }
    });
  }

  // Header "Refresh" button: re-run the standings and re-check the live season for new games.
  window.refreshAll = function () {
    delete cache[CURRENT];
    if (typeof init === 'function') init();
    if (state.tab !== 'standings') render(false);
  };

  showTab(location.hash.slice(1) || 'standings', false);
})();
