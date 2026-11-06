/* FamilyApp: increment 1, shared shopping list (SP-01…SP-07). */
(() => {
  'use strict';
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
  let items = new Map();    // id -> item
  let queue = [];           // pending changes, replayed when online
  let channel = null;
  let flushing = false;
  let online = navigator.onLine;

  const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const storeKey = () => 'fa.state.' + me.email;

  // ---------- local persistence (SP-04 offline) ----------
  function save() {
    try { localStorage.setItem(storeKey(), JSON.stringify({ items: [...items.values()], queue })); } catch (e) {}
  }
  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey()) || 'null');
      if (raw) { items = new Map(raw.items.map((i) => [i.id, i])); queue = raw.queue || []; }
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
  function setFields(id, fields) {
    const it = items.get(id);
    if (!it) return;
    Object.assign(it, fields);
    const last = queue[queue.length - 1];
    if (last && last.op === 'set' && last.id === id) Object.assign(last.fields, fields);
    else queue.push({ op: 'set', id, fields: { ...fields } });
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

  function applyPending(map) {
    for (const op of queue) {
      if (op.op === 'add' && !map.has(op.id)) {
        const local = items.get(op.id);
        if (local) map.set(op.id, local);
      } else if (op.op === 'set' && map.has(op.id)) Object.assign(map.get(op.id), op.fields);
    }
    return map;
  }

  async function fetchAll() {
    const { data, error } = await sb.from('shopping_items').select('*').eq('family_id', me.family_id);
    if (error) { if (isNetErr(error)) setOnline(false); return; }
    items = applyPending(new Map(data.map((i) => [i.id, i])));
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
          if (op.op === 'add') {
            res = await sb.rpc('add_item', { p_id: op.id, p_name: op.name, p_position: op.position,
                                             p_optional: !!op.optional });
          } else {
            res = await sb.from('shopping_items').update(op.fields).eq('id', op.id).select();
          }
        } catch (e) { res = { error: e }; }
        if (res.error) {
          if (isNetErr(res.error)) { setOnline(false); break; }
          console.warn('change rejected', op, res.error);
          queue.shift();
          continue;
        }
        queue.shift();
        if (op.op === 'add') {
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

  // ---------- UI events ----------
  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addProduct($('add-input').value);
    $('add-input').value = '';
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

  // ---------- start (SP-01) ----------
  function show(view) {
    for (const v of ['login', 'denied', 'list']) $(v).hidden = v !== view;
    $('flyers-btn').hidden = view !== 'list';
    $('logout-btn').hidden = view === 'login';
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
    show('list');
    render();
    subscribe();
    flush();
    fetchAll();
  }

  window.FA = { items: () => [...items.values()], queue: () => queue, flush, fetchAll };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  start();
})();
