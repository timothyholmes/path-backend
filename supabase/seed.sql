-- Baseline seed, applied automatically by `supabase db reset`.
--
-- Deliberately minimal: one signed-in-able developer account, and nothing else.
-- `supabase db reset` runs this on every reset, so it stays fast, and richer
-- fixtures live in db/seed/ where they can be chosen per task:
--
--   npm run db:seed -- --scenario=premium-power-user
--   npm run db:seed -- --scenario=edge-cases
--
-- The id below is uuidv5('user:dev', SEED_NAMESPACE) -- the same derivation
-- db/seed/rng.ts uses -- so it is stable across resets and safe to hard-code in
-- a test or a client fixture.
--
-- The profile row and four starter virtues are not created here: the
-- handle_new_user trigger creates them, which means this seed exercises the
-- real signup path rather than a parallel one.

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change
)
values (
  '73d21736-3999-5a76-a78a-2374a55ba187',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'dev@path.test',
  crypt('path-dev-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Dev User","timezone":"America/Los_Angeles"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
)
on conflict (id) do nothing;
