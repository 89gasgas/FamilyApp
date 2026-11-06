-- FamilyApp: daily backup + keep-alive. Idempotent.
-- backup_export(key) returns all family data as JSON. It is callable with the public key but only works
-- with the backup key, whose SHA-256 is stored in private.config by scripts/setup-backup.py
-- (the key itself lives only in Segreti.txt and in the GitHub Actions secrets).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.config (key text primary key, value text not null);

create or replace function public.backup_export(p_key text) returns json
language plpgsql security definer set search_path = public as $$
begin
  if p_key is null or encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
       is distinct from (select value from private.config where key = 'backup_key_sha256') then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return json_build_object(
    'families', (select coalesce(json_agg(f order by f.id), '[]') from public.families f),
    'members', (select coalesce(json_agg(m order by m.email), '[]') from public.members m),
    'shopping_items', (select coalesce(json_agg(i order by i.family_id, i.position, i.id), '[]')
                       from public.shopping_items i));
end $$;

revoke execute on function public.backup_export(text) from public, anon, authenticated;
grant execute on function public.backup_export(text) to anon;

select 'ok' as result;
