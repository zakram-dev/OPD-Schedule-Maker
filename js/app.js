/* OPD Schedule Maker – user interface */
(function () {
  'use strict';
  const { Sched, Parser, Store, OCR, Time: T } = window.WS;
  const ROLES = Sched.ROLES;

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = () => 'p' + Math.random().toString(36).slice(2, 10);
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${T.pad(d.getMonth() + 1)}-${T.pad(d.getDate())}`;
  };
  const niceDate = (iso, opts) =>
    new Date(iso + 'T12:00:00').toLocaleDateString(undefined, opts || { weekday: 'long', month: 'long', day: 'numeric' });

  let db = Store.load();
  let settings = Sched.mergeSettings(db.settings);
  const state = {
    date: todayISO(),
    step: null,
    files: [], // {file, url}
    reading: false,
    progress: null,
    notice: null, // {kind, html}
    lastOcr: null,
  };

  const app = $('#app');

  function day(create) {
    if (!db.days[state.date] && create) db.days[state.date] = { date: state.date, employees: [], rows: null, seed: 1 };
    return db.days[state.date] || { date: state.date, employees: [], rows: null, seed: 1 };
  }
  function persist() {
    db.settings = settings;
    if (!Store.save(db)) toast('Could not save in this browser (storage full or blocked).');
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }
  function defaultStep() {
    const d = db.days[state.date];
    if (d && d.rows && d.rows.length) return 'schedule';
    if (d && d.employees && d.employees.length) return 'review';
    return 'import';
  }
  function setStep(step) {
    state.step = step;
    render();
    window.scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------------ people
  function addPeople(list, source, extraHtml) {
    const d = day(true);
    const seen = new Set(d.employees.map((e) => Sched.nameKey(e.name) + '|' + e.start + '|' + e.end));
    let added = 0;
    for (const p of list) {
      const key = Sched.nameKey(p.name) + '|' + p.start + '|' + p.end;
      if (p.name && seen.has(key)) continue;
      seen.add(key);
      const known = db.roster[Sched.nameKey(p.name)];
      d.employees.push({ id: uid(), name: p.name || '', start: p.start, end: p.end, isTL: !!(p.isTL || (known && known.isTL)) });
      added++;
    }
    persist();
    const blanks = list.filter((p) => !p.name).length;
    const backwards = list.filter((p) => p.end <= p.start).length;
    state.notice = {
      kind: added ? 'ok' : 'warn',
      html:
        (added
          ? `Added <b>${added}</b> ${added === 1 ? 'person' : 'people'} from ${esc(source)}. `
          : `Everyone in ${esc(source)} is already on the list, so nobody new was added. `) +
        (added && source.includes('photo') ? 'Photo reading isn’t perfect, so check names and times below. ' : '') +
        (blanks ? `<b>${blanks}</b> name(s) couldn’t be read; they’re highlighted in red. ` : '') +
        (backwards ? `<b>${backwards}</b> shift(s) end before they start; fix the times in red. ` : '') +
        (extraHtml || ''),
    };
    setStep('review');
  }

  function validEmployee(e) {
    return e.name && e.name.trim() && e.start != null && e.end != null && e.end > e.start;
  }

  function historyFor(date) {
    const h = {};
    for (const [k, v] of Object.entries(db.days)) if (k !== date && v && v.rows && v.rows.length) h[k] = { rows: v.rows };
    return h;
  }

  function makeSchedule(keepEdits) {
    const d = day(true);
    const prev = new Map((d.rows || []).map((r) => [r.id, r]));
    const input = d.employees.filter(validEmployee).map((e) => {
      const p = keepEdits ? prev.get(e.id) : null;
      if (p && p.start === e.start && p.end === e.end)
        return Object.assign({}, e, {
          role: p.role,
          lockRole: p.lockRole,
          lunch: p.lunch,
          lunchLen: p.lunchLen,
          lockLunch: p.lockLunch,
          coverBy: p.coverBy,
          coverLock: p.coverLock,
        });
      return Object.assign({}, e);
    });
    d.rows = Sched.generate(input, settings, { seed: d.seed || 1, date: state.date, history: historyFor(state.date) });
    d.savedAt = Date.now();
    persist();
  }

  // ------------------------------------------------------------------ render
  function render() {
    if (!state.step) state.step = defaultStep();
    const d = db.days[state.date];
    const hasRows = !!(d && d.rows && d.rows.length);
    document.querySelectorAll('#steps button').forEach((b) => {
      b.classList.toggle('active', b.dataset.step === state.step);
      b.disabled = b.dataset.step === 'schedule' && !hasRows;
    });
    $('#date').value = state.date;
    if (state.step === 'schedule' && !hasRows) state.step = 'review';
    app.innerHTML = state.step === 'import' ? viewImport() : state.step === 'review' ? viewReview() : viewSchedule();
  }

  function noticeHTML() {
    if (!state.notice) return '';
    const n = state.notice;
    state.notice = null;
    return `<div class="alerts ${n.kind === 'ok' ? 'ok' : 'warn'}" style="font-weight:500">${n.html}</div>`;
  }

  // ---- step 1: import
  function viewImport() {
    const d = db.days[state.date];
    const have = (d && d.employees && d.employees.length) || 0;
    const n = state.files.length;
    const prog = state.progress;
    const lastSaved = Object.keys(db.days)
      .filter((k) => k !== state.date && db.days[k].employees && db.days[k].employees.length)
      .sort()
      .pop();
    return `
      ${noticeHTML()}
      <div class="card">
        <h2>Add the schedule for ${esc(niceDate(state.date))}</h2>
        <p class="sub">Upload screenshots or a PDF of the day’s schedule showing names and shift times, or an Excel / CSV file. You can add several at once, or paste a screenshot with Ctrl/⌘+V.</p>
        <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose screenshots, a PDF or a spreadsheet">
          <strong>Drop screenshots, a PDF or an Excel file here, or click to choose</strong>
          <span class="muted small">JPG, PNG, PDF, XLSX or CSV · reading happens on this device, free</span>
        </div>
        <input type="file" id="fileIn" accept="image/*,.pdf,application/pdf,.xlsx,.xls,.csv,.ods" multiple hidden />
        ${
          n
            ? `<div class="thumbs">${state.files
                .map(
                  (f, i) =>
                    `<div class="thumb">${
                      f.pdf ? `<div class="pdf-tile"><b>PDF</b><span>${esc(f.file.name)}</span></div>` : `<img src="${f.url}" alt="screenshot ${i + 1}" />`
                    }${state.reading ? '' : `<button type="button" data-act="rm-file" data-i="${i}" aria-label="Remove">✕</button>`}</div>`
                )
                .join('')}</div>`
            : ''
        }
        ${
          state.reading && prog
            ? `<div style="margin-top:14px"><div class="small" id="progLabel">${esc(prog.label)} file ${prog.i + 1} of ${n}…</div>
               <div class="progress"><div id="progBar" style="width:${Math.round(((prog.i + Math.min(1, prog.f || 0)) / n) * 100)}%"></div></div></div>`
            : ''
        }
        <div class="row" style="margin-top:14px">
          <button class="btn primary big" type="button" data-act="read" ${!n || state.reading ? 'disabled' : ''}>
            ${state.reading ? 'Reading…' : n ? `Read ${n} file${n > 1 ? 's' : ''}` : 'Read files'}
          </button>
          ${have ? `<span class="muted small">This day already has ${have} people; new ones get added to the list.</span>` : ''}
        </div>
      </div>
      <div class="grid2">
        <div class="card">
          <h2>Or paste / type the list</h2>
          <p class="sub">One person per line, like <code>Alice T 5:00 AM - 2:00 PM</code>. Add <code>TL</code> for team leads.</p>
          <textarea id="pasteText" placeholder="Alice T 5:00 AM - 2:00 PM&#10;Bob J 5:30 AM - 10:30 AM&#10;Caleb S 6:00 AM - 3:00 PM TL&#10;Dana K 1:00 PM - 10:00 PM"></textarea>
          <div class="row" style="margin-top:10px"><button class="btn" type="button" data-act="paste">Add these people</button></div>
        </div>
        <div class="card">
          <h2>Other ways to start</h2>
          <p class="sub">Handy when you’re testing, or when the schedule barely changed.</p>
          <div style="display:grid;gap:8px">
            <button class="btn" type="button" data-act="copy-prev" ${lastSaved ? '' : 'disabled'}>
              Copy people from ${lastSaved ? esc(niceDate(lastSaved, { weekday: 'short', month: 'short', day: 'numeric' })) : 'a saved day'}
            </button>
            <button class="btn" type="button" data-act="manual">Type people in by hand</button>
          </div>
        </div>
      </div>`;
  }

  // ---- step 2: review
  function viewReview() {
    const d = day(true);
    const emps = d.employees;
    const bad = emps.filter((e) => !validEmployee(e)).length;
    const leads = emps.filter((e) => e.isTL).length;
    const ocr = state.lastOcr;
    const seenNames = new Map();
    for (const e of emps) if (e.name) seenNames.set(Sched.nameKey(e.name), (seenNames.get(Sched.nameKey(e.name)) || 0) + 1);
    const dupes = new Set([...seenNames].filter(([, n]) => n > 1).map(([k]) => k));
    return `
      ${noticeHTML()}
      <div class="card">
        <div class="row" style="margin-bottom:6px">
          <h2 style="margin:0">Check the people working ${esc(niceDate(state.date, { weekday: 'long', month: 'short', day: 'numeric' }))}</h2>
          <span class="spacer"></span>
          <span class="chip"><span class="n">${emps.length}</span> people</span>
          <span class="chip r-TL"><span class="dot"></span><span class="n">${leads}</span> team leads</span>
        </div>
        <p class="sub">Fix any wrong names or times, and tick <b>Team lead</b> for leads. They won’t get a job or a lunch. Team leads are remembered for next time.</p>
        <div class="table-wrap review">
          <table>
            <thead><tr><th style="width:36px">#</th><th>Name</th><th>Start</th><th>End</th><th>Hours</th><th>Lunch</th><th>Team lead</th><th></th></tr></thead>
            <tbody>
              ${emps
                .map((e, i) => {
                  const okTimes = e.start != null && e.end != null && e.end > e.start;
                  const len = okTimes ? Sched.lunchLength(e.start, e.end, settings) : 0;
                  return `<tr data-id="${e.id}">
                    <td class="muted">${i + 1}</td>
                    <td><input type="text" data-f="name" value="${esc(e.name)}" placeholder="Name" class="${e.name ? '' : 'bad-input'}" />${
                      e.name && dupes.has(Sched.nameKey(e.name)) ? '<div class="small" style="color:var(--warn-ink)">Same name appears more than once</div>' : ''
                    }${okTimes ? '' : '<div class="small" style="color:var(--bad)">End must be after start</div>'}</td>
                    <td><input type="time" step="900" data-f="start" value="${T.toInput(e.start)}" class="${okTimes ? '' : 'bad-input'}" /></td>
                    <td><input type="time" step="900" data-f="end" value="${T.toInput(e.end)}" class="${okTimes ? '' : 'bad-input'}" /></td>
                    <td class="hrs" data-hrs>${okTimes ? T.hours(e.start, e.end) : '–'}</td>
                    <td class="hrs" data-len>${e.isTL ? '–' : len ? len + ' min' : 'none'}</td>
                    <td><input type="checkbox" data-f="isTL" ${e.isTL ? 'checked' : ''} aria-label="Team lead" /></td>
                    <td><button class="icon-btn" type="button" data-act="rm-emp" aria-label="Remove ${esc(e.name)}">✕</button></td>
                  </tr>`;
                })
                .join('')}
              ${emps.length ? '' : '<tr><td colspan="8" class="muted" style="padding:20px;text-align:center">No one yet. Add people below or go back to step 1.</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn" type="button" data-act="add-emp">+ Add person</button>
          <button class="btn" type="button" data-act="sort-emp" ${emps.length > 1 ? '' : 'disabled'}>Sort by start time</button>
          <button class="btn" type="button" data-act="goto-import">+ Add more screenshots</button>
          <button class="btn danger ghost" type="button" data-act="clear-emp" ${emps.length ? '' : 'disabled'}>Remove everyone</button>
          <span class="spacer"></span>
          ${bad ? `<span class="small" style="color:var(--bad)">${bad} row(s) need a name or valid times</span>` : ''}
          <button class="btn primary big" type="button" data-act="make" ${emps.length ? '' : 'disabled'}>
            ${d.rows && d.rows.length ? 'Update jobs & lunches →' : 'Make jobs & lunches →'}
          </button>
        </div>
      </div>
      ${
        ocr
          ? `<details class="card"><summary class="small muted" style="cursor:pointer">What the photo reader saw (for troubleshooting)</summary>
             <textarea readonly style="margin-top:10px;min-height:220px">${esc(ocr.map((r, i) => `--- screenshot ${i + 1} ---\n` + r.lines.join('\n')).join('\n'))}</textarea></details>`
          : ''
      }`;
  }

  // ---- step 3: schedule
  const roleLabel = (r) => (ROLES[r] ? ROLES[r].label : r);
  const roleLong = (r) => (ROLES[r] ? ROLES[r].long : r);
  const enabledSingles = () => settings.singleRoles.filter((x) => x.enabled).map((x) => x.key);

  function lunchSelect(r) {
    if (r.isTL) return '<span class="muted small">—</span>';
    const len = r.lunchLen || settings.lunch.shortLen;
    const rule = new Set(Sched.lunchOptions(r.start, r.end, len, settings));
    let opts = `<option value="">No lunch</option>`;
    for (let t = r.start + 30; t + len <= r.end - 30; t += 30) {
      const ok = rule.has(t);
      opts += `<option value="${t}" ${r.lunch === t ? 'selected' : ''}>${T.range(t, t + len)}${ok ? '' : ' ⚠'}</option>`;
    }
    if (r.lunch != null && (r.lunch < r.start + 30 || r.lunch + len > r.end - 30))
      opts += `<option value="${r.lunch}" selected>${T.range(r.lunch, r.lunch + len)} ⚠</option>`;
    return `<select class="lunch-sel ${r.lunch == null ? 'off' : ''}" data-f="lunch" aria-label="Lunch for ${esc(r.name)}">${opts}</select>`;
  }

  function roleSelect(r) {
    const keys = ['PICK', 'DISP', ...enabledSingles()];
    if (!keys.includes(r.role) && r.role !== 'TL') keys.push(r.role);
    keys.push('TL');
    return `<select class="role-sel r-${r.role}" data-f="role" aria-label="Job for ${esc(r.name)}">${keys
      .map((k) => `<option value="${k}" ${r.role === k ? 'selected' : ''}>${esc(roleLong(k))}</option>`)
      .join('')}</select>`;
  }

  function notesCell(r, rows, byId) {
    const bits = [];
    if (r.isTL) bits.push('<span class="note">Runs the department</span>');
    if (Sched.isSingle(r.role) && r.lunch != null && r.lunchLen) {
      const a = r.lunch;
      const b = r.lunch + r.lunchLen;
      const cands = rows.filter(
        (c) => Sched.isPool(c.role) && c.start <= a && c.end >= b && !(c.lunch != null && c.lunch < b && c.lunch + c.lunchLen > a)
      );
      if (r.coverBy && !cands.some((c) => c.id === r.coverBy) && byId.has(r.coverBy)) cands.unshift(byId.get(r.coverBy));
      bits.push(
        `<span class="note">Lunch cover:</span> <select class="cover-sel" data-f="coverBy" aria-label="Lunch cover for ${esc(r.name)}">
          <option value="">— nobody —</option>
          ${cands.map((c) => `<option value="${c.id}" ${r.coverBy === c.id ? 'selected' : ''}>${esc(c.name)} (${roleLabel(c.role)})</option>`).join('')}
        </select>`
      );
    }
    for (const s of rows) {
      if (s.coverBy === r.id && Sched.isSingle(s.role) && s.lunch != null)
        bits.push(`<span class="note">Covers <b>${roleLabel(s.role)}</b> ${T.range(s.lunch, s.lunch + s.lunchLen)} for ${esc(s.name)}</span>`);
    }
    if (r.lockRole || r.lockLunch || r.coverLock)
      bits.push(`<button class="lock" type="button" data-act="unlock" title="You changed this. Click to let the app choose again.">🔒 edited</button>`);
    return bits.join(' ');
  }

  function timeline(r, rows) {
    const S0 = settings.deptStart;
    const span = settings.deptEnd - settings.deptStart;
    const pct = (m) => (Math.max(0, Math.min(span, m - S0)) / span) * 100;
    let html = `<div class="tl" style="--hourw:${(60 / span) * 100}%"><div class="bar r-${r.role}" style="left:${pct(r.start)}%;width:${
      pct(r.end) - pct(r.start)
    }%"></div>`;
    if (r.lunch != null && r.lunchLen)
      html += `<div class="lunch" style="left:${pct(r.lunch)}%;width:${pct(r.lunch + r.lunchLen) - pct(r.lunch)}%" title="Lunch"></div>`;
    for (const s of rows)
      if (s.coverBy === r.id && Sched.isSingle(s.role) && s.lunch != null)
        html += `<div class="cov r-${s.role}" style="left:${pct(s.lunch)}%;width:${pct(s.lunch + s.lunchLen) - pct(s.lunch)}%" title="Covering ${roleLong(
          s.role
        )}"></div>`;
    return html + '</div>';
  }

  function timelineHead() {
    const S0 = settings.deptStart;
    const span = settings.deptEnd - settings.deptStart;
    let html = '<div class="tl-head">';
    for (let t = Math.ceil(S0 / 120) * 120; t < settings.deptEnd; t += 120) html += `<span style="left:${((t - S0) / span) * 100}%">${T.short(t)}</span>`;
    return html + '</div>';
  }

  // ---- lunch chart (Gantt by section)
  const CHART_SECTIONS = [
    { title: 'Picking', sub: 'Pickers + SM / EXP', roles: ['SM', 'PICK'], cls: 'r-PICK' },
    { title: 'Dispensing', sub: 'Dispensers', roles: ['DISP'], cls: 'r-DISP' },
    { title: 'Backroom', sub: 'BR', roles: ['BR'], cls: 'r-BR' },
    { title: 'Prep', sub: 'PR', roles: ['PREP'], cls: 'r-PREP' },
    { title: 'Team leads', sub: 'No job assigned', roles: ['TL'], cls: 'r-TL' },
  ];
  const hm = (m) => T.short(m).replace(/[ap]$/, ''); // 9, 9:30

  function chartGrid(rows, byId) {
    const S0 = settings.deptStart;
    const E0 = settings.deptEnd;
    const span = E0 - S0;
    const pct = (m) => (Math.max(0, Math.min(span, m - S0)) / span) * 100;
    const box = (a, b) => `left:${pct(a)}%;width:${pct(b) - pct(a)}%`;
    const coversBy = (id) => rows.filter((s) => s.coverBy === id && Sched.isSingle(s.role) && s.lunch != null && s.lunchLen);

    let hours = '';
    for (let t = Math.ceil(S0 / 60) * 60; t <= E0; t += 60) {
      const edge = t === S0 ? 'first' : t === E0 ? 'last' : '';
      hours += `<span class="${edge}" style="left:${pct(t)}%">${T.short(t)}</span>`;
    }
    const head = `<div class="gc-head"><div class="gc-name"><span class="muted small">Name</span></div><div class="gc-track gc-hours">${hours}</div></div>`;

    let now = '';
    if (state.date === todayISO()) {
      const d = new Date();
      const m = d.getHours() * 60 + d.getMinutes();
      if (m >= S0 && m <= E0) now = `<div class="gc-now" style="--p:${pct(m)}" title="Now ${T.fmt(m)}"><span>now</span></div>`;
    }

    let body = '';
    for (const sec of CHART_SECTIONS) {
      const list = rows
        .filter((r) => sec.roles.includes(r.role))
        .sort(
          (a, b) =>
            (a.role === 'SM' ? 0 : 1) - (b.role === 'SM' ? 0 : 1) ||
            (a.lunch != null ? a.lunch : 9999 + a.start) - (b.lunch != null ? b.lunch : 9999 + b.start) ||
            a.start - b.start ||
            a.name.localeCompare(b.name)
        );
      if (!list.length) continue;
      // how many from this section are out at lunch, every half hour
      let lc = '';
      for (let t = S0; t < E0; t += 30) {
        const n = list.filter((r) => r.lunch != null && r.lunchLen && r.lunch < t + 30 && r.lunch + r.lunchLen > t).length;
        if (n) lc += `<span style="${box(t, t + 30)}" title="${n} at lunch ${T.fmt(t)}–${T.fmt(t + 30)}">${n}</span>`;
      }
      const lunches = list.filter((r) => r.lunch != null && r.lunchLen).length;
      body += `<div class="gc-sec ${sec.cls}">
        <div class="gc-name"><b>${sec.title}</b><span>${list.length} ${list.length === 1 ? 'person' : 'people'}${sec.roles[0] === 'TL' ? '' : ` · ${lunches} lunches`}</span></div>
        <div class="gc-track gc-lc" aria-label="People at lunch">${lc}</div>
      </div>`;
      for (const r of list) {
        const cover = r.coverBy && byId.has(r.coverBy) ? byId.get(r.coverBy) : null;
        const hasLunch = r.lunch != null && r.lunchLen;
        const sub =
          Sched.isSingle(r.role) && hasLunch && r.role !== 'SM'
            ? `<span class="gc-meta">cover: ${cover ? esc(cover.name.split(' ')[0]) : '<b class="bad">none</b>'}</span>`
            : '';
        body += `<div class="gc-row" data-act="focus" data-id="${r.id}" title="Click to edit ${esc(r.name)}">
          <div class="gc-name"><span class="gc-nm">${esc(r.name)}</span>
            <span class="gc-meta">${r.role === 'SM' ? '<i class="tag r-SM">SM/EXP</i> ' : ''}${T.short(r.start)}–${T.short(r.end)}${sub ? ' · ' : ''}${sub}</span></div>
          <div class="gc-track">
            <div class="gc-shift r-${r.role}" style="${box(r.start, r.end)}" title="${esc(r.name)} · ${esc(roleLong(r.role))} · ${T.fmt(r.start)}–${T.fmt(r.end)}"></div>
            ${
              hasLunch
                ? `<div class="gc-lunch" style="${box(r.lunch, r.lunch + r.lunchLen)}" title="Lunch ${T.fmt(r.lunch)}–${T.fmt(r.lunch + r.lunchLen)}${
                    cover ? ' · covered by ' + esc(cover.name) : ''
                  }"><span>${r.lunchLen < 60 ? '½' : r.lunch % 60 ? hm(r.lunch) : `${hm(r.lunch)}–${hm(r.lunch + r.lunchLen)}`}</span></div>`
                : ''
            }
            ${coversBy(r.id)
              .map(
                (s) =>
                  `<div class="gc-cover r-${s.role}" style="${box(s.lunch, s.lunch + s.lunchLen)}" title="Covers ${esc(roleLong(s.role))} for ${esc(s.name)}"><span>${roleLabel(
                    s.role
                  )}</span></div>`
              )
              .join('')}
          </div>
        </div>`;
      }
    }
    return `<div class="gc" style="--hourw:${(60 / span) * 100}%">${head}${body}${head.replace('gc-head', 'gc-head gc-foot')}${now}</div>`;
  }

  function chartLegend() {
    return `<div class="legend gc-legend">
      ${['PICK', 'SM', 'DISP', 'BR', 'PREP', 'TL']
        .filter((k) => k === 'PICK' || k === 'DISP' || k === 'TL' || enabledSingles().includes(k))
        .map((k) => `<span><i class="sw r-${k}" style="background:var(--c)"></i>${esc(roleLong(k))}</span>`)
        .join('')}
      <span><i class="sw" style="background:var(--lunchc);border:1px solid var(--lunch-ink)"></i>Lunch</span>
      <span><i class="sw" style="background:#fff;border:2px dashed var(--ink)"></i>Covering a lunch</span>
      <span><i class="sw" style="background:var(--lunchc)"></i><b>2</b> = people from that team at lunch</span>
    </div>`;
  }

  function viewChart(rows, byId) {
    const withLunch = rows.filter((r) => r.lunch != null && r.lunchLen && !r.isTL);
    const starts = [...new Set(withLunch.map((r) => r.lunch))].sort((a, b) => a - b);
    const order = { SM: 0, PICK: 1, DISP: 2, BR: 3, PREP: 4 };
    return `
      <div class="card">
        <div class="row" style="margin-bottom:4px">
          <h2 style="margin:0">Lunch chart</h2>
          <span class="spacer"></span>
          <button class="btn small" type="button" data-act="print-chart">🖨 Print chart</button>
        </div>
        <p class="sub">Each bar is a shift, the yellow block is lunch. Click anyone to change their job or lunch.</p>
        ${chartLegend()}
        <div class="gc-wrap">${chartGrid(rows, byId)}</div>
      </div>
      <div class="card">
        <h2>Lunch order</h2>
        <p class="sub">Who goes to lunch when. Colors show their job.</p>
        <div class="lo-list">
          ${
            starts.length
              ? starts
                  .map((t) => {
                    const ppl = withLunch.filter((r) => r.lunch === t).sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
                    return `<div class="lo-row"><div class="lo-time">${T.fmt(t)}</div><div class="lo-names">${ppl
                      .map(
                        (r) =>
                          `<span class="chip r-${r.role}" title="${esc(roleLong(r.role))}"><span class="dot"></span>${esc(r.name)} <small>${
                            r.lunchLen >= 60 ? r.lunchLen / 60 + 'h' : r.lunchLen + 'm'
                          }</small></span>`
                      )
                      .join('')}</div></div>`;
                  })
                  .join('')
              : '<p class="muted">No lunches today.</p>'
          }
        </div>
      </div>`;
  }

  function viewTabs() {
    const tabs = [
      ['chart', '📊 Lunch chart'],
      ['table', '✏️ Edit jobs & lunches'],
      ['floor', '👥 Who’s on the floor'],
    ];
    return `<div class="tabs" role="tablist">${tabs
      .map(
        ([v, l]) =>
          `<button type="button" role="tab" aria-selected="${state.view === v}" class="${state.view === v ? 'active' : ''}" data-act="view" data-v="${v}">${l}</button>`
      )
      .join('')}</div>`;
  }

  function viewSchedule() {
    if (!state.view) state.view = 'chart';
    const d = day(true);
    const rows = d.rows || [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const a = Sched.analyze(rows, settings);
    const order = ['PICK', 'DISP', ...enabledSingles(), 'TL'];
    const lunches = rows.filter((r) => r.lunch != null && r.lunchLen && !r.isTL).length;
    const edited = rows.some((r) => r.lockRole || r.lockLunch || r.coverLock);
    const fmtW = (w) => esc(w.text) + (w.from != null ? ` <b>${T.short(w.from)}–${T.short(w.to)}</b>` : '');

    const covRow = (label, cls, get, lowFn) =>
      `<tr><td>${label}</td>${a.slots
        .map((s) => {
          const v = get(s);
          const low = lowFn && lowFn(s, v);
          return `<td class="${low ? 'lo' : ''} ${cls || ''}">${v}</td>`;
        })
        .join('')}</tr>`;
    const inDisp = (t) => t >= settings.dispFrom && t < settings.dispTo;

    return `
      ${noticeHTML()}
      <div class="card">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">${esc(niceDate(state.date))}</h2>
          <span class="muted small">${edited ? 'Your edits are kept (🔒) when you redo.' : 'Change any job or lunch below; covers and warnings update right away.'}</span>
        </div>
        <div class="toolbar">
          <button class="btn primary" type="button" data-act="redo" title="Re-plan everything you haven't changed by hand">↻ Redo schedule</button>
          <button class="btn" type="button" data-act="mix" title="Try a different mix of people and jobs">🔀 Try another mix</button>
          ${edited ? '<button class="btn" type="button" data-act="unlock-all">Undo my edits</button>' : ''}
          <span class="spacer"></span>
          <button class="btn" type="button" data-act="goto-review">Edit people</button>
          <button class="btn" type="button" data-act="print">🖨 Print</button>
          <button class="btn" type="button" data-act="csv">Download CSV</button>
        </div>
        <div class="chips">
          ${order
            .filter((k) => a.counts[k])
            .map((k) => `<span class="chip r-${k}"><span class="dot"></span>${esc(roleLong(k))}<span class="n">${a.counts[k]}</span></span>`)
            .join('')}
          <span class="chip">Lunches <span class="n">${lunches}</span></span>
        </div>
        ${
          a.warnings.length
            ? `<div class="alerts warn"><b>${a.warnings.length} thing${a.warnings.length > 1 ? 's' : ''} to check</b><ul>${a.warnings
                .map((w) => `<li>${fmtW(w)}</li>`)
                .join('')}</ul></div>`
            : '<div class="alerts ok">✓ Every job is covered, lunches follow the rules, and every one-person job has a lunch cover.</div>'
        }
        ${viewTabs()}
      </div>
      ${state.view === 'chart' ? viewChart(rows, byId) : ''}
      <div class="card" ${state.view === 'table' ? '' : 'hidden'}>
        <div class="table-wrap">
          <table class="sched">
            <thead><tr><th>Name</th><th>Shift</th><th>Hrs</th><th>Job</th><th>Lunch</th><th class="tl-headcell tl-cell">${timelineHead()}</th><th>Notes</th></tr></thead>
            <tbody>
              ${rows
                .map(
                  (r) => `<tr data-id="${r.id}" class="${r.isTL ? 'tl' : ''}">
                    <td class="name">${esc(r.name)}</td>
                    <td class="shift">${T.short(r.start)}–${T.short(r.end)}</td>
                    <td class="shift muted">${T.hours(r.start, r.end)}</td>
                    <td>${roleSelect(r)}</td>
                    <td>${lunchSelect(r)}</td>
                    <td class="tl-cell">${timeline(r, rows)}</td>
                    <td>${notesCell(r, rows, byId)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="legend">
          ${['PICK', 'DISP', ...enabledSingles()].map((k) => `<span><i class="sw r-${k}" style="background:var(--c)"></i>${esc(roleLong(k))}</span>`).join('')}
          <span><i class="sw" style="background:repeating-linear-gradient(45deg,#fff,#fff 3px,var(--lunch) 3px,var(--lunch) 5px);border:1px solid var(--lunch)"></i>Lunch</span>
          <span><i class="sw" style="border:2px solid var(--ink)"></i>Covering a lunch</span>
          <span>⚠ = lunch time outside the rules</span>
        </div>
      </div>

      <div class="card" ${state.view === 'floor' ? '' : 'hidden'}>
        <h2>Who’s on the floor</h2>
        <p class="sub">Every half hour: people actually working each job (not at lunch). Red means short.</p>
        <div class="table-wrap">
          <table class="coverage">
            <thead><tr><th>Time</th>${a.slots.map((s) => `<th>${T.short(s.t)}</th>`).join('')}</tr></thead>
            <tbody>
              ${covRow('Pickers', '', (s) => s.PICK, (s, v) => s.staff > 0 && v < settings.minPick)}
              ${covRow('Dispensers', '', (s) => s.DISP, (s, v) => s.staff > 0 && inDisp(s.t) && v < settings.minDisp)}
              ${enabledSingles()
                .map((k) =>
                  covRow(
                    esc(roleLong(k)),
                    '',
                    (s) => (s.need[k] ? (s.single[k] >= s.need[k] ? '✓' : '✗') : '·'),
                    (s) => s.need[k] && s.single[k] < s.need[k]
                  )
                )
                .join('')}
              ${covRow('At lunch', 'muted', (s) => s.lunch || '·')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------ print / csv
  function rowNotes(r, rows, byId) {
    const n = [];
    if (Sched.isSingle(r.role) && r.lunch != null && r.coverBy && byId.has(r.coverBy)) n.push('Cover: ' + byId.get(r.coverBy).name);
    for (const s of rows)
      if (s.coverBy === r.id && Sched.isSingle(s.role) && s.lunch != null) n.push(`${roleLabel(s.role)} ${T.range(s.lunch, s.lunch + s.lunchLen)}`);
    return n.join('; ');
  }
  function printSchedule() {
    const rows = day().rows || [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    $('#printArea').innerHTML = `
      <div class="print-title">${esc(niceDate(state.date))}</div>
      <table class="print-table">
        <thead><tr><th>Name</th><th>Start</th><th>End</th><th>Hours</th><th>Lunch</th><th>Assignment</th><th>Cover</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr class="${r.role === 'DISP' ? 'shade' : ''}"><td>${esc(r.name)}</td><td class="num">${T.fmt(r.start)}</td><td class="num">${T.fmt(
              r.end
            )}</td><td class="num">${T.hours(r.start, r.end)}</td><td>${r.lunch != null && r.lunchLen ? T.range(r.lunch, r.lunch + r.lunchLen) : ''}</td><td>${esc(
              roleLabel(r.role)
            )}</td><td>${esc(rowNotes(r, rows, byId))}</td></tr>`
          )
          .join('')}</tbody>
      </table>`;
    window.print();
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }
  function exportCSV() {
    const rows = day().rows || [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [['Name', 'Start', 'End', 'Hours', 'Lunch', 'Assignment', 'Cover'].join(',')];
    for (const r of rows)
      lines.push(
        [
          r.name,
          T.fmt(r.start),
          T.fmt(r.end),
          T.hours(r.start, r.end),
          r.lunch != null && r.lunchLen ? T.range(r.lunch, r.lunch + r.lunchLen) : '',
          roleLabel(r.role),
          rowNotes(r, rows, byId),
        ]
          .map(q)
          .join(',')
      );
    download(`opd-schedule-${state.date}.csv`, lines.join('\n'), 'text/csv');
  }

  // ------------------------------------------------------------------ photo reading
  const isPdf = (f) => window.WS.Pdf.isPdf(f);
  const isImage = (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(f.name || '');
  async function addFiles(fileList) {
    const all = [...(fileList || [])].filter(Boolean);
    const isText = (f) => /\.txt$/i.test(f.name || '') || f.type === 'text/plain';
    const texts = all.filter((f) => isText(f) && !window.WS.Sheet.isSheet(f));
    const sheets = all.filter((f) => window.WS.Sheet.isSheet(f));
    const queued = all.filter((f) => !window.WS.Sheet.isSheet(f) && !isText(f) && (isPdf(f) || isImage(f)));
    const skipped = all.length - sheets.length - queued.length - texts.length;
    if (!sheets.length && !queued.length && !texts.length) return toast('Use screenshots (JPG / PNG), a PDF, an Excel / CSV file, or a text file.');
    if (skipped) toast(`Skipped ${skipped} file${skipped > 1 ? 's' : ''} that aren’t pictures, PDFs, spreadsheets or text.`);
    if (texts.length) {
      const found = [];
      for (const f of texts) found.push(...Parser.parseText(await f.text()));
      if (found.length) return addPeople(found, `${texts.length} text file${texts.length > 1 ? 's' : ''}`);
      state.notice = { kind: 'warn', html: 'Couldn’t find names with start and end times in that text file.' };
      if (!sheets.length && !queued.length) return render();
    }
    for (const f of queued) {
      if (state.files.some((x) => x.file.name === f.name && x.file.size === f.size && x.file.lastModified === f.lastModified)) continue;
      state.files.push({ file: f, pdf: isPdf(f), url: isPdf(f) ? null : URL.createObjectURL(f) });
    }
    if (!sheets.length) return render();
    try {
      const found = [];
      for (const f of sheets) found.push(...Parser.parseLines(await window.WS.Sheet.readFile(f)));
      if (!found.length) {
        state.notice = { kind: 'warn', html: 'Couldn’t find names with start and end times in that spreadsheet.' };
        return render();
      }
      addPeople(found, `${sheets.length} spreadsheet${sheets.length > 1 ? 's' : ''}`);
    } catch (e) {
      console.error(e);
      state.notice = { kind: 'warn', html: 'Could not read the spreadsheet: ' + esc(e.message || e) };
      render();
    }
  }
  async function readPhotos() {
    if (!state.files.length || state.reading) return;
    state.reading = true;
    state.progress = { i: 0, f: 0, label: 'Starting' };
    render();
    const files = state.files.slice();
    const n = files.length;
    const res = [];
    const failed = [];
    for (let i = 0; i < n; i++) {
      const f = files[i];
      const progress = (frac, label) => {
        state.progress = { i, f: frac, label };
        const bar = $('#progBar');
        const lab = $('#progLabel');
        if (bar) bar.style.width = Math.round(((i + Math.min(1, frac || 0)) / n) * 100) + '%';
        if (lab) lab.textContent = `${label} file ${i + 1} of ${n}…`;
      };
      try {
        const lines = f.pdf ? await window.WS.Pdf.readFile(f.file, progress) : await OCR.readImage(f.file, progress);
        res.push({ name: f.file.name, lines });
      } catch (e) {
        console.error(e);
        failed.push({ f, msg: e && e.message ? e.message : String(e) });
      }
    }
    state.reading = false;
    state.lastOcr = res.length ? res : null;
    const found = [];
    res.forEach((r) => found.push(...Parser.parseLines(r.lines)));
    // keep only the files that failed in the list so they can be removed or retried
    state.files.filter((x) => !failed.some((y) => y.f === x)).forEach((x) => x.url && URL.revokeObjectURL(x.url));
    state.files = failed.map((y) => y.f);
    const failHTML = failed.length ? `<ul>${failed.map((y) => `<li>${esc(y.msg)}</li>`).join('')}</ul>` : '';
    if (!found.length) {
      state.notice = {
        kind: 'warn',
        html:
          (res.length ? 'Couldn’t find any names with shift times in those files. Try a clearer or closer screenshot, or paste the list as text.' : 'Nothing could be read.') +
          failHTML,
      };
      render();
      return;
    }
    addPeople(
      found,
      `${res.length} file${res.length > 1 ? 's' : ''} (photo reading)`,
      failed.length ? `<div style="margin-top:6px;color:var(--warn-ink)">${failed.length} file(s) couldn’t be read:${failHTML}</div>` : ''
    );
  }

  // ------------------------------------------------------------------ events: main
  app.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) {
      if (ev.target.closest('#drop')) $('#fileIn').click();
      return;
    }
    const act = btn.dataset.act;
    const tr = btn.closest('tr[data-id]');
    const d = day(true);
    switch (act) {
      case 'read':
        readPhotos();
        break;
      case 'rm-file': {
        const [f] = state.files.splice(+btn.dataset.i, 1);
        if (f) URL.revokeObjectURL(f.url);
        render();
        break;
      }
      case 'paste': {
        const txt = $('#pasteText').value;
        const found = Parser.parseText(txt);
        if (!found.length) return toast('No shift times found. Try “Name 5:00 AM - 2:00 PM”.');
        addPeople(found, 'the pasted list');
        break;
      }
      case 'copy-prev': {
        const last = Object.keys(db.days)
          .filter((k) => k !== state.date && db.days[k].employees && db.days[k].employees.length)
          .sort()
          .pop();
        if (last) addPeople(db.days[last].employees.map((e) => ({ name: e.name, start: e.start, end: e.end, isTL: e.isTL })), niceDate(last));
        break;
      }
      case 'manual':
        d.employees.push({ id: uid(), name: '', start: 300, end: 840, isTL: false });
        persist();
        setStep('review');
        break;
      case 'goto-import':
        setStep('import');
        break;
      case 'goto-review':
        setStep('review');
        break;
      case 'add-emp': {
        const last = d.employees[d.employees.length - 1];
        d.employees.push({ id: uid(), name: '', start: last ? last.start : 300, end: last ? last.end : 840, isTL: false });
        persist();
        render();
        const inputs = app.querySelectorAll('input[data-f="name"]');
        inputs[inputs.length - 1]?.focus();
        break;
      }
      case 'rm-emp':
        d.employees = d.employees.filter((e) => e.id !== tr.dataset.id);
        persist();
        render();
        break;
      case 'sort-emp':
        d.employees.sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999) || (a.end ?? 0) - (b.end ?? 0) || a.name.localeCompare(b.name));
        persist();
        render();
        break;
      case 'clear-emp':
        if (!confirm('Remove everyone from this day? The jobs & lunches for this day are removed too.')) return;
        d.employees = [];
        d.rows = null;
        persist();
        render();
        break;
      case 'make': {
        const bad = d.employees.filter((e) => !validEmployee(e));
        if (bad.length && !confirm(`${bad.length} row(s) have no name or bad times and will be skipped. Continue?`)) return;
        makeSchedule(true);
        setStep('schedule');
        break;
      }
      case 'redo':
        makeSchedule(true);
        render();
        toast('Schedule re-planned. Your edits were kept.');
        break;
      case 'mix':
        d.seed = (d.seed || 1) + 1;
        makeSchedule(true);
        render();
        toast('Here’s another mix.');
        break;
      case 'unlock-all':
        (d.rows || []).forEach((r) => (r.lockRole = r.lockLunch = r.coverLock = false));
        makeSchedule(true);
        render();
        toast('Your edits were undone and the schedule re-planned.');
        break;
      case 'unlock': {
        const r = (d.rows || []).find((x) => x.id === tr.dataset.id);
        if (r) r.lockRole = r.lockLunch = r.coverLock = false;
        persist();
        render();
        toast('Unlocked. Press “Redo schedule” to let the app choose again.');
        break;
      }
      case 'print':
        printSchedule();
        break;
      case 'print-chart': {
        const rows = d.rows || [];
        $('#printArea').innerHTML = `<div class="print-chart"><div class="print-title">Lunch chart · ${esc(niceDate(state.date))}</div>${chartLegend()}${chartGrid(
          rows,
          new Map(rows.map((r) => [r.id, r]))
        )}</div>`;
        window.print();
        break;
      }
      case 'view':
        state.view = btn.dataset.v;
        render();
        break;
      case 'focus': {
        state.view = 'table';
        render();
        const row = app.querySelector(`.sched tr[data-id="${btn.dataset.id}"]`);
        if (row) {
          row.scrollIntoView({ block: 'center', behavior: 'smooth' });
          row.classList.add('flash');
          row.querySelector('select')?.focus({ preventScroll: true });
        }
        break;
      }
      case 'csv':
        exportCSV();
        break;
    }
  });

  app.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'drop' && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      $('#fileIn').click();
    }
  });

  // review table: update the model as you type, without re-rendering (keeps focus)
  app.addEventListener('input', (ev) => {
    const el = ev.target;
    const tr = el.closest('tr[data-id]');
    if (!tr || state.step !== 'review' || !el.dataset.f) return;
    const e = day(true).employees.find((x) => x.id === tr.dataset.id);
    if (!e) return;
    const f = el.dataset.f;
    if (f === 'name') {
      e.name = el.value;
      el.classList.toggle('bad-input', !el.value.trim());
    } else if (f === 'start' || f === 'end') {
      e[f] = T.fromInput(el.value);
    } else if (f === 'isTL') {
      e.isTL = el.checked;
      if (e.name) db.roster[Sched.nameKey(e.name)] = { name: e.name, isTL: e.isTL };
    }
    const ok = e.start != null && e.end != null && e.end > e.start;
    tr.querySelectorAll('input[type="time"]').forEach((i) => i.classList.toggle('bad-input', !ok));
    const len = ok ? Sched.lunchLength(e.start, e.end, settings) : 0;
    tr.querySelector('[data-hrs]').textContent = ok ? T.hours(e.start, e.end) : '–';
    tr.querySelector('[data-len]').textContent = e.isTL ? '–' : len ? len + ' min' : 'none';
    persist();
  });

  // schedule table edits
  app.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.id === 'fileIn') {
      addFiles(el.files);
      el.value = '';
      return;
    }
    if (state.step !== 'schedule' || !el.dataset.f) return;
    const tr = el.closest('tr[data-id]');
    const d = day(true);
    const r = (d.rows || []).find((x) => x.id === tr.dataset.id);
    if (!r) return;
    const emp = d.employees.find((x) => x.id === r.id);
    if (el.dataset.f === 'role') {
      const v = el.value;
      if (v === 'TL') {
        r.role = 'TL';
        r.isTL = true;
        r.lockRole = false;
        r.lunch = null;
        r.lockLunch = false;
      } else {
        r.role = v;
        r.isTL = false;
        r.lockRole = true;
        if (!r.lunchLen) r.lunchLen = Sched.lunchLength(r.start, r.end, settings);
      }
      if (emp) emp.isTL = r.isTL;
      db.roster[Sched.nameKey(r.name)] = { name: r.name, isTL: r.isTL };
    } else if (el.dataset.f === 'lunch') {
      if (el.value === '') r.lunch = null;
      else {
        r.lunch = +el.value;
        if (!r.lunchLen) r.lunchLen = settings.lunch.shortLen;
      }
      r.lockLunch = true;
    } else if (el.dataset.f === 'coverBy') {
      r.coverBy = el.value || null;
      r.coverLock = true;
    }
    Sched.assignCovers(d.rows, settings);
    persist();
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
  });

  // drag & drop + paste
  app.addEventListener('dragover', (ev) => {
    const drop = ev.target.closest('#drop');
    if (!drop) return;
    ev.preventDefault();
    drop.classList.add('over');
  });
  app.addEventListener('dragleave', (ev) => {
    const drop = ev.target.closest('#drop');
    if (drop) drop.classList.remove('over');
  });
  app.addEventListener('drop', (ev) => {
    const drop = ev.target.closest('#drop');
    if (!drop) return;
    ev.preventDefault();
    drop.classList.remove('over');
    addFiles(ev.dataTransfer.files);
  });
  document.addEventListener('paste', (ev) => {
    if (state.step !== 'import' || state.reading) return;
    const files = [...(ev.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (files.length) {
      ev.preventDefault();
      addFiles(files);
      toast(`Pasted ${files.length} screenshot${files.length > 1 ? 's' : ''}.`);
    }
  });

  // ------------------------------------------------------------------ header
  $('#date').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    state.date = ev.target.value;
    state.step = defaultStep();
    state.lastOcr = null;
    render();
  });
  document.querySelectorAll('#steps button').forEach((b) => b.addEventListener('click', () => setStep(b.dataset.step)));

  // ------------------------------------------------------------------ settings dialog
  const setDlg = $('#settingsDlg');
  $('#btnSettings').addEventListener('click', () => openSettings(settings));

  function openSettings(s) {
    const L = s.lunch;
    const num = (name, v, step) => `<input type="number" name="${name}" value="${v}" step="${step || 0.5}" min="0" />`;
    const time = (name, v) => `<input type="time" step="900" name="${name}" value="${T.toInput(v)}" />`;
    setDlg.innerHTML = `
      <header><h3>Settings</h3><button class="icon-btn" type="button" data-dlg="close" aria-label="Close">✕</button></header>
      <form class="body" id="setForm" onsubmit="return false">
        <fieldset><legend>Department hours</legend>
          <div class="form-line"><label>Opens ${time('deptStart', s.deptStart)}</label><label>Closes ${time('deptEnd', s.deptEnd)}</label></div>
        </fieldset>
        <fieldset><legend>Lunch rules</legend>
          <div class="form-line">No lunch for shifts shorter than ${num('noneUnder', L.noneUnder)} hours</div>
          <div class="form-line">${num('shortLen', L.shortLen, 15)}-minute lunch for shifts up to ${num('shortUpTo', L.shortUpTo)} hours</div>
          <div class="form-line">${num('longLen', L.longLen, 15)}-minute lunch for anything longer</div>
          <div class="form-line">Lunch starts at least ${num('earliestAfter', L.earliestAfter / 60)} hours into the shift</div>
          <div class="form-line">…and no later than ${num('latestAfter', L.latestAfter / 60)} hours into the shift</div>
          <div class="form-line">Lunch ends at least ${num('endBuffer', L.endBuffer / 60)} hour(s) before the shift ends</div>
        </fieldset>
        <fieldset><legend>One-person jobs</legend>
          <p class="muted small" style="margin:0 0 6px">These get one person for their whole shift. A picker or dispenser covers their lunch.</p>
          ${s.singleRoles
            .map(
              (r) => `<div class="form-line">
                <label style="min-width:120px"><input type="checkbox" name="sr_${r.key}_on" ${r.enabled ? 'checked' : ''} /> ${esc(roleLong(r.key))}</label>
                from ${time('sr_' + r.key + '_from', r.from)} to ${time('sr_' + r.key + '_to', r.to)}
                · people at once ${num('sr_' + r.key + '_count', r.count, 1)}
              </div>`
            )
            .join('')}
        </fieldset>
        <fieldset><legend>Pickers vs dispensers</legend>
          <p class="muted small" style="margin:0 0 6px">Out of the pickers + dispensers on the clock, how many should be dispensers at each time of day.</p>
          ${[0, 1, 2, 3]
            .map((i) => {
              const t = s.dispTargets[i] || { from: s.deptStart, pct: 0 };
              return `<div class="form-line">From ${time('dt_' + i + '_from', t.from)} → ${num('dt_' + i + '_pct', t.pct, 5)} % dispensers</div>`;
            })
            .join('')}
          <div class="form-line">Always keep at least ${num('minPick', s.minPick, 1)} picker(s) on the floor</div>
          <div class="form-line">Keep at least ${num('minDisp', s.minDisp, 1)} dispenser(s) on the floor from ${time('dispFrom', s.dispFrom)} to ${time('dispTo', s.dispTo)}</div>
        </fieldset>
        <fieldset><legend>Job rotation</legend>
          <div class="form-line">Look back ${num('rotationDays', s.rotationDays, 1)} days and mix up jobs:
            <select name="rotation">${['Off', 'A little', 'Normal', 'A lot']
              .map((l, i) => `<option value="${i}" ${s.rotation === i ? 'selected' : ''}>${l}</option>`)
              .join('')}</select>
          </div>
          <p class="muted small" style="margin:4px 0 0">Uses the days saved in this browser, so people don’t get the same job every day.</p>
        </fieldset>
      </form>
      <footer>
        <button class="btn ghost" type="button" data-dlg="defaults">Reset to defaults</button>
        <span class="spacer"></span>
        <button class="btn" type="button" data-dlg="close">Cancel</button>
        <button class="btn primary" type="button" data-dlg="save">Save</button>
      </footer>`;
    if (!setDlg.open) setDlg.showModal();
  }

  setDlg.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-dlg]');
    if (!b) return;
    if (b.dataset.dlg === 'close') return setDlg.close();
    if (b.dataset.dlg === 'defaults') return openSettings(Sched.defaultSettings());
    if (b.dataset.dlg === 'save') {
      const f = new FormData($('#setForm'));
      // a box left blank (or typed as junk) keeps its current value instead of becoming 0
      const n = (k, prev) => {
        const v = f.get(k);
        return v === null || String(v).trim() === '' || !Number.isFinite(+v) ? prev : +v;
      };
      const tm = (k, prev) => {
        const v = T.fromInput(f.get(k));
        return v == null ? prev : v;
      };
      const s0 = settings;
      const L0 = s0.lunch;
      const next = {
        deptStart: tm('deptStart', s0.deptStart),
        deptEnd: tm('deptEnd', s0.deptEnd),
        lunch: {
          noneUnder: n('noneUnder', L0.noneUnder),
          shortUpTo: n('shortUpTo', L0.shortUpTo),
          shortLen: n('shortLen', L0.shortLen),
          longLen: n('longLen', L0.longLen),
          earliestAfter: n('earliestAfter', L0.earliestAfter / 60) * 60,
          latestAfter: n('latestAfter', L0.latestAfter / 60) * 60,
          endBuffer: n('endBuffer', L0.endBuffer / 60) * 60,
          step: 30,
        },
        singleRoles: s0.singleRoles.map((r) => ({
          key: r.key,
          enabled: f.get(`sr_${r.key}_on`) === 'on',
          from: tm(`sr_${r.key}_from`, r.from),
          to: tm(`sr_${r.key}_to`, r.to),
          count: n(`sr_${r.key}_count`, r.count),
        })),
        dispTargets: [0, 1, 2, 3]
          .map((i) => {
            const prev = s0.dispTargets[i] || {};
            return { from: tm(`dt_${i}_from`, prev.from), pct: n(`dt_${i}_pct`, prev.pct) };
          })
          .filter((x) => x.from != null && x.pct != null),
        minPick: n('minPick', s0.minPick),
        minDisp: n('minDisp', s0.minDisp),
        dispFrom: tm('dispFrom', s0.dispFrom),
        dispTo: tm('dispTo', s0.dispTo),
        rotationDays: n('rotationDays', s0.rotationDays),
        rotation: n('rotation', s0.rotation),
      };
      if (next.deptStart == null || next.deptEnd == null || next.deptEnd <= next.deptStart) return toast('Check the department hours.');
      settings = Sched.mergeSettings(next);
      persist();
      setDlg.close();
      const d = db.days[state.date];
      if (d && d.rows && d.rows.length && confirm('Settings saved. Redo this day’s schedule with the new settings? (Your edits are kept.)'))
        makeSchedule(true);
      render();
      toast('Settings saved.');
    }
  });

  // ------------------------------------------------------------------ saved days dialog
  const histDlg = $('#historyDlg');
  $('#btnHistory').addEventListener('click', openHistory);
  function openHistory() {
    const days = Object.values(db.days)
      .filter((d) => d && d.employees && d.employees.length)
      .sort((a, b) => b.date.localeCompare(a.date));
    histDlg.innerHTML = `
      <header><h3>Saved days</h3><button class="icon-btn" type="button" data-h="close" aria-label="Close">✕</button></header>
      <div class="body">
        <p class="muted small" style="margin-top:0">Everything saves automatically in this browser. Saved schedules are also used to rotate jobs.</p>
        ${
          days.length
            ? days
                .map(
                  (d) => `<div class="hist-item">
                    <span class="when">${esc(niceDate(d.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</span>
                    <span class="muted small">${d.employees.length} people · ${d.rows && d.rows.length ? 'schedule made' : 'not scheduled yet'}</span>
                    <button class="btn small" type="button" data-h="open" data-date="${d.date}">Open</button>
                    <button class="icon-btn" type="button" data-h="del" data-date="${d.date}" aria-label="Delete">✕</button>
                  </div>`
                )
                .join('')
            : '<p class="muted">Nothing saved yet.</p>'
        }
        <fieldset style="margin-top:18px"><legend>Backup</legend>
          <p class="muted small" style="margin:0 0 8px">Data lives in this browser only. Download a backup to move it to another computer or keep it safe.</p>
          <div class="row">
            <button class="btn" type="button" data-h="export">Download backup</button>
            <button class="btn" type="button" data-h="import">Restore from backup…</button>
            <input type="file" id="backupIn" accept="application/json,.json" hidden />
            <span class="spacer"></span>
            <button class="btn danger ghost" type="button" data-h="wipe">Erase everything</button>
          </div>
        </fieldset>
      </div>`;
    if (!histDlg.open) histDlg.showModal();
  }
  histDlg.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-h]');
    if (!b) return;
    const act = b.dataset.h;
    if (act === 'close') histDlg.close();
    else if (act === 'open') {
      state.date = b.dataset.date;
      state.step = defaultStep();
      histDlg.close();
      render();
    } else if (act === 'del') {
      if (!confirm(`Delete ${niceDate(b.dataset.date)}? This can’t be undone.`)) return;
      delete db.days[b.dataset.date];
      persist();
      openHistory();
      render();
    } else if (act === 'export') download(`opd-schedule-backup-${todayISO()}.json`, Store.exportJSON(db), 'application/json');
    else if (act === 'import') $('#backupIn').click();
    else if (act === 'wipe') {
      if (!confirm('Erase every saved day, team lead list and setting in this browser? This can’t be undone.')) return;
      Store.clear();
      db = Store.load();
      settings = Sched.mergeSettings(null);
      state.step = 'import';
      histDlg.close();
      render();
      toast('Everything was erased.');
    }
  });
  histDlg.addEventListener('change', async (ev) => {
    if (ev.target.id !== 'backupIn' || !ev.target.files[0]) return;
    try {
      const next = Store.importJSON(await ev.target.files[0].text());
      if (!confirm('Replace what’s saved in this browser with this backup?')) return;
      db = next;
      settings = Sched.mergeSettings(db.settings);
      persist();
      state.step = defaultStep();
      histDlg.close();
      render();
      toast('Backup restored.');
    } catch (e) {
      toast(e.message || 'Could not read that file.');
    }
  });

  render();
})();
