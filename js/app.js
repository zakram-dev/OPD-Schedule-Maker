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
  const addDays = (iso, n) => {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${T.pad(d.getMonth() + 1)}-${T.pad(d.getDate())}`;
  };
  // inline SVG icon from the sprite in index.html (decorative; buttons carry their own text or aria-label)
  const icon = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
  const PLURAL = { PICK: 'Pickers', DISP: 'Dispensers', BR: 'Backroom', PREP: 'Prep', SM: 'SM / EXP', TL: 'Team leads' };

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
  let lastScreen = '';
  let enterTimer = null;
  function render() {
    if (!state.step) state.step = defaultStep();
    const d = db.days[state.date];
    const hasRows = !!(d && d.rows && d.rows.length);
    const hasPeople = !!(d && d.employees && d.employees.length);
    if (state.step === 'schedule' && !hasRows) state.step = 'review';
    document.querySelectorAll('#steps button').forEach((b) => {
      const s = b.dataset.step;
      const active = s === state.step;
      b.classList.toggle('active', active);
      b.classList.toggle('done', !active && ((s === 'import' && hasPeople) || (s === 'review' && hasRows)));
      if (active) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.disabled = s === 'schedule' && !hasRows;
    });
    $('#date').value = state.date;
    $('#dayToday').disabled = state.date === todayISO();
    app.innerHTML = state.step === 'import' ? viewImport() : state.step === 'review' ? viewReview() : viewSchedule();
    // entrance motion only when the screen changes, never on in-place edits
    const screen = state.date + '|' + state.step + '|' + (state.step === 'schedule' ? state.view : '');
    if (screen !== lastScreen) {
      lastScreen = screen;
      app.classList.remove('enter');
      void app.offsetWidth;
      app.classList.add('enter');
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => app.classList.remove('enter'), 1200);
    }
  }

  function noticeHTML() {
    if (!state.notice) return '';
    const n = state.notice;
    state.notice = null;
    const ok = n.kind === 'ok';
    return `<div class="notice ${ok ? 'ok' : 'warn'}" role="status">${icon(ok ? 'check-circle' : 'alert', 'notice-ic')}<div>${n.html}</div></div>`;
  }

  function viewHead(eyebrow, title, sub, aside) {
    return `<header class="view-head">
      <div class="view-head-main">
        <p class="eyebrow">${eyebrow}</p>
        <h1 class="view-title">${title}</h1>
        ${sub ? `<p class="view-sub">${sub}</p>` : ''}
      </div>
      ${aside ? `<div class="view-head-aside">${aside}</div>` : ''}
    </header>`;
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
    const weekday = new Date(state.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long' });
    const pct = prog ? Math.round(((prog.i + Math.min(1, prog.f || 0)) / n) * 100) : 0;
    return `
      ${viewHead('Step 1 of 3 · Add schedule', `Who’s working ${esc(weekday)}?`, `${esc(niceDate(state.date))}. Add the day’s schedule and the app reads the names and shift times for you.`)}
      ${noticeHTML()}
      <div class="import-grid">
        <section class="panel panel-drop" aria-labelledby="dropTitle">
          <div class="drop${state.reading ? ' busy' : ''}" id="drop" tabindex="0" role="button" aria-describedby="dropHint" aria-label="Choose screenshots, a PDF or a spreadsheet">
            <span class="drop-ic">${icon('upload')}</span>
            <strong class="drop-title" id="dropTitle"><span class="on-fine">Drop screenshots, a PDF or a spreadsheet</span><span class="on-touch">Choose screenshots, a PDF or a spreadsheet</span></strong>
            <span class="drop-hint" id="dropHint"><span class="on-fine">or <span class="link">browse your files</span> · you can also paste a screenshot with <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>V</kbd></span><span class="on-touch">Tap to pick from <span class="link">Photos or Files</span></span></span>
            <span class="formats" aria-hidden="true"><span>JPG</span><span>PNG</span><span>PDF</span><span>XLSX</span><span>CSV</span></span>
          </div>
          <input type="file" id="fileIn" accept="image/*,.pdf,application/pdf,.xlsx,.xls,.csv,.ods" multiple hidden />
          ${
            n
              ? `<ul class="thumbs" aria-label="Files ready to read">${state.files
                  .map(
                    (f, i) =>
                      `<li class="thumb">${
                        f.pdf
                          ? `<div class="pdf-tile">${icon('file')}<b>PDF</b><span>${esc(f.file.name)}</span></div>`
                          : `<img src="${f.url}" alt="Screenshot ${i + 1}: ${esc(f.file.name)}" />`
                      }${state.reading ? '' : `<button type="button" class="thumb-x" data-act="rm-file" data-i="${i}" aria-label="Remove ${esc(f.file.name)}">${icon('x')}</button>`}</li>`
                  )
                  .join('')}</ul>`
              : ''
          }
          ${
            state.reading && prog
              ? `<div class="reading" role="status">
                   <div class="reading-row"><span id="progLabel">${esc(prog.label)} file ${prog.i + 1} of ${n}…</span><span class="reading-pct" id="progPct">${pct}%</span></div>
                   <div class="progress"><div id="progBar" style="width:${pct}%"></div></div>
                 </div>`
              : ''
          }
          <div class="panel-foot">
            <p class="privacy">${icon('shield')}<span>Files are read on this device. Nothing is uploaded.</span></p>
            <div class="foot-actions">
              ${have ? `<span class="hint">${have} already on this day; new people are added.</span>` : ''}
              <button class="btn primary big" type="button" data-act="read" ${!n || state.reading ? 'disabled' : ''}>
                ${state.reading ? '<span class="spinner" aria-hidden="true"></span>Reading…' : n ? `Read ${n} file${n > 1 ? 's' : ''}${icon('arrow-right')}` : 'Read files'}
              </button>
            </div>
          </div>
        </section>

        <div class="import-side">
          <section class="panel" aria-labelledby="pasteTitle">
            <div class="panel-head">
              <span class="panel-ic">${icon('clipboard')}</span>
              <div><h2 id="pasteTitle">Paste or type the list</h2>
              <p class="panel-sub">One person per line. Add <code>TL</code> for team leads.</p></div>
            </div>
            <label class="sr-only" for="pasteText">Schedule list</label>
            <textarea id="pasteText" spellcheck="false" placeholder="Alice T 5:00 AM - 2:00 PM&#10;Bob J 5:30 AM - 10:30 AM&#10;Caleb S 6:00 AM - 3:00 PM TL&#10;Dana K 1:00 PM - 10:00 PM"></textarea>
            <div class="panel-actions"><button class="btn" type="button" data-act="paste">${icon('plus')}Add these people</button></div>
          </section>
          <section class="panel" aria-labelledby="otherTitle">
            <div class="panel-head">
              <span class="panel-ic">${icon('copy')}</span>
              <div><h2 id="otherTitle">Other ways to start</h2>
              <p class="panel-sub">Handy when the schedule barely changed.</p></div>
            </div>
            <div class="stack">
              <button class="option" type="button" data-act="copy-prev" ${lastSaved ? '' : 'disabled'}>
                <span class="option-t">Copy people from ${lastSaved ? esc(niceDate(lastSaved, { weekday: 'short', month: 'short', day: 'numeric' })) : 'a saved day'}</span>
                <span class="option-d">${lastSaved ? 'Same names and shifts, then adjust' : 'No saved days yet'}</span>
                ${icon('chevron-right', 'option-go')}
              </button>
              <button class="option" type="button" data-act="manual">
                <span class="option-t">Type people in by hand</span>
                <span class="option-d">Start with an empty row</span>
                ${icon('chevron-right', 'option-go')}
              </button>
            </div>
          </section>
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
    const stats = `<dl class="stats">
        <div><dt>People</dt><dd>${emps.length}</dd></div>
        <div class="r-TL"><dt>Team leads</dt><dd>${leads}</dd></div>
        ${bad ? `<div class="is-bad"><dt>To fix</dt><dd>${bad}</dd></div>` : ''}
      </dl>`;
    return `
      ${viewHead('Step 2 of 3 · Check people', 'Check the people', `${esc(niceDate(state.date))}. Fix any wrong names or times, and tick <b>Team lead</b> for leads. Leads get no job or lunch, and the app remembers them.`, stats)}
      ${noticeHTML()}
      <section class="panel panel-flush" aria-label="People working this day">
        <div class="table-wrap">
          <table class="review">
            <thead><tr><th class="c-num" scope="col">#</th><th scope="col">Name</th><th scope="col">Start</th><th scope="col">End</th><th scope="col">Hours</th><th scope="col">Lunch</th><th scope="col">Team lead</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead>
            <tbody>
              ${emps
                .map((e, i) => {
                  const okTimes = e.start != null && e.end != null && e.end > e.start;
                  const len = okTimes ? Sched.lunchLength(e.start, e.end, settings) : 0;
                  const label = e.name ? esc(e.name) : `row ${i + 1}`;
                  return `<tr data-id="${e.id}">
                    <td class="c-num">${i + 1}</td>
                    <td class="c-name"><input type="text" data-f="name" value="${esc(e.name)}" placeholder="Name" aria-label="Name, row ${i + 1}" autocomplete="off" class="${e.name ? '' : 'bad-input'}" />${
                      e.name && dupes.has(Sched.nameKey(e.name)) ? `<p class="field-note warn">${icon('alert')}Same name appears more than once</p>` : ''
                    }${okTimes ? '' : `<p class="field-note bad">${icon('alert')}End must be after start</p>`}</td>
                    <td class="c-start" data-label="Start"><input type="time" step="900" data-f="start" value="${T.toInput(e.start)}" aria-label="Start time for ${label}" class="${okTimes ? '' : 'bad-input'}" /></td>
                    <td class="c-end" data-label="End"><input type="time" step="900" data-f="end" value="${T.toInput(e.end)}" aria-label="End time for ${label}" class="${okTimes ? '' : 'bad-input'}" /></td>
                    <td class="c-hrs num" data-label="Hours" data-hrs>${okTimes ? T.hours(e.start, e.end) : '–'}</td>
                    <td class="c-len num" data-label="Lunch" data-len>${e.isTL ? '–' : len ? len + ' min' : 'none'}</td>
                    <td class="c-tl"><label class="check"><input type="checkbox" data-f="isTL" ${e.isTL ? 'checked' : ''} /><span class="check-box">${icon('check')}</span><span class="check-l">Team lead</span></label></td>
                    <td class="c-rm"><button class="icon-btn danger" type="button" data-act="rm-emp" aria-label="Remove ${label}">${icon('trash')}</button></td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
          ${
            emps.length
              ? ''
              : `<div class="empty">${icon('users', 'empty-ic')}<p><b>No one yet.</b> Add a person below, or go back to step 1 to read a schedule.</p></div>`
          }
        </div>
        <div class="actionbar">
          <div class="actionbar-tools">
            <button class="btn" type="button" data-act="add-emp">${icon('plus')}Add person</button>
            <button class="btn" type="button" data-act="sort-emp" ${emps.length > 1 ? '' : 'disabled'}>${icon('sort')}Sort by start</button>
            <button class="btn" type="button" data-act="goto-import">${icon('upload')}Add more files</button>
            <button class="btn ghost danger" type="button" data-act="clear-emp" ${emps.length ? '' : 'disabled'}>${icon('trash')}Remove everyone</button>
          </div>
          <div class="actionbar-main">
            ${bad ? `<span class="hint bad">${bad} row${bad > 1 ? 's' : ''} need a name or valid times</span>` : ''}
            <button class="btn primary big" type="button" data-act="make" ${emps.length ? '' : 'disabled'}>
              ${d.rows && d.rows.length ? 'Update jobs &amp; lunches' : 'Make jobs &amp; lunches'}${icon('arrow-right')}
            </button>
          </div>
        </div>
      </section>
      ${
        ocr
          ? `<details class="panel disclosure"><summary>${icon('info')}What the photo reader saw <span class="muted">(for troubleshooting)</span></summary>
             <textarea readonly aria-label="Text the photo reader saw">${esc(ocr.map((r, i) => `--- screenshot ${i + 1} ---\n` + r.lines.join('\n')).join('\n'))}</textarea></details>`
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
      bits.push(
        `<button class="lock" type="button" data-act="unlock" title="You changed this. Click to let the app choose again." aria-label="Edited by you. Unlock ${esc(r.name)} so the app can choose again">${icon('lock')}Edited</button>`
      );
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
    let rowIndex = 0;
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
        rowIndex++;
        body += `<div class="gc-row" data-act="focus" data-id="${r.id}" style="--i:${Math.min(rowIndex, 40)}" role="button" tabindex="0" aria-label="${esc(r.name)}, ${esc(roleLong(r.role))}, ${T.fmt(r.start)} to ${T.fmt(r.end)}${hasLunch ? `, lunch ${T.fmt(r.lunch)}` : ''}. Edit" title="Click to edit ${esc(r.name)}">
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
    return `<ul class="legend gc-legend" aria-label="Legend">
      ${['PICK', 'SM', 'DISP', 'BR', 'PREP', 'TL']
        .filter((k) => k === 'PICK' || k === 'DISP' || k === 'TL' || enabledSingles().includes(k))
        .map((k) => `<li><i class="sw r-${k}"></i>${esc(roleLong(k))}</li>`)
        .join('')}
      <li><i class="sw sw-lunch"></i>Lunch</li>
      <li><i class="sw sw-cover"></i>Covering a lunch</li>
      <li><i class="sw sw-count">2</i>Team members at lunch</li>
    </ul>`;
  }

  function viewChart(rows, byId) {
    const withLunch = rows.filter((r) => r.lunch != null && r.lunchLen && !r.isTL);
    const starts = [...new Set(withLunch.map((r) => r.lunch))].sort((a, b) => a - b);
    const order = { SM: 0, PICK: 1, DISP: 2, BR: 3, PREP: 4 };
    return `
      <section class="panel" id="panel-chart" role="tabpanel" aria-labelledby="tab-chart">
        <div class="panel-head">
          <div><h2>Lunch chart</h2>
          <p class="panel-sub">Each bar is a shift; the yellow block is lunch. Select anyone to change their job or lunch.</p></div>
          <button class="btn small" type="button" data-act="print-chart">${icon('print')}Print chart</button>
        </div>
        ${chartLegend()}
        <div class="gc-wrap" tabindex="0" role="region" aria-label="Lunch chart, scrolls sideways">${chartGrid(rows, byId)}</div>
      </section>
      <section class="panel" aria-labelledby="loTitle">
        <div class="panel-head">
          <div><h2 id="loTitle">Lunch order</h2>
          <p class="panel-sub">Who goes to lunch when. Colors show their job.</p></div>
        </div>
        <ol class="lo-list">
          ${
            starts.length
              ? starts
                  .map((t) => {
                    const ppl = withLunch.filter((r) => r.lunch === t).sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
                    return `<li class="lo-row"><time class="lo-time">${T.fmt(t)}</time><div class="lo-names">${ppl
                      .map(
                        (r) =>
                          `<span class="chip r-${r.role}" title="${esc(roleLong(r.role))}"><span class="dot" aria-hidden="true"></span>${esc(r.name)}<small>${
                            r.lunchLen >= 60 ? r.lunchLen / 60 + 'h' : r.lunchLen + 'm'
                          }</small><span class="sr-only">, ${esc(roleLong(r.role))}</span></span>`
                      )
                      .join('')}</div></li>`;
                  })
                  .join('')
              : '<li class="muted">No lunches today.</li>'
          }
        </ol>
      </section>`;
  }

  function viewTabs() {
    const tabs = [
      ['chart', 'gantt', 'Lunch chart', 'Chart'],
      ['table', 'pen', 'Edit jobs & lunches', 'Edit'],
      ['floor', 'users', 'Who’s on the floor', 'Floor'],
    ];
    return `<div class="tabs" role="tablist" aria-label="Schedule views">${tabs
      .map(
        ([v, ic, l, s]) =>
          `<button type="button" role="tab" id="tab-${v}" aria-controls="panel-${v}" aria-selected="${state.view === v}" tabindex="${state.view === v ? 0 : -1}" class="${
            state.view === v ? 'active' : ''
          }" data-act="view" data-v="${v}">${icon(ic)}<span class="tab-l">${esc(l)}</span><span class="tab-s" aria-hidden="true">${esc(s)}</span></button>`
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
      `<tr><th scope="row">${label}</th>${a.slots
        .map((s) => {
          const v = get(s);
          const low = lowFn && lowFn(s, v);
          return `<td class="${low ? 'lo' : ''} ${cls || ''}"${low ? ` title="Short at ${T.fmt(s.t)}"` : ''}>${v}</td>`;
        })
        .join('')}</tr>`;
    const inDisp = (t) => t >= settings.dispFrom && t < settings.dispTo;

    const issues = a.warnings.length;
    const kpi = (k, n, label, extra) =>
      `<div class="kpi ${k ? 'r-' + k : ''} ${extra || ''}"><span class="kpi-n">${n}</span><span class="kpi-l">${label}</span></div>`;
    const headAside = `
      <button class="btn" type="button" data-act="goto-review">${icon('users')}<span>Edit people</span></button>
      <button class="btn" type="button" data-act="print">${icon('print')}<span>Print</span></button>
      <button class="btn" type="button" data-act="csv">${icon('download')}<span>CSV</span></button>`;
    return `
      ${viewHead('Step 3 of 3 · Jobs &amp; lunches', esc(niceDate(state.date)), `${rows.length} people on the schedule. ${
        edited ? 'Your edits stay locked when you redo.' : 'Change any job or lunch; covers and warnings update right away.'
      }`, `<div class="head-tools">${headAside}</div>`)}
      ${noticeHTML()}
      <div class="kpis" aria-label="Today at a glance">
        ${order.filter((k) => a.counts[k]).map((k) => kpi(k, a.counts[k], PLURAL[k] || esc(roleLong(k)))).join('')}
        ${kpi('', lunches, 'Lunches', 'kpi-lunch')}
        ${kpi('', issues || icon('check'), issues ? `To check` : 'All clear', issues ? 'kpi-warn' : 'kpi-ok')}
      </div>

      <section class="plan ${issues ? 'warn' : 'ok'}" aria-label="Schedule status">
        <div class="plan-status">
          ${icon(issues ? 'alert' : 'check-circle', 'plan-ic')}
          <div>
            <p class="plan-title">${issues ? `${issues} thing${issues > 1 ? 's' : ''} to check` : 'Everything checks out'}</p>
            <p class="plan-sub">${
              issues ? 'The app couldn’t fix these on its own. Adjust below, or try another mix.' : 'Every job is covered, lunches follow the rules, and every one-person job has a lunch cover.'
            }</p>
          </div>
        </div>
        <div class="plan-actions">
          ${edited ? `<button class="btn ghost" type="button" data-act="unlock-all">${icon('undo')}Undo my edits</button>` : ''}
          <button class="btn" type="button" data-act="mix" title="Try a different mix of people and jobs">${icon('shuffle')}Try another mix</button>
          <button class="btn primary" type="button" data-act="redo" title="Re-plan everything you haven't changed by hand">${icon('refresh')}Redo schedule</button>
        </div>
        ${issues ? `<ul class="issues">${a.warnings.map((w) => `<li>${fmtW(w)}</li>`).join('')}</ul>` : ''}
      </section>

      ${viewTabs()}
      ${state.view === 'chart' ? viewChart(rows, byId) : ''}
      <section class="panel panel-flush" id="panel-table" role="tabpanel" aria-labelledby="tab-table" ${state.view === 'table' ? '' : 'hidden'}>
        <div class="table-wrap">
          <table class="sched">
            <thead><tr><th scope="col">Name</th><th scope="col">Shift</th><th scope="col">Hrs</th><th scope="col">Job</th><th scope="col">Lunch</th><th class="tl-headcell tl-cell" scope="col"><span class="sr-only">Timeline</span>${timelineHead()}</th><th scope="col">Notes</th></tr></thead>
            <tbody>
              ${rows
                .map(
                  (r) => `<tr data-id="${r.id}" class="r-${r.role}${r.isTL ? ' tl' : ''}">
                    <th scope="row" class="name">${esc(r.name)}</th>
                    <td class="shift num" data-label="Shift">${T.short(r.start)}–${T.short(r.end)}</td>
                    <td class="hrs num" data-label="Hours">${T.hours(r.start, r.end)}</td>
                    <td class="c-job" data-label="Job">${roleSelect(r)}</td>
                    <td class="c-lunch" data-label="Lunch">${lunchSelect(r)}</td>
                    <td class="tl-cell">${timeline(r, rows)}</td>
                    <td class="c-notes">${notesCell(r, rows, byId)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <ul class="legend legend-pad" aria-label="Legend">
          ${['PICK', 'DISP', ...enabledSingles()].map((k) => `<li><i class="sw r-${k}"></i>${esc(roleLong(k))}</li>`).join('')}
          <li><i class="sw sw-lunch"></i>Lunch</li>
          <li><i class="sw sw-cover"></i>Covering a lunch</li>
          <li><span class="warn-mark" aria-hidden="true">⚠</span>Lunch time outside the rules</li>
        </ul>
      </section>

      <section class="panel" id="panel-floor" role="tabpanel" aria-labelledby="tab-floor" ${state.view === 'floor' ? '' : 'hidden'}>
        <div class="panel-head">
          <div><h2>Who’s on the floor</h2>
          <p class="panel-sub">Every half hour: people actually working each job, not at lunch. Red means short.</p></div>
        </div>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Floor coverage by half hour, scrolls sideways">
          <table class="coverage">
            <thead><tr><th scope="col">Time</th>${a.slots.map((s) => `<th scope="col">${T.short(s.t)}</th>`).join('')}</tr></thead>
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
      </section>`;
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
        // loading/preparing report their own 0–1 progress; only real reading moves the bar
        if (/^(Loading|Preparing)/.test(label)) frac = 0;
        state.progress = { i, f: frac, label };
        const bar = $('#progBar');
        const lab = $('#progLabel');
        const pc = $('#progPct');
        const p = Math.round(((i + Math.min(1, frac || 0)) / n) * 100);
        if (bar) bar.style.width = p + '%';
        if (pc) pc.textContent = p + '%';
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
      return;
    }
    // chart rows act like buttons
    if (ev.target.classList.contains('gc-row') && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      ev.target.click();
      return;
    }
    // tabs: arrow keys move between views
    const tab = ev.target.closest('[role="tab"]');
    if (tab && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'Home' || ev.key === 'End')) {
      ev.preventDefault();
      const all = [...tab.parentElement.querySelectorAll('[role="tab"]')];
      const i = all.indexOf(tab);
      const next =
        ev.key === 'Home' ? 0 : ev.key === 'End' ? all.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
      state.view = all[next].dataset.v;
      render();
      $(`#tab-${state.view}`)?.focus();
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
  function goToDate(iso) {
    if (!iso || iso === state.date) return;
    state.date = iso;
    state.step = defaultStep();
    state.lastOcr = null;
    render();
  }
  $('#date').addEventListener('change', (ev) => goToDate(ev.target.value));
  $('#dayPrev').addEventListener('click', () => goToDate(addDays(state.date, -1)));
  $('#dayNext').addEventListener('click', () => goToDate(addDays(state.date, 1)));
  $('#dayToday').addEventListener('click', () => goToDate(todayISO()));
  document.querySelectorAll('#steps button').forEach((b) => b.addEventListener('click', () => setStep(b.dataset.step)));

  // ------------------------------------------------------------------ settings dialog
  const setDlg = $('#settingsDlg');
  $('#btnSettings').addEventListener('click', () => openSettings(settings));

  // ---- theme preference (per device): 'light' (default) | 'dark' | 'auto' (match device)
  const THEME_KEY = 'opd-schedule-maker:theme';
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function loadTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'dark' || t === 'auto' ? t : 'light';
    } catch (e) {
      return 'light';
    }
  }
  function applyTheme(pref) {
    const dark = pref === 'dark' || (pref === 'auto' && darkQuery && darkQuery.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  function saveTheme(pref) {
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch (e) {
      /* private mode: the choice just won't be remembered */
    }
  }
  applyTheme(loadTheme());
  if (darkQuery) {
    const onDeviceTheme = () => loadTheme() === 'auto' && applyTheme('auto');
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onDeviceTheme);
    else if (darkQuery.addListener) darkQuery.addListener(onDeviceTheme);
  }
  // preview a theme while the dialog is open; closing without Save puts the saved one back
  setDlg.addEventListener('change', (ev) => {
    if (ev.target.name === 'theme') applyTheme(ev.target.value);
  });
  setDlg.addEventListener('close', () => applyTheme(loadTheme()));

  function openSettings(s, theme) {
    const L = s.lunch;
    const th = theme || loadTheme();
    const themeOpt = (v, ic, label) =>
      `<label><input type="radio" name="theme" value="${v}" ${th === v ? 'checked' : ''} /><span>${icon(ic)}${label}</span></label>`;
    const num = (name, v, step) => `<input type="number" name="${name}" value="${v}" step="${step || 0.5}" min="0" />`;
    const time = (name, v) => `<input type="time" step="900" name="${name}" value="${T.toInput(v)}" />`;
    setDlg.innerHTML = `
      <header><div><p class="eyebrow">Your store</p><h3 id="settingsTitle">Settings</h3></div><button class="icon-btn" type="button" data-dlg="close" aria-label="Close settings">${icon('x')}</button></header>
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
        <fieldset class="prefs"><legend>Preferences</legend>
          <div class="form-line pref-line">
            <span class="pref-label" id="themeLabel">Appearance</span>
            <div class="seg" role="radiogroup" aria-labelledby="themeLabel">
              ${themeOpt('light', 'sun', 'Light')}
              ${themeOpt('dark', 'moon', 'Dark')}
              ${themeOpt('auto', 'monitor', 'Match device')}
            </div>
          </div>
          <p class="muted small" style="margin:4px 0 0">Light is the default. This choice is saved on this device only.</p>
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
    if (b.dataset.dlg === 'defaults') {
      applyTheme('light');
      return openSettings(Sched.defaultSettings(), 'light');
    }
    if (b.dataset.dlg === 'save') {
      const f = new FormData($('#setForm'));
      const theme = f.get('theme');
      if (theme === 'light' || theme === 'dark' || theme === 'auto') saveTheme(theme);
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
      <header><div><p class="eyebrow">This browser</p><h3 id="historyTitle">Saved days</h3></div><button class="icon-btn" type="button" data-h="close" aria-label="Close saved days">${icon('x')}</button></header>
      <div class="body">
        <p class="dlg-intro">Everything saves automatically in this browser. Saved schedules are also used to rotate jobs.</p>
        ${
          days.length
            ? `<ul class="hist">${days
                .map((d) => {
                  const made = d.rows && d.rows.length;
                  return `<li class="hist-item${d.date === state.date ? ' current' : ''}">
                    <span class="hist-date"><b>${esc(niceDate(d.date, { day: 'numeric' }))}</b><small>${esc(niceDate(d.date, { month: 'short' }))}</small></span>
                    <span class="hist-main"><span class="when">${esc(niceDate(d.date, { weekday: 'long', year: 'numeric' }))}</span>
                    <span class="hist-meta">${d.employees.length} people · <span class="pill ${made ? 'ok' : ''}">${made ? 'Scheduled' : 'Not scheduled'}</span></span></span>
                    <button class="btn small" type="button" data-h="open" data-date="${d.date}">Open</button>
                    <button class="icon-btn danger" type="button" data-h="del" data-date="${d.date}" aria-label="Delete ${esc(niceDate(d.date))}">${icon('trash')}</button>
                  </li>`;
                })
                .join('')}</ul>`
            : `<div class="empty">${icon('archive', 'empty-ic')}<p><b>Nothing saved yet.</b> Days appear here once you add people.</p></div>`
        }
        <fieldset class="backup"><legend>Backup</legend>
          <p class="dlg-intro">Data lives in this browser only. Download a backup to move it to another computer or keep it safe.</p>
          <div class="row">
            <button class="btn" type="button" data-h="export">${icon('download')}Download backup</button>
            <button class="btn" type="button" data-h="import">${icon('upload')}Restore from backup…</button>
            <input type="file" id="backupIn" accept="application/json,.json" hidden />
            <span class="spacer"></span>
            <button class="btn ghost danger" type="button" data-h="wipe">${icon('trash')}Erase everything</button>
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
