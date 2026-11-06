-- FamilyApp: real family (GaS and Chips). Idempotent.
do $$
declare fam uuid;
begin
  select family_id into fam from public.members where email = '89gasgas@gmail.com';
  if fam is null then
    insert into public.families (name) values ('Famiglia') returning id into fam;
  end if;
  insert into public.members (email, family_id, display_name) values
    ('89gasgas@gmail.com', fam, 'GaS'),
    ('valesposito818@gmail.com', fam, 'Chips')
  on conflict (email) do update set family_id = excluded.family_id, display_name = excluded.display_name;
end $$;

select m.display_name, m.email, f.name as famiglia
from public.members m join public.families f on f.id = m.family_id
where m.email in ('89gasgas@gmail.com', 'valesposito818@gmail.com');
