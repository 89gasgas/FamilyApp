/* FamilyApp: shared shopping list (SP-01…SP-09) and to-dos (TD-01…TD-07). */
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
  let items = new Map();    // id -> shopping item
  let tasks = new Map();    // id -> task (TD)
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
      localStorage.setItem(storeKey(), JSON.stringify({ items: [...items.values()], tasks: [...tasks.values()], members, queue }));
    } catch (e) {}
  }
  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey()) || 'null');
      if (raw) {
        items = new Map(raw.items.map((i) => [i.id, i]));
        tasks = new Map((raw.tasks || []).map((i) => [i.id, i]));
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
  const SHOP = 'shopping_items', TASKS = 'tasks';
  const tableOf = (op) => op.t || SHOP; // ops saved before TD have no table: shopping
  const mapOf = (t) => (t === TASKS ? tasks : items);
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

  async function fetchAll() {
    const [a, b, m] = await Promise.all([
      sb.from(SHOP).select('*').eq('family_id', me.family_id),
      sb.from(TASKS).select('*').eq('family_id', me.family_id),
      sb.from('members').select('email,display_name').eq('family_id', me.family_id),
    ]);
    const error = a.error || b.error || m.error;
    if (error) { if (isNetErr(error)) setOnline(false); return; }
    items = applyPending(new Map(a.data.map((i) => [i.id, i])), SHOP);
    tasks = applyPending(new Map(b.data.map((i) => [i.id, i])), TASKS);
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
          if (tableOf(op) === TASKS) {
            if (op.op === 'add') res = await sb.from(TASKS).upsert(op.row, { onConflict: 'id', ignoreDuplicates: true });
            else if (op.op === 'del') res = await sb.from(TASKS).delete().eq('id', op.id);
            else res = await sb.from(TASKS).update(op.fields).eq('id', op.id);
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
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: TASKS, filter: 'family_id=eq.' + me.family_id },
        (p) => { // TD-03 real time
          const id = (p.new && p.new.id) || (p.old && p.old.id);
          if (queue.some((q) => q.id === id)) return;
          if (p.eventType === 'DELETE') tasks.delete(id); else tasks.set(id, p.new);
          save(); render();
        })
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
  $('logout-btn').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
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

  // ---------- start (SP-01) ----------
  function show(view) {
    for (const v of ['login', 'denied', 'list', 'todo']) $(v).hidden = v !== view;
    $('flyers-btn').hidden = view !== 'list';
    $('logout-btn').hidden = view === 'login';
    $('tabs').hidden = !['list', 'todo'].includes(view);
    document.body.classList.toggle('has-tabs', !$('tabs').hidden);
    $('title').textContent = view === 'todo' ? 'Da fare' : 'Spesa';
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === view);
  }

  async function membership(email) {
    const cacheKey = 'fa.me.' + email;
    const { data, error } = await sb.from('members').select('email,family_id,display_name').eq('email', email);
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
    me = await membership(email);
    if (!me) { show('denied'); return; }
    loadLocal();
    let tab = 'list';
    try { tab = localStorage.getItem('fa.tab') === 'todo' ? 'todo' : 'list'; } catch (e) {}
    show(tab); // TD-01: last tab used
    render();
    subscribe();
    flush();
    fetchAll();
  }

  window.FA = { items: () => [...items.values()], tasks: () => [...tasks.values()], queue: () => queue, flush, fetchAll };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  start();
})();
