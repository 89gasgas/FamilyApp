-- FamilyApp: SP-08 non-urgent products ("se in offerta"). Idempotent.

alter table public.shopping_items add column if not exists optional boolean not null default false;

-- Names written as "(Name)" become optional, without parentheses.
update public.shopping_items
set name = trim(substring(name from 2 for length(name) - 2)), optional = true
where name ~ '^\(.*\)$';

-- add_item gains p_optional ("Olive?" from the client). The old 3-argument version is dropped
-- so calls are not ambiguous; queued offline adds without p_optional still work via the default.
drop function if exists public.add_item(uuid, text, double precision);
create or replace function public.add_item(p_id uuid, p_name text, p_position double precision,
                                           p_optional boolean default false)
returns public.shopping_items
language plpgsql security invoker set search_path = public as $$
declare
  fam uuid := public.my_family();
  r public.shopping_items;
begin
  if fam is null then raise exception 'not a family member'; end if;
  insert into public.shopping_items (id, family_id, name, position, added_by, optional)
  values (p_id, fam, trim(p_name), p_position, public.my_name(), p_optional)
  on conflict (family_id, name_key) do update
    set bought = false, bought_by = null, bought_at = null, updated_at = now(),
        optional = shopping_items.optional or excluded.optional
  returning * into r;
  return r;
end $$;

select count(*) filter (where optional) as se_in_offerta,
       count(*) filter (where optional and not bought) as se_in_offerta_da_comprare,
       count(*) filter (where name ~ '[()]') as nomi_con_parentesi
from public.shopping_items;
