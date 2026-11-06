-- FamilyApp: increment 3, notifications (NT-01…NT-06). Idempotent.
-- Flow: a trigger decides who to tell and writes a job in private.push_jobs, then pg_net
-- pings the edge function "push" with only the job id; the function takes the job
-- (push_take), encrypts and sends Web Push, and reports dead phones (push_done).
-- VAPID keys and the function URL live in private.config (scripts/setup-push.py).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- NT-02: per-person levels. shop: none|urgent|all, todo: none|mine|all, morning: bool
alter table public.members add column if not exists notify jsonb not null
  default '{"shop":"none","todo":"mine","morning":true}';

create table if not exists private.push_subs (
  endpoint text primary key,
  email text not null references public.members(email) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create table if not exists private.push_jobs (
  id uuid primary key default gen_random_uuid(),
  items jsonb not null,            -- [{email, payload}]
  created_at timestamptz not null default now(),
  taken_at timestamptz
);
create table if not exists private.push_burst (   -- NT-03: one growing notification per sender
  email text, actor text, names text[] not null, last_at timestamptz not null,
  primary key (email, actor)
);

create or replace function private.me() returns text language sql stable as $$
  select lower(nullif(auth.jwt() ->> 'email', ''))
$$;

-- ---------- called by the app ----------
create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = public as $$
  select value from private.config where key = 'vapid_public'
$$;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_family() is null then raise exception 'not a family member'; end if;
  insert into private.push_subs (endpoint, email, p256dh, auth)
  values (p_endpoint, private.me(), p_p256dh, p_auth)
  on conflict (endpoint) do update set email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from private.push_subs where endpoint = p_endpoint and email = private.me()
$$;

create or replace function public.set_notify(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if (p ? 'shop' and p->>'shop' not in ('none','urgent','all'))
     or (p ? 'todo' and p->>'todo' not in ('none','mine','all'))
     or (p ? 'morning' and jsonb_typeof(p->'morning') <> 'boolean') then
    raise exception 'bad value';
  end if;
  update public.members set notify = notify || jsonb_strip_nulls(jsonb_build_object(
    'shop', p->'shop', 'todo', p->'todo', 'morning', p->'morning'))
  where email = private.me() returning notify into r;
  return r;
end $$;

-- ---------- queue a notification ----------
create or replace function private.push_enqueue(p_items jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare jid uuid; url text;
begin
  -- keep only people with at least one phone registered
  select coalesce(jsonb_agg(i), '[]') into p_items from jsonb_array_elements(p_items) i
  where exists (select 1 from private.push_subs s where s.email = i->>'email');
  if jsonb_array_length(p_items) = 0 then return; end if;
  select value into url from private.config where key = 'push_url';
  if url is null then return; end if;
  insert into private.push_jobs (items) values (p_items) returning id into jid;
  perform net.http_post(url := url, body := jsonb_build_object('job', jid),
                        headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 8000);
end $$;

create or replace function public.push_test() returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_family() is null then raise exception 'not a family member'; end if;
  perform private.push_enqueue(jsonb_build_array(jsonb_build_object('email', private.me(), 'payload',
    jsonb_build_object('title', '🔔 Notifica di prova', 'body', 'Funziona! Le notifiche arrivano su questo telefono.',
                       'tag', 'test', 'url', './'))));
end $$;

-- ---------- called by the edge function (anon key; the job id is the secret) ----------
create or replace function public.push_take(p_job uuid) returns json
language plpgsql security definer set search_path = public as $$
declare j private.push_jobs;
begin
  update private.push_jobs set taken_at = now()
  where id = p_job and taken_at is null and created_at > now() - interval '10 minutes'
  returning * into j;
  if j.id is null then return null; end if;
  return json_build_object(
    'jwk', (select value from private.config where key = 'vapid_jwk')::json,
    'pub', (select value from private.config where key = 'vapid_public'),
    'sub', (select value from private.config where key = 'push_subject'),
    'messages', (select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh,
                                   'auth', s.auth, 'payload', i->'payload')), '[]')
                 from jsonb_array_elements(j.items) i join private.push_subs s on s.email = i->>'email'));
end $$;

create or replace function public.push_done(p_job uuid, p_gone text[]) returns void
language plpgsql security definer set search_path = public as $$
declare j private.push_jobs;
begin
  delete from private.push_jobs where id = p_job and taken_at is not null returning * into j;
  if j.id is null then return; end if;
  delete from private.push_subs s where s.endpoint = any(coalesce(p_gone, '{}'))
    and s.email in (select i->>'email' from jsonb_array_elements(j.items) i);
end $$;

revoke execute on function public.push_take(uuid), public.push_done(uuid, text[]) from public, authenticated;
grant execute on function public.push_take(uuid), public.push_done(uuid, text[]) to anon;
revoke execute on function public.push_public_key(), public.push_subscribe(text, text, text),
  public.push_unsubscribe(text), public.set_notify(jsonb), public.push_test() from public, anon;
