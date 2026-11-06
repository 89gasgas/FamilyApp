/* FamilyApp: shopping list (SP-01…SP-09), to-dos (TD-01…TD-07), notifications (NT-01…NT-06), expenses (CO-01…CO-08), calendar (CA-01…CA-09). */
(() => {
  'use strict';
  // If the Supabase library failed to load (interrupted download), reload once instead of a blank page.
  if (typeof window.supabase === 'undefined') {
    let tried = false;
    try { tried = sessionStorage.getItem('fa.reloaded') === '1'; sessionStorage.setItem('fa.reloaded', '1'); } catch (e) {}
    if (!tried) { location.reload(); return; }
  }
  try { sessionStorage.removeItem('fa.reloaded'); } catch (e) {}
  const cfg = window.FA_CONFIG;
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  // Local tests only: window.FA_TEST_OFFLINE = true simulates having no signal.
  const netFetch = (...a) => (isLocal && window.FA_TEST_OFFLINE
    ? Promise.reject(new TypeError('Failed to fetch')) : fetch(...a));
  const sb = supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    global: { fetch: netFetch },
  });
  const $ = (id) => document.getElementById(id);

  let me = null;            // { email, family_id, display_name }
  let authEmail = "";       // signed-in Google account, also when not a member
  let items = new Map();    // id -> shopping item
  let tasks = new Map();    // id -> task (TD)
  let expenses = new Map(); // id -> expense (CO)
  let cats = new Map();     // id -> expense category (CO)
  let events = new Map();   // id -> calendar event (CA)
  let members = [];         // [{ email, display_name }] of my family
  let queue = [];           // pending changes, replayed when online
  let channel = null;
  let flushing = false;
  let online = navigator.onLine;

  const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const storeKey = () => 'fa.state.' + me.email;

  // ---------- local persistence (SP-04 offline) ----------
  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ items: [...items.values()], tasks: [...tasks.values()],
        expenses: [...expenses.values()], cats: [...cats.values()], events: [...events.values()], members, queue }));
    } catch (e) {}
  }
  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey()) || 'null');
      if (raw) {
        items = new Map(raw.items.map((i) => [i.id, i]));
        tasks = new Map((raw.tasks || []).map((i) => [i.id, i]));
        expenses = new Map((raw.expenses || []).map((i) => [i.id, i]));
        cats = new Map((raw.cats || []).map((i) => [i.id, i]));
        events = new Map((raw.events || []).map((i) => [i.id, i]));
        members = raw.members || [];
        queue = raw.queue || [];
      }
    } catch (e) {}
  }

  // ---------- rendering ----------
  function sorted(bought) {
    return [...items.values()].filter((i) => !!i.bought === bought).sort((a, b) => a.position - b.position);
  }
  function li(item) {
    const el = document.createElement('li');
    el.className = 'item';
    el.dataset.id = item.id;
    if (item.optional) el.classList.add('opt');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    const tag = document.createElement('button'); // SP-08: tap to switch "se in offerta"
    tag.className = 'tag';
    tag.type = 'button';
    tag.textContent = '🏷️';
    tag.setAttribute('aria-pressed', item.optional ? 'true' : 'false');
    tag.setAttribute('aria-label', 'Se in offerta');
    tag.title = item.optional ? 'Se in offerta (tocca per renderlo urgente)' : 'Tocca per segnarlo "se in offerta"';
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '≡';
    handle.setAttribute('aria-label', 'Sposta');
    el.append(name, tag, handle);
    return el;
  }
  let urgentOnly = false;
  try { urgentOnly = localStorage.getItem('fa.urgentOnly') === '1'; } catch (e) {}
  function render() {
    const all = sorted(false), bou = sorted(true);
    const nOpt = all.filter((i) => i.optional).length, nUrg = all.length - nOpt;
    const act = urgentOnly ? all.filter((i) => !i.optional) : all;
    $('active').replaceChildren(...act.map(li));
    $('bought').replaceChildren(...bou.map(li));
    $('empty').hidden = act.length > 0;
    $('empty').textContent = all.length ? 'Niente di urgente.' : 'Niente da comprare.';
    $('count').textContent = `${nUrg} da comprare` + (nOpt ? ` + ${nOpt} se in offerta` : '');
    $('urgent-only').checked = urgentOnly;
    $('bought-title').hidden = bou.length === 0;
    renderTodo();
    renderMoney();
    renderCal();
    renderSync();
  }
  function renderSync() {
    const s = $('sync');
    if (!online) { s.textContent = 'offline'; s.className = 'sync off'; }
    else if (queue.length) { s.textContent = 'sincronizzo…'; s.className = 'sync'; }
    else { s.textContent = ''; s.className = 'sync'; }
  }
  function flash(id) {
    const el = document.querySelector(`.item[data-id="${id}"]`);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); el.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------- local changes ----------
  const SHOP = 'shopping_items', TASKS = 'tasks', EXP = 'expenses', CATS = 'expense_categories', EVT = 'events';
  const tableOf = (op) => op.t || SHOP; // ops saved before TD have no table: shopping
  const mapOf = (t) => ({ [TASKS]: tasks, [EXP]: expenses, [CATS]: cats, [EVT]: events }[t] || items);
  function setFields(id, fields, t = SHOP) {
    const it = mapOf(t).get(id);
    if (!it) return;
    Object.assign(it, fields);
    const last = queue[queue.length - 1];
    if (last && last.op === 'set' && last.id === id && tableOf(last) === t) Object.assign(last.fields, fields);
    else queue.push({ op: 'set', t, id, fields: { ...fields } });
    commit();
  }
  function commit() { save(); render(); flush(); }

  function addProduct(raw) {
    const optional = /\?\s*$/.test(raw); // SP-08: "Olive?" = se in offerta
    const text = raw.replace(/[\s?]+$/, '');
    const key = norm(text);
    if (!key) return;
    const existing = [...items.values()].find((i) => norm(i.name) === key);
    if (existing) {
      const f = {};
      if (existing.bought) Object.assign(f, { bought: false, bought_by: null, bought_at: null }); // SP-05
      if (optional && !existing.optional) f.optional = true;
      if (Object.keys(f).length) setFields(existing.id, f);
      if (urgentOnly && existing.optional) { urgentOnly = false; render(); }
      flash(existing.id); // SP-02: no duplicate
      return;
    }
    const max = Math.max(0, ...[...items.values()].map((i) => i.position));
    const it = {
      id: crypto.randomUUID(), family_id: me.family_id, name: text.trim().replace(/\s+/g, ' '),
      position: max + 1, bought: false, added_by: me.display_name, added_at: new Date().toISOString(),
      optional,
    };
    items.set(it.id, it);
    queue.push({ op: 'add', id: it.id, name: it.name, position: it.position, optional });
    if (urgentOnly && optional) urgentOnly = false;
    commit();
    flash(it.id);
  }

  function toggle(id) {
    const it = items.get(id);
    if (!it) return;
    if (it.bought) setFields(id, { bought: false, bought_by: null, bought_at: null });
    else setFields(id, { bought: true, bought_by: me.display_name, bought_at: new Date().toISOString() });
  }

  // ---------- sync with Supabase ----------
  const isNetErr = (e) => !e || /fetch|network|Failed|timeout|Load failed/i.test(e.message || String(e));

  function applyPending(map, t) {
    for (const op of queue) {
      if (tableOf(op) !== t) continue;
      if (op.op === 'add' && !map.has(op.id)) {
        const local = mapOf(t).get(op.id);
        if (local) map.set(op.id, local);
      } else if (op.op === 'set' && map.has(op.id)) Object.assign(map.get(op.id), op.fields);
      else if (op.op === 'del') map.delete(op.id);
    }
    return map;
  }

  async function rows(t) { // all of the family's rows, past the server's 1000-row page
    const out = [];
    for (let from = 0; ; from += 1000) {
      const r = await sb.from(t).select('*').eq('family_id', me.family_id).order('id').range(from, from + 999);
      if (r.error) return r;
      out.push(...r.data);
      if (r.data.length < 1000) return { data: out };
    }
  }

  async function fetchAll() {
    const [a, b, e, c, v, m] = await Promise.all([rows(SHOP), rows(TASKS), rows(EXP), rows(CATS), rows(EVT),
      sb.from('members').select('email,display_name').eq('family_id', me.family_id)]);
    const error = a.error || b.error || e.error || c.error || v.error || m.error;
    if (error) { if (isNetErr(error)) setOnline(false); return; }
    items = applyPending(new Map(a.data.map((i) => [i.id, i])), SHOP);
    tasks = applyPending(new Map(b.data.map((i) => [i.id, i])), TASKS);
    expenses = applyPending(new Map(e.data.map((i) => [i.id, i])), EXP);
    cats = applyPending(new Map(c.data.map((i) => [i.id, i])), CATS);
    events = applyPending(new Map(v.data.map((i) => [i.id, i])), EVT);
    members = m.data.sort((x, y) => x.display_name.localeCompare(y.display_name));
    save(); render();
  }

  async function flush() {
    if (flushing || !queue.length) { renderSync(); return; }
    flushing = true;
    try {
      while (queue.length) {
        const op = queue[0];
        let res;
        try {
          if (tableOf(op) !== SHOP) { // to-dos, expenses, categories
            const tb = sb.from(tableOf(op));
            if (op.op === 'add') res = await tb.upsert(op.row, { onConflict: 'id', ignoreDuplicates: true });
            else if (op.op === 'del') res = await tb.delete().eq('id', op.id);
            else res = await tb.update(op.fields).eq('id', op.id);
          } else if (op.op === 'add') {
            res = await sb.rpc('add_item', { p_id: op.id, p_name: op.name, p_position: op.position,
                                             p_optional: !!op.optional });
          } else {
            res = await sb.from(SHOP).update(op.fields).eq('id', op.id).select();
          }
        } catch (e) { res = { error: e }; }
        if (res.error) {
          if (isNetErr(res.error)) { setOnline(false); break; }
          console.warn('change rejected', op, res.error);
          queue.shift();
          continue;
        }
        queue.shift();
        if (op.op === 'add' && tableOf(op) === SHOP) {
          const row = res.data;
          if (row && row.id !== op.id) { // same product already on the server: adopt its id
            items.delete(op.id);
            for (const q of queue) if (q.id === op.id) q.id = row.id;
          }
          if (row) items.set(row.id, row);
        }
        setOnline(true);
        save();
      }
    } finally { flushing = false; }
    if (!queue.length) await fetchAll();
    renderSync();
  }

  function setOnline(v) { online = v; renderSync(); }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('items-' + me.family_id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'shopping_items', filter: 'family_id=eq.' + me.family_id },
        (p) => { // SP-03 real time
          const id = (p.new && p.new.id) || (p.old && p.old.id);
          if (queue.some((q) => q.id === id)) return; // our pending change wins until it is sent
          if (p.eventType === 'DELETE') items.delete(id); else items.set(id, p.new);
          save(); render();
        });
    for (const t of [TASKS, EXP, CATS, EVT]) {
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table: t, filter: 'family_id=eq.' + me.family_id },
        (p) => { // TD-03, CO-06 real time
          const id = (p.new && p.new.id) || (p.old && p.old.id);
          if (queue.some((q) => q.id === id)) return;
          if (p.eventType === 'DELETE') mapOf(t).delete(id); else mapOf(t).set(id, p.new);
          save(); render();
        });
    }
    channel
      .subscribe((status) => { if (status === 'SUBSCRIBED') { setOnline(true); flush(); fetchAll(); } });
  }

  // ---------- drag to reorder (SP-06) ----------
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.handle');
    if (!h) return;
    const el = h.closest('.item');
    drag = { el, list: el.parentElement };
    el.classList.add('dragging');
    h.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const sibs = [...drag.list.children].filter((c) => c !== drag.el);
    const before = sibs.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (before) { if (drag.el.nextSibling !== before) drag.list.insertBefore(drag.el, before); }
    else if (drag.list.lastElementChild !== drag.el) drag.list.appendChild(drag.el);
  });
  function endDrag() {
    if (!drag) return;
    const { el, list } = drag;
    drag = null;
    el.classList.remove('dragging');
    const ids = [...list.children].map((c) => c.dataset.id);
    const i = ids.indexOf(el.dataset.id);
    const prev = items.get(ids[i - 1]), next = items.get(ids[i + 1]);
    const cur = items.get(el.dataset.id);
    let pos = cur.position;
    if (prev && next) pos = (prev.position + next.position) / 2;
    else if (prev) pos = Math.max(cur.position, prev.position + 1);
    else if (next) pos = Math.min(cur.position, next.position - 1);
    const outOfOrder = (prev && prev.position >= cur.position) || (next && next.position <= cur.position);
    if (outOfOrder) setFields(cur.id, { position: pos }); else render();
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // ---------- suggestions while typing (SP-09) ----------
  const fold = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  function hideSuggest() { $('suggest').hidden = true; $('suggest').replaceChildren(); }
  function showSuggest() {
    const raw = $('add-input').value;
    const q = fold(raw.replace(/[\s?]+$/, ''));
    if (q.length < 2) { hideSuggest(); return; }
    const rank = (i) => { const n = fold(i.name); return n.startsWith(q) ? 0 : (' ' + n).includes(' ' + q) ? 1 : 2; };
    const found = [...items.values()].filter((i) => fold(i.name).includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'it')).slice(0, 6);
    if (!found.length) { hideSuggest(); return; }
    $('suggest').replaceChildren(...found.map((i) => {
      const el = document.createElement('li');
      el.dataset.id = i.id;
      el.setAttribute('role', 'option');
      const n = document.createElement('span');
      n.textContent = (i.optional ? '🏷️ ' : '') + i.name;
      const hint = document.createElement('small');
      hint.textContent = i.bought ? 'rimetti in lista' : 'già in lista';
      el.append(n, hint);
      return el;
    }));
    $('suggest').hidden = false;
  }
  $('add-input').addEventListener('input', showSuggest);
  $('add-input').addEventListener('focus', showSuggest);
  $('add-input').addEventListener('blur', () => setTimeout(hideSuggest, 150));
  $('suggest').addEventListener('pointerdown', (e) => {
    const el = e.target.closest('li');
    if (!el) return;
    e.preventDefault(); // keep the keyboard open
    const it = items.get(el.dataset.id);
    if (!it) return;
    const wantOpt = /\?\s*$/.test($('add-input').value);
    addProduct(it.name + (wantOpt ? '?' : ''));
    $('add-input').value = '';
    hideSuggest();
  });

  // ---------- UI events ----------
  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addProduct($('add-input').value);
    $('add-input').value = '';
    hideSuggest();
    $('add-input').focus();
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.item .tag');
    if (t) {
      const it = items.get(t.parentElement.dataset.id);
      if (it) setFields(it.id, { optional: !it.optional });
      return;
    }
    const n = e.target.closest('.item .name');
    if (n) toggle(n.parentElement.dataset.id);
  });
  $('urgent-only').addEventListener('change', (e) => {
    urgentOnly = e.target.checked;
    try { localStorage.setItem('fa.urgentOnly', urgentOnly ? '1' : '0'); } catch (err) {}
    render();
  });
  $('flyers-btn').addEventListener('click', () => $('flyers').showModal()); // SP-07
  $('google-btn').addEventListener('click', () =>
    sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }));
  $('logout-btn').addEventListener('click', async () => { await pushForget(); await sb.auth.signOut(); location.reload(); });
  if (isLocal) {
    $('dev-login').hidden = false;
    $('dev-login').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-dev]');
      if (!b) return;
      const users = await (await fetch('/.test-users.json')).json();
      const u = users[+b.dataset.dev];
      const { error } = await sb.auth.signInWithPassword({ email: u.email, password: u.password });
      if (error) alert(error.message); else location.reload();
    });
  }
  window.addEventListener('online', () => { setOnline(true); flush(); fetchAll(); });
  window.addEventListener('offline', () => setOnline(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && me) { flush(); fetchAll(); } });
  setInterval(() => { if (me && queue.length) flush(); }, 15000);

  // ---------- to-dos (TD-01…TD-07) ----------
  const WD = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const MO = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const diffDays = (s) => Math.round((parseDay(s) - parseDay(today())) / 86400000);
  function dueLabel(s) {
    const n = diffDays(s), d = parseDay(s);
    if (n === 0) return 'oggi';
    if (n === 1) return 'domani';
    if (n === -1) return 'ieri';
    if (n > -7 && n < 7) return `${WD[d.getDay()]} ${d.getDate()}`;
    return `${d.getDate()} ${MO[d.getMonth()]}` + (d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '');
  }
  const doneLabel = (iso) => { const d = new Date(iso); return dueLabel(ymd(d)); };
  const nameOf = (email) => (members.find((m) => m.email === email) || {}).display_name || (email || '?').split('@')[0];
  const whoShort = (a) => (!a ? '' : a === 'both' ? members.map((m) => m.display_name[0]).join('+') || 'Tutti' : nameOf(a)[0]);
  const whoLong = (a) => (!a ? 'nessuno' : a === 'both' ? 'tutti e due' : nameOf(a));
  const isMine = (t) => !t.assignee || t.assignee === 'both' || t.assignee === me.email; // TD-06

  let mineOnly = false;
  try { mineOnly = localStorage.getItem('fa.mineOnly') === '1'; } catch (e) {}
  let newWho = null, newDue = null;

  function taskLi(t) {
    const el = document.createElement('li');
    el.className = 'item task';
    el.dataset.id = t.id;
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'check';
    check.setAttribute('aria-label', t.done ? 'Rimetti da fare' : 'Fatta');
    check.textContent = t.done ? '✓' : '';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    if (t.done) meta.textContent = `${t.done_by || ''}${t.done_at ? ', ' + doneLabel(t.done_at) : ''}`;
    else {
      if (t.due) {
        const due = document.createElement('span');
        const n = diffDays(t.due);
        due.className = 'due' + (n < 0 ? ' late' : n === 0 ? ' today' : '');
        due.textContent = dueLabel(t.due);
        meta.append(due);
      }
      if (t.assignee) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = whoShort(t.assignee);
        who.title = whoLong(t.assignee);
        meta.append(who);
      }
    }
    el.append(check, title, meta);
    return el;
  }

  function renderTodo() {
    if (!me) return;
    const all = [...tasks.values()];
    const open = all.filter((t) => !t.done);
    const shown = (mineOnly ? open.filter(isMine) : open).sort((a, b) => // TD-05
      (a.due ? 0 : 1) - (b.due ? 0 : 1) || (a.due || '').localeCompare(b.due || '') ||
      (a.created_at || '').localeCompare(b.created_at || ''));
    const done = all.filter((t) => t.done).sort((a, b) => (b.done_at || '').localeCompare(a.done_at || '')).slice(0, 10);
    $('td-open').replaceChildren(...shown.map(taskLi));
    $('td-done').replaceChildren(...done.map(taskLi));
    $('td-empty').hidden = shown.length > 0;
    $('td-empty').textContent = open.length ? 'Niente per te.' : 'Niente da fare.';
    $('td-done-title').hidden = done.length === 0;
    $('mine-only').checked = mineOnly;
    const urgent = open.filter((t) => t.due && t.due <= today()).length; // TD-01 badge
    $('td-badge').hidden = urgent === 0;
    $('td-badge').textContent = urgent;
    $('td-who').textContent = 'Chi: ' + whoLong(newWho);
    $('td-who').classList.toggle('set', !!newWho);
    $('td-when').textContent = '📅 ' + (newDue ? dueLabel(newDue) : 'Quando');
    $('td-when').classList.toggle('set', !!newDue);
  }

  $('td-form').addEventListener('submit', (e) => { // TD-02
    e.preventDefault();
    const title = $('td-input').value.trim().replace(/\s+/g, ' ');
    if (!title) return;
    const row = {
      id: crypto.randomUUID(), family_id: me.family_id, title, assignee: newWho, due: newDue, done: false,
      created_by: me.display_name, created_at: new Date().toISOString(),
    };
    tasks.set(row.id, row);
    queue.push({ op: 'add', t: TASKS, id: row.id, row: { ...row } });
    $('td-input').value = '';
    newWho = null; newDue = null; $('td-due').value = '';
    commit();
    flash(row.id);
    $('td-input').focus();
  });
  $('td-who').addEventListener('click', () => {
    const opts = [null, ...members.map((m) => m.email), 'both'];
    newWho = opts[(opts.indexOf(newWho) + 1) % opts.length];
    renderTodo();
  });
  $('td-when').addEventListener('click', () => {
    const d = $('td-due');
    if (!d.value) d.value = today();
    try { d.showPicker(); } catch (e) { d.focus(); d.click(); }
  });
  $('td-due').addEventListener('change', (e) => { newDue = e.target.value || null; renderTodo(); });
  $('mine-only').addEventListener('change', (e) => {
    mineOnly = e.target.checked;
    try { localStorage.setItem('fa.mineOnly', mineOnly ? '1' : '0'); } catch (err) {}
    renderTodo();
  });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    show(b.dataset.tab);
    try { localStorage.setItem('fa.tab', b.dataset.tab); } catch (err) {}
    window.scrollTo(0, 0);
  });

  let editing = null; // TD-07
  function openEdit(id) {
    const t = tasks.get(id);
    if (!t) return;
    editing = id;
    $('te-title').value = t.title;
    const sel = $('te-who');
    sel.replaceChildren(...[['', 'Nessuno'], ...members.map((m) => [m.email, m.display_name]), ['both', 'Tutti e due']]
      .map(([v, l]) => Object.assign(document.createElement('option'), { value: v, textContent: l })));
    sel.value = t.assignee || '';
    $('te-due').value = t.due || '';
    $('td-edit').showModal();
  }
  $('td-edit-form').addEventListener('submit', (e) => { // save on submit (the dialog close event is not reliable)
    const t = tasks.get(editing);
    if (e.submitter && e.submitter.value === 'save' && t) {
      const title = $('te-title').value.trim().replace(/\s+/g, ' ');
      const f = {};
      if (title && title !== t.title) f.title = title;
      const who = $('te-who').value || null;
      if (who !== (t.assignee || null)) f.assignee = who;
      const due = $('te-due').value || null;
      if (due !== (t.due || null)) f.due = due;
      if (Object.keys(f).length) setFields(t.id, f, TASKS);
    }
    editing = null;
  });
  $('te-delete').addEventListener('click', () => {
    const t = tasks.get(editing);
    if (!t || !confirm(`Eliminare "${t.title}"?`)) return;
    tasks.delete(t.id);
    queue.push({ op: 'del', t: TASKS, id: t.id });
    $('td-edit').close('cancel');
    commit();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('.task');
    if (!el) return;
    const t = tasks.get(el.dataset.id);
    if (!t) return;
    if (e.target.closest('.check')) { // TD-04
      setFields(t.id, t.done ? { done: false, done_by: null, done_at: null }
        : { done: true, done_by: me.display_name, done_at: new Date().toISOString() }, TASKS);
    } else openEdit(t.id);
  });

  // ---------- monthly expenses (CO-01…CO-08) ----------
  const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
  const money = (cents) => eur.format(cents / 100);
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const PALETTE = ['#3b7dd8', '#2f9e5b', '#d9534f', '#e6a700', '#8e5cc4', '#1fa3a3', '#f08a24', '#e2589b', '#5c6bc0', '#7a6a58'];
  let moMode = 'month';
  let moAt = new Date(); moAt = new Date(moAt.getFullYear(), moAt.getMonth(), 1); // first day of the shown period
  try { if (localStorage.getItem('fa.moMode') === 'year') moMode = 'year'; } catch (e) {}

  const catList = (all) => [...cats.values()].filter((c) => all || !c.hidden)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  function periodRange() {
    const y = moAt.getFullYear(), m = moAt.getMonth();
    const from = moMode === 'year' ? new Date(y, 0, 1) : new Date(y, m, 1);
    const to = moMode === 'year' ? new Date(y + 1, 0, 1) : new Date(y, m + 1, 1);
    return [isoDay(from), isoDay(to)];
  }
  const inPeriod = () => { const [a, b] = periodRange(); return [...expenses.values()].filter((e) => e.spent_on >= a && e.spent_on < b); };
  function periodLabel() {
    return moMode === 'year' ? String(moAt.getFullYear())
      : cap(moAt.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }));
  }
  function isCurrentPeriod() {
    const now = new Date();
    return moAt.getFullYear() === now.getFullYear() && (moMode === 'year' || moAt.getMonth() === now.getMonth());
  }

  function renderMoney() { // CO-02, CO-04
    if (!me) return;
    const list = inPeriod();
    const byCat = new Map();
    for (const e of list) byCat.set(e.category_id, (byCat.get(e.category_id) || 0) + e.amount_cents);
    const total = [...byCat.values()].reduce((a, b) => a + b, 0);
    $('mo-label').textContent = periodLabel();
    $('mo-next').disabled = isCurrentPeriod();
    for (const b of $('mo-mode').children) b.classList.toggle('on', b.dataset.v === moMode);
    $('mo-total').textContent = money(total);
    $('mo-sub').textContent = total ? `${list.length} ${list.length === 1 ? 'spesa' : 'spese'}` : 'nessuna spesa';

    // donut: one arc per category, in category order
    const C = 2 * Math.PI * 38, svgNS = 'http://www.w3.org/2000/svg';
    const arcs = [];
    const bg = document.createElementNS(svgNS, 'circle');
    Object.entries({ cx: 50, cy: 50, r: 38, fill: 'none', 'stroke-width': 13, class: 'donut-bg' }).forEach(([k, v]) => bg.setAttribute(k, v));
    arcs.push(bg);
    let start = 0;
    for (const c of catList(true)) {
      const v = byCat.get(c.id);
      if (!v) continue;
      const len = (v / total) * C;
      const a = document.createElementNS(svgNS, 'circle');
      Object.entries({ cx: 50, cy: 50, r: 38, fill: 'none', 'stroke-width': 13, stroke: c.color,
        'stroke-dasharray': `${Math.max(len - 0.4, 0.01)} ${C}`, 'stroke-dashoffset': -start }).forEach(([k, v2]) => a.setAttribute(k, v2));
      arcs.push(a);
      start += len;
    }
    $('mo-donut').replaceChildren(...arcs);

    // icons around the ring: tap = add an expense in that category (CO-03)
    const ring = $('mo-ring');
    ring.querySelectorAll('.ring-icon').forEach((n) => n.remove());
    const shown = catList(false);
    shown.forEach((c, i) => {
      const ang = (-90 + (360 / shown.length) * i) * Math.PI / 180;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ring-icon';
      b.dataset.cat = c.id;
      b.title = c.name;
      b.setAttribute('aria-label', 'Aggiungi spesa: ' + c.name);
      b.textContent = c.icon;
      b.style.left = `${50 + 44 * Math.cos(ang)}%`;
      b.style.top = `${50 + 44 * Math.sin(ang)}%`;
      b.style.borderColor = c.color;
      b.style.background = `color-mix(in srgb, ${c.color} 22%, var(--card))`;
      ring.appendChild(b);
    });

    // categories of the period, highest first
    const rowsOut = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => {
      const c = cats.get(id) || { name: '?', icon: '❔', color: '#888' };
      const li2 = document.createElement('li');
      li2.className = 'item mo-row';
      li2.dataset.cat = id;
      li2.innerHTML = '<span class="mo-ic"></span><span class="name"></span><span class="mo-pct"></span><span class="mo-amt"></span>';
      li2.querySelector('.mo-ic').textContent = c.icon;
      li2.querySelector('.mo-ic').style.background = c.color;
      li2.querySelector('.name').textContent = c.name;
      li2.querySelector('.mo-pct').textContent = Math.round((v / total) * 100) + '%';
      li2.querySelector('.mo-amt').textContent = money(v);
      return li2;
    });
    $('mo-list').replaceChildren(...rowsOut);
    if ($('cat-dlg').open) renderCatDetail();
  }

  $('mo-prev').addEventListener('click', () => {
    moAt = moMode === 'year' ? new Date(moAt.getFullYear() - 1, 0, 1) : new Date(moAt.getFullYear(), moAt.getMonth() - 1, 1);
    renderMoney();
  });
  $('mo-next').addEventListener('click', () => {
    if (isCurrentPeriod()) return;
    moAt = moMode === 'year' ? new Date(moAt.getFullYear() + 1, 0, 1) : new Date(moAt.getFullYear(), moAt.getMonth() + 1, 1);
    renderMoney();
  });
  $('mo-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    moMode = b.dataset.v;
    const now = new Date();
    if (moMode === 'month' && moAt.getFullYear() === now.getFullYear()) moAt = new Date(now.getFullYear(), now.getMonth(), 1);
    try { localStorage.setItem('fa.moMode', moMode); } catch (err) {}
    renderMoney();
  });

  // add / edit an expense (CO-03, CO-05)
  let exEditing = null;
  function openExpense(catId, id) {
    const e = id && expenses.get(id);
    exEditing = e ? e.id : null;
    const cid = e ? e.category_id : catId;
    const c = cats.get(cid);
    $('ex-title').textContent = e ? 'Modifica spesa' : `${c ? c.icon + ' ' + c.name : 'Nuova spesa'}`;
    $('ex-cat').replaceChildren(...catList(true).filter((x) => !x.hidden || x.id === cid)
      .map((x) => Object.assign(document.createElement('option'), { value: x.id, textContent: `${x.icon} ${x.name}` })));
    if (!cid) $('ex-cat').prepend(Object.assign(document.createElement('option'), // generic add: pick it in the form
      { value: '', textContent: 'Scegli la categoria…', disabled: true }));
    $('ex-cat').value = cid || '';
    $('ex-amount').value = e ? (e.amount_cents / 100).toFixed(2).replace('.', ',') : '';
    $('ex-note').value = e ? e.note || '' : '';
    let day = isoDay(new Date());
    if (!e && !isCurrentPeriod()) day = isoDay(moMode === 'year' ? new Date(moAt.getFullYear(), 11, 31) // a past period: its last day
      : new Date(moAt.getFullYear(), moAt.getMonth() + 1, 0));
    $('ex-date').value = e ? e.spent_on : day;
    $('ex-delete').hidden = !e;
    $('ex-err').hidden = true;
    $('ex-dlg').showModal();
    if (!e) setTimeout(() => $('ex-amount').focus(), 50);
  }
  const parseCents = (s) => {
    const v = Number(String(s).trim().replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  };
  $('ex-form').addEventListener('submit', (ev) => {
    if (!ev.submitter || ev.submitter.value !== 'save') { exEditing = null; return; }
    const cents = parseCents($('ex-amount').value);
    if (!(cents > 0) || cents > 100000000) { ev.preventDefault(); $('ex-err').hidden = false; $('ex-amount').focus(); return; }
    const f = { category_id: $('ex-cat').value, amount_cents: cents,
      note: $('ex-note').value.trim().replace(/\s+/g, ' ') || null, spent_on: $('ex-date').value || isoDay(new Date()) };
    const old = exEditing && expenses.get(exEditing);
    if (old) {
      const diff = {};
      for (const k of Object.keys(f)) if (f[k] !== (old[k] ?? null)) diff[k] = f[k];
      if (Object.keys(diff).length) setFields(old.id, diff, EXP);
    } else {
      const row = { id: crypto.randomUUID(), family_id: me.family_id, ...f, created_by: me.display_name,
        created_at: new Date().toISOString() };
      expenses.set(row.id, row);
      queue.push({ op: 'add', t: EXP, id: row.id, row });
      commit();
    }
    exEditing = null;
  });
  $('ex-delete').addEventListener('click', () => {
    const e = expenses.get(exEditing);
    if (!e || !confirm(`Eliminare la spesa di ${money(e.amount_cents)}?`)) return;
    expenses.delete(e.id);
    queue.push({ op: 'del', t: EXP, id: e.id });
    exEditing = null;
    $('ex-dlg').close('cancel');
    commit();
  });
  $('mo-add').addEventListener('click', () => openExpense(null));
  $('mo-ring').addEventListener('click', (e) => {
    const b = e.target.closest('.ring-icon');
    if (b) openExpense(b.dataset.cat);
  });

  // one category's expenses in the period (CO-05)
  let detailCat = null;
  function renderCatDetail() {
    const c = cats.get(detailCat);
    if (!c) { $('cat-dlg').close(); return; }
    const list = inPeriod().filter((e) => e.category_id === c.id)
      .sort((a, b) => b.spent_on.localeCompare(a.spent_on) || (b.created_at || '').localeCompare(a.created_at || ''));
    const tot = list.reduce((a, e) => a + e.amount_cents, 0);
    $('cd-title').textContent = `${c.icon} ${c.name} · ${money(tot)}`;
    $('cd-list').replaceChildren(...list.map((e) => {
      const li2 = document.createElement('li');
      li2.className = 'item ex-row';
      li2.dataset.id = e.id;
      li2.innerHTML = '<span class="ex-day"></span><span class="name"></span><span class="mo-amt"></span>';
      li2.querySelector('.ex-day').textContent = new Date(e.spent_on + 'T12:00')
        .toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
      li2.querySelector('.name').textContent = e.note || '—';
      li2.querySelector('.mo-amt').textContent = money(e.amount_cents);
      return li2;
    }));
    $('cd-empty').hidden = list.length > 0;
  }
  $('mo-list').addEventListener('click', (e) => {
    const r = e.target.closest('.mo-row');
    if (!r) return;
    detailCat = r.dataset.cat;
    renderCatDetail();
    $('cat-dlg').showModal();
  });
  $('cd-list').addEventListener('click', (e) => {
    const r = e.target.closest('.ex-row');
    if (r) openExpense(null, r.dataset.id);
  });
  $('cd-add').addEventListener('click', () => openExpense(detailCat));

  // categories (CO-07)
  function renderCats() {
    const used = new Set([...expenses.values()].map((e) => e.category_id));
    const list = catList(true);
    $('cats-list').replaceChildren(...list.map((c, i) => {
      const li2 = document.createElement('li');
      li2.dataset.id = c.id;
      li2.className = c.hidden ? 'off' : '';
      li2.innerHTML = '<button type="button" class="ci" aria-label="Cambia icona"></button>'
        + '<input class="cn" aria-label="Nome"><input type="color" class="cc" aria-label="Colore">'
        + '<button type="button" class="ghost mv" data-d="-1" aria-label="Su">↑</button>'
        + '<button type="button" class="ghost mv" data-d="1" aria-label="Giù">↓</button>'
        + '<button type="button" class="ghost hd"></button>';
      li2.querySelector('.ci').textContent = c.icon;
      li2.querySelector('.ci').style.borderColor = c.color;
      li2.querySelector('.cn').value = c.name;
      li2.querySelector('.cc').value = c.color;
      li2.querySelector('[data-d="-1"]').disabled = i === 0;
      li2.querySelector('[data-d="1"]').disabled = i === list.length - 1;
      const hd = li2.querySelector('.hd');
      if (used.has(c.id)) { hd.textContent = c.hidden ? 'Mostra' : 'Nascondi'; hd.dataset.act = 'hide'; }
      else { hd.textContent = 'Elimina'; hd.dataset.act = 'del'; hd.classList.add('danger'); }
      return li2;
    }));
  }
  $('mo-cats').addEventListener('click', () => { renderCats(); $('cats-dlg').showModal(); });
  $('cats-list').addEventListener('click', (e) => {
    const li2 = e.target.closest('li');
    const c = li2 && cats.get(li2.dataset.id);
    if (!c) return;
    if (e.target.closest('.ci')) {
      const v = prompt(`Icona per "${c.name}" (un'emoji):`, c.icon);
      if (v && v.trim() && v.trim() !== c.icon) setFields(c.id, { icon: [...v.trim()].slice(0, 4).join('') }, CATS);
    } else if (e.target.closest('.mv')) {
      const list = catList(true), i = list.indexOf(c), j = i + Number(e.target.closest('.mv').dataset.d);
      if (j < 0 || j >= list.length) return;
      list.forEach((x, k) => { if (x.position !== k + 1) setFields(x.id, { position: k + 1 }, CATS); }); // tidy 1..n
      const o = list[j];
      setFields(c.id, { position: j + 1 }, CATS);
      setFields(o.id, { position: i + 1 }, CATS);
    } else if (e.target.closest('.hd')) {
      if (e.target.closest('.hd').dataset.act === 'hide') setFields(c.id, { hidden: !c.hidden }, CATS);
      else if (confirm(`Eliminare la categoria "${c.name}"?`)) {
        cats.delete(c.id);
        queue.push({ op: 'del', t: CATS, id: c.id });
        commit();
      }
    } else return;
    renderCats();
  });
  $('cats-list').addEventListener('change', (e) => {
    const li2 = e.target.closest('li');
    const c = li2 && cats.get(li2.dataset.id);
    if (!c) return;
    if (e.target.classList.contains('cn')) {
      const v = e.target.value.trim().replace(/\s+/g, ' ');
      if (v && v !== c.name) setFields(c.id, { name: v }, CATS); else e.target.value = c.name;
    } else if (e.target.classList.contains('cc') && /^#[0-9a-f]{6}$/i.test(e.target.value)) {
      setFields(c.id, { color: e.target.value }, CATS);
      renderCats();
    }
  });
  $('cats-add').addEventListener('click', () => {
    const name = (prompt('Nome della nuova categoria:') || '').trim().replace(/\s+/g, ' ');
    if (!name) return;
    const list = catList(true);
    const row = { id: crypto.randomUUID(), family_id: me.family_id, name, icon: '💶',
      color: PALETTE[list.length % PALETTE.length], position: (list.length ? Math.max(...list.map((x) => x.position)) : 0) + 1,
      hidden: false };
    cats.set(row.id, row);
    queue.push({ op: 'add', t: CATS, id: row.id, row });
    commit();
    renderCats();
  });

  // export for Excel (CO-08): semicolons and decimal commas, as Italian Excel expects
  $('mo-export').addEventListener('click', () => {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [['Data', 'Categoria', 'Importo', 'Nota', 'Inserita da'].join(';')];
    for (const e of [...expenses.values()].sort((a, b) => a.spent_on.localeCompare(b.spent_on))) {
      const c = cats.get(e.category_id);
      const [y, m, d] = e.spent_on.split('-');
      lines.push([`${d}/${m}/${y}`, q(c ? c.name : '?'), (e.amount_cents / 100).toFixed(2).replace('.', ','),
        q(e.note), q(e.created_by)].join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'),
      { href: URL.createObjectURL(blob), download: `spese-familyapp-${isoDay(new Date())}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // ---------- family calendar (CA-01…CA-09) ----------
  const DAY = 86400000;
  const dn = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; }; // day number
  const nd = (n) => new Date(n * DAY).toISOString().slice(0, 10);                                      // back to "AAAA-MM-GG"
  const lastOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const WHO_COLORS = ['#d65db1', '#3b7dd8'];
  const whoColor = (w) => (w === 'both' ? 'var(--accent)' : !w ? 'var(--muted)'
    : WHO_COLORS[Math.max(0, members.findIndex((m) => m.email === w)) % WHO_COLORS.length]);
  let caMode = 'agenda', caAt = new Date(), caSel = null, caDays = 60, evEditing = null;
  caAt = new Date(caAt.getFullYear(), caAt.getMonth(), 1);
  try { if (localStorage.getItem('fa.caMode') === 'month') caMode = 'month'; } catch (e) {}

  function starts(ev, from, to) { // CA-06: start days of the occurrences that touch [from, to] (day numbers)
    const d0 = dn(ev.day), len = ev.until ? dn(ev.until) - d0 : 0, out = [];
    const lo = from - len;
    if (ev.repeat === 'week') {
      for (let n = d0 + Math.max(0, Math.ceil((lo - d0) / 7)) * 7; n <= to; n += 7) out.push(n);
    } else if (ev.repeat === 'month' || ev.repeat === 'year') {
      const [y0, m0, dd] = ev.day.split('-').map(Number);
      const a = new Date(lo * DAY), step = ev.repeat === 'year' ? 12 : 1;
      let k = Math.max(0, Math.floor(((a.getUTCFullYear() - y0) * 12 + a.getUTCMonth() - (m0 - 1)) / step));
      for (;; k++) {
        const t = new Date(Date.UTC(y0, m0 - 1 + k * step, 1)), y = t.getUTCFullYear(), m = t.getUTCMonth();
        const n = Date.UTC(y, m, Math.min(dd, lastOfMonth(y, m))) / DAY;
        if (n > to) break;
        if (n >= lo) out.push(n);
      }
    } else if (d0 <= to && d0 >= lo) out.push(d0);
    return out.map((n) => [n, len]);
  }
  function entries(from, to) { // day number -> [{ ev | t, part }]
    const map = new Map(), put = (n, x) => { if (!map.has(n)) map.set(n, []); map.get(n).push(x); };
    for (const ev of events.values())
      for (const [s, len] of starts(ev, from, to))
        for (let n = Math.max(s, from); n <= Math.min(s + len, to); n++)
          put(n, { ev, part: len ? `${n - s + 1}/${len + 1}` : '' });
    const t0 = dn(today());
    for (const t of tasks.values()) { // CA-08: open to-dos with a date (in the agenda, late ones on today)
      if (t.done || !t.due) continue;
      const n = caMode === 'agenda' ? Math.max(dn(t.due), t0) : dn(t.due);
      if (n >= from && n <= to) put(n, { t, late: dn(t.due) < t0 });
    }
    for (const list of map.values()) list.sort((a, b) => (a.t ? 1 : 0) - (b.t ? 1 : 0) ||
      (a.ev ? a.ev.title : a.t.title).localeCompare(b.ev ? b.ev.title : b.t.title));
    return map;
  }
  function dayTitle(n) {
    const t0 = dn(today()), d = new Date(n * DAY);
    const s = `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}` +
      (d.getUTCFullYear() !== new Date().getFullYear() ? ` ${d.getUTCFullYear()}` : '');
    return n === t0 ? `Oggi · ${s}` : n === t0 + 1 ? `Domani · ${s}` : cap(s);
  }
  function entryLi(x) {
    const el = document.createElement('li');
    const bar = document.createElement('span');
    bar.className = 'ev-bar';
    const title = document.createElement('span');
    title.className = 'title';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const who = x.ev ? x.ev.who : x.t.assignee;
    bar.style.background = whoColor(who);
    if (x.ev) {
      el.className = 'item ev';
      el.dataset.ev = x.ev.id;
      title.textContent = x.ev.title;
      meta.textContent = [x.part, x.ev.repeat !== 'none' ? '🔁' : '', x.ev.remind !== 'none' ? '🔔' : ''].filter(Boolean).join(' ');
    } else {
      el.className = 'item task cal-task';
      el.dataset.id = x.t.id;
      title.textContent = '✓ ' + x.t.title;
      if (x.late) {
        const l = document.createElement('span');
        l.className = 'due late';
        l.textContent = dueLabel(x.t.due);
        meta.append(l);
      }
    }
    if (who) {
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = whoShort(who);
      w.title = whoLong(who);
      meta.append(w);
    }
    el.append(bar, title, meta);
    return el;
  }
  function dayBlocks(map, from, to) {
    const out = [];
    for (let n = from; n <= to; n++) {
      const list = map.get(n);
      if (!list) continue;
      const h = document.createElement('h3');
      h.className = 'day-h' + (n === dn(today()) ? ' today' : '');
      h.textContent = dayTitle(n);
      const ul = document.createElement('ul');
      ul.className = 'items cal-items';
      ul.append(...list.map(entryLi));
      out.push(h, ul);
    }
    return out;
  }

  function renderCal() { // CA-01…CA-03
    if (!me) return;
    for (const b of $('ca-mode').children) b.classList.toggle('on', b.dataset.v === caMode);
    const month = caMode === 'month';
    $('ca-prev').hidden = $('ca-next').hidden = !month;
    $('ca-grid').hidden = !month;
    $('ca-more').hidden = month;
    let blocks, empty, add = '+ Aggiungi evento';
    if (month) {
      const y = caAt.getFullYear(), m = caAt.getMonth();
      const from = Date.UTC(y, m, 1) / DAY, to = Date.UTC(y, m, lastOfMonth(y, m)) / DAY;
      $('ca-label').textContent = cap(caAt.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }));
      const map = entries(from, to), t0 = dn(today()), cells = [];
      for (const l of ['L', 'M', 'M', 'G', 'V', 'S', 'D']) {
        const h = document.createElement('span');
        h.className = 'wd';
        h.textContent = l;
        cells.push(h);
      }
      for (let i = 0; i < (new Date(from * DAY).getUTCDay() + 6) % 7; i++) cells.push(document.createElement('span'));
      for (let n = from; n <= to; n++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cal-day' + (n === t0 ? ' today' : '') + (caSel === nd(n) ? ' sel' : '');
        b.dataset.day = nd(n);
        const num = document.createElement('span');
        num.textContent = new Date(n * DAY).getUTCDate();
        const dots = document.createElement('span');
        dots.className = 'dots';
        for (const x of (map.get(n) || []).slice(0, 4)) {
          const d = document.createElement('i');
          d.style.background = whoColor(x.ev ? x.ev.who : x.t.assignee);
          if (x.t) d.className = 'light';
          dots.append(d);
        }
        b.append(num, dots);
        cells.push(b);
      }
      $('ca-grid').replaceChildren(...cells);
      const s = caSel && dn(caSel) >= from && dn(caSel) <= to ? dn(caSel) : null;
      blocks = s === null ? dayBlocks(map, from, to) : dayBlocks(map, s, s);
      empty = s === null ? 'Niente in questo mese.' : 'Niente in questo giorno.';
      if (s !== null) add = `+ Aggiungi il ${new Date(s * DAY).getUTCDate()}`;
    } else {
      const from = dn(today()), to = from + caDays;
      $('ca-label').textContent = 'Prossimi giorni';
      blocks = dayBlocks(entries(from, to), from, to);
      empty = 'Niente in programma.';
    }
    $('ca-list').replaceChildren(...blocks);
    $('ca-empty').hidden = blocks.length > 0;
    $('ca-empty').textContent = empty;
    $('ca-add').textContent = add;
  }
  $('ca-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    caMode = b.dataset.v;
    try { localStorage.setItem('fa.caMode', caMode); } catch (err) {}
    renderCal();
  });
  $('ca-prev').addEventListener('click', () => { caAt = new Date(caAt.getFullYear(), caAt.getMonth() - 1, 1); caSel = null; renderCal(); });
  $('ca-next').addEventListener('click', () => { caAt = new Date(caAt.getFullYear(), caAt.getMonth() + 1, 1); caSel = null; renderCal(); });
  $('ca-more').addEventListener('click', () => { caDays += 60; renderCal(); });
  $('ca-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.cal-day');
    if (!b) return;
    caSel = caSel === b.dataset.day ? null : b.dataset.day;
    renderCal();
  });
  $('ca-add').addEventListener('click', () => openEvent(null, caMode === 'month' && caSel ? caSel : null));
  $('ca-list').addEventListener('click', (e) => {
    const el = e.target.closest('.ev');
    if (el) openEvent(el.dataset.ev);
  });
  function showDay(day) { // opened from a reminder: that day in the month view
    caMode = 'month';
    caSel = day;
    const d = parseDay(day);
    caAt = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCal();
  }

  function openEvent(id, day) { // CA-04, CA-05
    const ev = id && events.get(id);
    evEditing = ev ? ev.id : null;
    $('ev-h').textContent = ev ? 'Modifica evento' : 'Nuovo evento';
    $('ev-title').value = ev ? ev.title : '';
    $('ev-day').value = ev ? ev.day : day || today();
    $('ev-until').value = ev ? ev.until || '' : '';
    const sel = $('ev-who');
    sel.replaceChildren(...[...members.map((m) => [m.email, m.display_name]), ['both', 'Tutti e due']]
      .map(([v, l]) => Object.assign(document.createElement('option'), { value: v, textContent: l })));
    sel.value = ev ? ev.who : 'both';
    $('ev-repeat').value = ev ? ev.repeat : 'none';
    $('ev-remind').value = ev ? ev.remind : 'none';
    $('ev-series').hidden = !(ev && ev.repeat !== 'none');
    $('ev-delete').hidden = !ev;
    $('ev-err').hidden = true;
    $('ev-dlg').showModal();
    if (!ev) setTimeout(() => $('ev-title').focus(), 50);
  }
  $('ev-form').addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'save') { evEditing = null; return; }
    const f = { title: $('ev-title').value.trim().replace(/\s+/g, ' '), day: $('ev-day').value,
      until: $('ev-until').value || null, who: $('ev-who').value || 'both',
      repeat: $('ev-repeat').value, remind: $('ev-remind').value };
    if (f.until === f.day) f.until = null;
    if (!f.title || !f.day || (f.until && f.until < f.day)) {
      e.preventDefault();
      $('ev-err').textContent = !f.title ? 'Scrivi un titolo.' : '"Fino al" deve venire dopo il giorno.';
      $('ev-err').hidden = false;
      return;
    }
    const old = evEditing && events.get(evEditing);
    if (old) {
      const diff = {};
      for (const k of Object.keys(f)) if (f[k] !== (old[k] ?? null)) diff[k] = f[k];
      if (Object.keys(diff).length) setFields(old.id, diff, EVT);
    } else {
      const row = { id: crypto.randomUUID(), family_id: me.family_id, ...f, created_by: me.display_name,
        created_at: new Date().toISOString() };
      events.set(row.id, row);
      queue.push({ op: 'add', t: EVT, id: row.id, row: { ...row } });
      commit();
    }
    evEditing = null;
  });
  $('ev-delete').addEventListener('click', () => {
    const ev = events.get(evEditing);
    if (!ev || !confirm(ev.repeat !== 'none' ? `Eliminare "${ev.title}" e tutte le sue ripetizioni?` : `Eliminare "${ev.title}"?`)) return;
    events.delete(ev.id);
    queue.push({ op: 'del', t: EVT, id: ev.id });
    evEditing = null;
    $('ev-dlg').close('cancel');
    commit();
  });

  // ---------- notifications (NT-01…NT-06) ----------
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const NT_DEFAULT = { shop: 'none', todo: 'mine', morning: true, cal: true };
  const TABS = ['list', 'todo', 'cal', 'money'];
  const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
    (c) => c.charCodeAt(0));
  const permission = () => (pushOk ? Notification.permission : 'unsupported');
  const notifyPrefs = () => ({ ...NT_DEFAULT, ...((me && me.notify) || {}) });
  let view = null;

  async function pushRegister(ask) { // registers this phone for my account; true when it worked
    if (!pushOk) return false;
    if (Notification.permission === 'default' && ask) await Notification.requestPermission();
    if (Notification.permission !== 'granted') return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { data: key, error } = await sb.rpc('push_public_key');
        if (error || !key) throw error || new Error('no key');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
      }
      const j = sub.toJSON();
      const { error } = await sb.rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
      if (error) throw error;
      return true;
    } catch (e) { console.warn('push', e); return false; }
  }
  async function pushForget() { // logout: this phone stops receiving this account's notifications
    try {
      const reg = pushOk && await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await sb.rpc('push_unsubscribe', { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
    } catch (e) {}
  }

  function renderInvite() { // NT-01
    let no = false;
    try { no = localStorage.getItem('fa.ntInvite') === 'no'; } catch (e) {}
    $('nt-invite').hidden = !(permission() === 'default' && !no && TABS.includes(view));
  }
  $('nt-invite-yes').addEventListener('click', async () => {
    const ok = await pushRegister(true);
    renderInvite();
    if (ok) openSettings();
  });
  $('nt-invite-no').addEventListener('click', () => {
    try { localStorage.setItem('fa.ntInvite', 'no'); } catch (e) {}
    renderInvite();
  });

  function renderSettings() { // NT-02
    const p = notifyPrefs(), perm = permission();
    for (const seg of document.querySelectorAll('#settings .seg'))
      for (const b of seg.children) b.classList.toggle('on', b.dataset.v === p[seg.dataset.key]);
    $('nt-morning').checked = !!p.morning;
    $('nt-cal').checked = p.cal !== false;
    $('nt-status').textContent = {
      granted: 'Attive su questo telefono. Scegli cosa ricevere:',
      default: 'Non ancora attive su questo telefono.',
      denied: "Bloccate su questo telefono. Per sbloccarle: tieni premuta l'icona dell'app → Informazioni app → Notifiche.",
      unsupported: 'Questo browser non supporta le notifiche.',
    }[perm];
    $('nt-enable').hidden = perm !== 'default';
    $('nt-levels').classList.toggle('off', perm !== 'granted');
    $('nt-test').hidden = perm !== 'granted';
  }
  function openSettings() {
    $('nt-hint').textContent = '';
    $('st-update-hint').textContent = '';
    $('st-notify').hidden = $('st-money').hidden = !me; // "denied" view: only account and app
    $('st-who').textContent = me ? `${me.display_name} · ${me.email}` : (authEmail || '');
    const v = window.FA_VERSION;
    $('st-version').textContent = v && v !== 'sviluppo' ? `Versione del ${v}` : 'Versione di sviluppo (PC)';
    if (me) renderSettings();
    if (!$('settings').open) $('settings').showModal();
  }
  async function saveNotify(patch) {
    const before = me.notify;
    me.notify = { ...notifyPrefs(), ...patch };
    renderSettings();
    const { data, error } = await sb.rpc('set_notify', { p: patch });
    if (error) { me.notify = before; renderSettings(); }
    else { me.notify = data; try { localStorage.setItem('fa.me.' + me.email, JSON.stringify(me)); } catch (e) {} }
    $('nt-hint').textContent = error ? 'Non salvato: serve la connessione. Riprova.' : 'Salvato.';
  }
  $('settings-btn').addEventListener('click', openSettings);
  $('st-update').addEventListener('click', async () => { // fetch the latest published app and restart it
    $('st-update-hint').textContent = 'Controllo…';
    try {
      const r = await fetch('config.js?ts=' + Date.now(), { cache: 'no-store' });
      const v = ((await r.text()).match(/FA_VERSION = "([^"]*)"/) || [])[1];
      if (v && v !== window.FA_VERSION) {
        $('st-update-hint').textContent = `Nuova versione (${v}): la carico…`;
        const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
        setTimeout(() => location.reload(), 600);
      } else $('st-update-hint').textContent = 'Hai già la versione più recente.';
    } catch (e) { $('st-update-hint').textContent = 'Serve la connessione per controllare.'; }
  });
  $('nt-enable').addEventListener('click', async () => {
    const ok = await pushRegister(true);
    renderSettings(); renderInvite();
    if (!ok && permission() === 'granted') $('nt-hint').textContent = 'Non riuscito: serve la connessione. Riprova.';
  });
  $('settings').addEventListener('click', (e) => {
    const b = e.target.closest('.seg button');
    if (b) saveNotify({ [b.parentElement.dataset.key]: b.dataset.v });
  });
  $('nt-morning').addEventListener('change', (e) => saveNotify({ morning: e.target.checked }));
  $('nt-cal').addEventListener('change', (e) => saveNotify({ cal: e.target.checked }));
  $('nt-test').addEventListener('click', async () => {
    await pushRegister(false);
    const { error } = await sb.rpc('push_test');
    $('nt-hint').textContent = error ? 'Non inviata: serve la connessione.' : 'Inviata: arriva tra pochi secondi.';
  });
  if (pushOk) navigator.serviceWorker.addEventListener('message', (e) => { // NT-06, app already open
    const tab = e.data && e.data.tab;
    if (me && TABS.includes(tab)) { show(tab); try { localStorage.setItem('fa.tab', tab); } catch (err) {} }
    if (me && tab === 'cal' && /^\d{4}-\d\d-\d\d$/.test(e.data.day || '')) showDay(e.data.day);
  });

  // ---------- start (SP-01) ----------
  function show(v) {
    view = v;
    for (const s of ['login', 'denied', ...TABS]) $(s).hidden = s !== v;
    $('flyers-btn').hidden = v !== 'list';
    $('settings-btn').hidden = v === 'login';
    renderInvite();
    $('tabs').hidden = !TABS.includes(view);
    document.body.classList.toggle('has-tabs', !$('tabs').hidden);
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === view);
  }

  async function membership(email) {
    const cacheKey = 'fa.me.' + email;
    const { data, error } = await sb.from('members').select('email,family_id,display_name,tagline,notify').eq('email', email);
    if (!error) {
      const row = data[0] || null;
      if (row) localStorage.setItem(cacheKey, JSON.stringify(row)); else localStorage.removeItem(cacheKey);
      return row;
    }
    setOnline(false);
    return JSON.parse(localStorage.getItem(cacheKey) || 'null'); // offline: trust last known
  }

  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { show('login'); return; }
    const email = (session.user.email || '').toLowerCase();
    authEmail = email;
    me = await membership(email);
    if (!me) { show('denied'); return; }
    $('tagline').textContent = me.tagline || ''; // personal line, only for that member
    $('tagline').hidden = !me.tagline;
    loadLocal();
    let tab = 'list';
    try { const saved = localStorage.getItem('fa.tab'); tab = TABS.includes(saved) ? saved : 'list'; } catch (e) {}
    const qs = new URLSearchParams(location.search), asked = qs.get('tab'); // NT-06: opened from a notification
    if (TABS.includes(asked)) {
      tab = asked;
      if (asked === 'cal' && /^\d{4}-\d\d-\d\d$/.test(qs.get('day') || '')) showDay(qs.get('day'));
      try { localStorage.setItem('fa.tab', tab); } catch (e) {}
      history.replaceState(null, '', location.pathname);
    }
    show(tab); // TD-01: last tab used
    render();
    subscribe();
    flush();
    fetchAll();
    pushRegister(false); // keeps this phone registered (the address can change over time)
  }

  window.FA = { items: () => [...items.values()], tasks: () => [...tasks.values()], events: () => [...events.values()], queue: () => queue, flush, fetchAll };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  start();
})();
