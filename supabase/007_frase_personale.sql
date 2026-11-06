-- FamilyApp: a personal line under the header, shown only to that member. Idempotent.
alter table public.members add column if not exists tagline text;

update public.members set tagline = 'sei amata dal 2015' where email = 'valesposito818@gmail.com';
update public.members set tagline = 'sei amata dal 2015 (prova)'
  where email = 'test-chips@familyapp.test';

select display_name, tagline from public.members order by display_name;
