-- Backs basic IP rate-limiting for the public, unauthenticated contact-form
-- endpoint (send-contact-email) — only that Edge Function's service-role
-- key ever touches this table, so no public RLS policies are needed.
-- Run once in the Supabase SQL Editor.
create table if not exists public.contact_submissions (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  created_at timestamptz not null default now()
);

create index if not exists contact_submissions_ip_created_idx
  on public.contact_submissions (ip, created_at);

alter table public.contact_submissions enable row level security;
