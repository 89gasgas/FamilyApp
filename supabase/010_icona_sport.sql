-- FamilyApp: Sport icon becomes a tennis ball (GaS, 6 nov 2026). Idempotent.
update public.expense_categories set icon = '🎾' where icon = '⚽';
select f.name, c.name, c.icon from public.expense_categories c join public.families f on f.id = c.family_id where c.icon = '🎾';
