-- Security fixes, run once in the Supabase SQL Editor.

-- 1. CRITICAL: the "Users can update their own profile" policy in
-- schema.sql has no WITH CHECK / column scope, so it governs the entire
-- profiles row — any logged-in user can currently run
--   supabase.from('profiles').update({ plan: 'pro' }).eq('id', myId)
-- from the browser console and grant themselves Pro for free, since
-- ingest-trade's Pro check (and the client's isPro()) both just read this
-- same plan column back. This trigger blocks any change to the
-- billing-controlled columns unless it comes from the service role (i.e.
-- the stripe-webhook Edge Function) — with one narrow exception: a user's
-- own client is still allowed to flip their *already-expired* Pro
-- subscription to 'free' (the auto-downgrade in auth.js's isPro()), since
-- that transition can only ever downgrade and both of its preconditions
-- (cancel_at_period_end + a past period_end) were themselves already set
-- by the webhook, not by this update.
create or replace function public.protect_profile_billing_columns()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  is_expiry_downgrade boolean;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  is_expiry_downgrade :=
    old.cancel_at_period_end = true
    and old.period_end is not null
    and old.period_end <= now()
    and new.plan = 'free'
    and new.cancel_at_period_end = false
    and new.period_end is null
    and new.stripe_customer_id is not distinct from old.stripe_customer_id
    and new.stripe_subscription_id is not distinct from old.stripe_subscription_id;

  if is_expiry_downgrade then
    return new;
  end if;

  if new.plan is distinct from old.plan
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.period_end is distinct from old.period_end
     or new.cancel_at_period_end is distinct from old.cancel_at_period_end
  then
    raise exception 'Billing fields can only be changed by TradeLista''s billing system.';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_profile_billing_columns on public.profiles;
create trigger protect_profile_billing_columns
  before update on public.profiles
  for each row execute procedure public.protect_profile_billing_columns();

-- 2. MEDIUM: the trade-images storage SELECT policy has no folder scoping,
-- so any signed-in (or even anon, depending on client config) caller can
-- .list() the bucket root to enumerate every user's folder, then list
-- inside each one to get every trade-screenshot filename. The bucket stays
-- "public" on purpose (so <img src> works without signed URLs), and public
-- buckets serve a direct-by-URL fetch regardless of this policy — this only
-- closes the enumeration/listing path, not the intended "unguessable path,
-- fetchable by anyone who has it" behavior.
drop policy if exists "Anyone can view trade images" on storage.objects;
create policy "Users can list and fetch their own trade images"
  on storage.objects for select
  using (bucket_id = 'trade-images' and auth.uid()::text = (storage.foldername(name))[1]);

-- 3. MEDIUM: the Free=1/Pro=5 trading-account cap is currently only
-- enforced in auth.js's createAccount() — nothing stops a Free user from
-- calling the same insert directly (devtools, or straight against
-- PostgREST) as many times as they like. This trigger mirrors that same
-- rule server-side, so the limit holds regardless of which client is used.
create or replace function public.enforce_account_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  user_plan text;
  existing_count integer;
  max_allowed integer;
begin
  if new.is_default then
    return new; -- the one free default account is exempt, same as the client-side rule
  end if;

  select plan into user_plan from public.profiles where id = new.user_id;
  max_allowed := case when user_plan = 'pro' then 5 else 1 end;

  select count(*) into existing_count
  from public.trading_accounts
  where user_id = new.user_id and is_default = false;

  if existing_count >= max_allowed then
    raise exception 'Account limit reached for your plan.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_account_limit on public.trading_accounts;
create trigger enforce_account_limit
  before insert on public.trading_accounts
  for each row execute procedure public.enforce_account_limit();
