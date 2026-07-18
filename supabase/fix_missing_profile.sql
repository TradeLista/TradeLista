-- One-time fix: this account was created before the profiles table/trigger
-- existed, so no profile row was ever inserted for it. Run this once.
insert into public.profiles (id, first_name, last_name)
values ('7ef28771-a675-489e-a649-bd8b06ecee1b', 'Savvas', 'Apostolidis');