grant execute on function public.push_public_key(), public.push_subscribe(text, text, text),
  public.push_unsubscribe(text), public.set_notify(jsonb), public.push_test() to authenticated;

-- ---------- NT-03: shopping ----------
create or replace function private.on_shop() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor text := private.me(); who text; r record; nm text[]; items jsonb := '[]';
begin
  if v_actor is null or new.bought then return null; end if;
  if tg_op = 'UPDATE' and not old.bought then return null; end if;     -- only new or re-added
  select display_name into who from public.members where email = v_actor;
  for r in select email, notify->>'shop' lvl from public.members
           where family_id = new.family_id and email <> v_actor loop
    continue when r.lvl = 'none' or (r.lvl = 'urgent' and new.optional);
    insert into private.push_burst as b (email, actor, names, last_at) values (r.email, v_actor, array[new.name], now())
    on conflict (email, actor) do update set
      names = case when b.last_at > now() - interval '15 minutes'
                   then array_append(array_remove(b.names, new.name), new.name) else array[new.name] end,
      last_at = now()
    returning b.names into nm;
    items := items || jsonb_build_object('email', r.email, 'payload', jsonb_build_object(
      'title', '🛒 Spesa', 'body', who || ' ha aggiunto: ' || array_to_string(nm, ', '),
      'tag', 'shop-' || v_actor, 'url', './?tab=list', 'quiet', cardinality(nm) > 1));
  end loop;
  perform private.push_enqueue(items);
  return null;
end $$;
drop trigger if exists shop_notify on public.shopping_items;
create trigger shop_notify after insert or update of bought on public.shopping_items
  for each row execute function private.on_shop();

-- ---------- NT-04: to-dos ----------
create or replace function private.due_label(d date) returns text language sql stable as $$
  select case when d is null then null
              when d = (now() at time zone 'Europe/Rome')::date then 'oggi'
              when d = (now() at time zone 'Europe/Rome')::date + 1 then 'domani'
              when d < (now() at time zone 'Europe/Rome')::date then 'scaduta il ' || to_char(d, 'DD/MM')
              else to_char(d, 'DD/MM') end
$$;

create or replace function private.on_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor text := private.me(); who text; r record; items jsonb := '[]'; body text; detail text; mine boolean; was boolean;
begin
  if actor is null then return null; end if;
  select display_name into who from public.members where email = actor;
  for r in select email, notify->>'todo' lvl from public.members
           where family_id = new.family_id and email <> actor loop
    continue when r.lvl = 'none';
    mine := new.assignee in (r.email, 'both');
    body := null;
    if tg_op = 'INSERT' and not new.done and (mine or r.lvl = 'all') then
      body := who || ': ' || new.title;
    elsif tg_op = 'UPDATE' then
      was := old.assignee in (r.email, 'both');
      if mine and not coalesce(was, false) and not new.done then
        body := who || ' ti ha assegnato: ' || new.title;
      elsif new.done and not old.done and r.lvl = 'all' then
        body := who || ' ha fatto: ' || new.title;
      end if;
    end if;
    continue when body is null;
    if not new.done then
      detail := concat_ws(' · ', case when new.assignee = r.email then 'per te'
                                      when new.assignee = 'both' then 'per tutti e due' end,
                          private.due_label(new.due));
      if detail <> '' then body := body || ' (' || detail || ')'; end if;
    end if;
    items := items || jsonb_build_object('email', r.email, 'payload', jsonb_build_object(
      'title', '✓ Da fare', 'body', body, 'tag', 'task-' || new.id, 'url', './?tab=todo'));
  end loop;
  perform private.push_enqueue(items);
  return null;
end $$;
drop trigger if exists task_notify on public.tasks;
create trigger task_notify after insert or update of assignee, done on public.tasks
  for each row execute function private.on_task();

-- ---------- NT-05: morning reminder at 08:00 Italian time ----------
create or replace function private.push_morning(p_force boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare r record; items jsonb := '[]'; today date := (now() at time zone 'Europe/Rome')::date;
begin
  delete from private.push_jobs where created_at < now() - interval '1 day';
  if not p_force and extract(hour from now() at time zone 'Europe/Rome') <> 8 then return 0; end if;
  for r in
    select m.email,
           string_agg(t.title, ', ' order by t.due, t.created_at) titles,
           count(*) filter (where t.due < today) late
    from public.members m join public.tasks t on t.family_id = m.family_id
    where (m.notify->>'morning')::boolean and not t.done and t.due <= today
      and (t.assignee is null or t.assignee in (m.email, 'both'))
    group by m.email
  loop
    items := items || jsonb_build_object('email', r.email, 'payload', jsonb_build_object(
      'title', '⏰ Da fare oggi',
      'body', r.titles || case when r.late = 1 then ' (1 scaduta)' when r.late > 1 then ' (' || r.late || ' scadute)' else '' end,
      'tag', 'morning', 'url', './?tab=todo'));
  end loop;
  perform private.push_enqueue(items);
  return jsonb_array_length(items);
end $$;

select cron.schedule('fa-morning', '0 * * * *', 'select private.push_morning()');

select 'ok' as result;
