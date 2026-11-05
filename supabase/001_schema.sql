-- FamilyApp: increment 1 (shopping list). Idempotent.

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

-- Allowlist: only these emails see family data (SP-01).
create table if not exists public.members (
  email text primary key check (email = lower(email)),
  family_id uuid not null references public.families(id) on delete cascade,
  display_name text not null
);

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  name_key text generated always as (lower(regexp_replace(trim(name), '\s+', ' ', 'g'))) stored,
  quantity text,
  position double precision not null default 0,
  bought boolean not null default false,
  added_by text,
  added_at timestamptz not null default now(),
  bought_by text,
  bought_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (family_id, name_key)
);

create or replace function public.my_family() returns uuid
language sql stable security definer set search_path = public as $$
  select family_id from public.members
  where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.my_name() returns text
language sql stable security definer set search_path = public as $$
  select display_name from public.members
  where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

alter table public.families enable row level security;
alter table public.members enable row level security;
alter table public.shopping_items enable row level security;

drop policy if exists families_read on public.families;
create policy families_read on public.families for select to authenticated
  using (id = public.my_family());

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated
  using (family_id = public.my_family());

drop policy if exists items_all on public.shopping_items;
create policy items_all on public.shopping_items for all to authenticated
  using (family_id = public.my_family())
  with check (family_id = public.my_family());

-- Add or reactivate a product (SP-02 no duplicates, SP-05 reactivate).
-- p_id/p_position come from the client so offline adds replay safely.
create or replace function public.add_item(p_id uuid, p_name text, p_position double precision)
returns public.shopping_items
language plpgsql security invoker set search_path = public as $$
declare
  fam uuid := public.my_family();
  r public.shopping_items;
begin
  if fam is null then raise exception 'not a family member'; end if;
  insert into public.shopping_items (id, family_id, name, position, added_by)
  values (p_id, fam, trim(p_name), p_position, public.my_name())
  on conflict (family_id, name_key) do update
    set bought = false, bought_by = null, bought_at = null, updated_at = now()
  returning * into r;
  return r;
end $$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists items_touch on public.shopping_items;
create trigger items_touch before update on public.shopping_items
  for each row execute function public.touch_updated_at();

-- Realtime (SP-03).
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'shopping_items') then
    alter publication supabase_realtime add table public.shopping_items;
  end if;
end $$;
alter table public.shopping_items replica identity full;

select 'ok' as result;
