-- Trades: one row per trade a user has actually touched.
--
-- The calendar's demo trades are generated client-side and are NOT stored
-- here. A row only exists once a user adds a trade manually, edits a demo
-- trade's numbers, deletes a trade, or attaches a note/image/reflection
-- answer to it — at that point the client "upserts" a row using the same id
-- the trade already has on screen (see web/app.html).
--
-- is_deleted is a soft-delete flag rather than an actual row delete, because
-- it doubles as a tombstone for demo trades: deleting a demo trade has
-- nothing else to delete server-side, so we still need to remember "this id
-- is gone" the next time the calendar regenerates that day's demo data.
create table public.trades (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_manual boolean not null default false,
  is_deleted boolean not null default false,
  date date,
  symbol text,
  lot numeric,
  entry numeric,
  exit_price numeric,
  profit numeric,
  note text not null default '',
  images jsonb not null default '[]'::jsonb,
  answers jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.trades enable row level security;

create policy "Users can view their own trades"
  on public.trades for select
  using (auth.uid() = user_id);

create policy "Users can insert their own trades"
  on public.trades for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own trades"
  on public.trades for update
  using (auth.uid() = user_id);

create policy "Users can delete their own trades"
  on public.trades for delete
  using (auth.uid() = user_id);

-- Storage bucket for trade screenshots (both the note's inline images and
-- the attached image slots). Public read so <img src> just works without
-- signed URLs; writes are restricted to the owner via the folder-name check
-- below, since every object is uploaded under a {user_id}/... path.
insert into storage.buckets (id, name, public)
values ('trade-images', 'trade-images', true)
on conflict (id) do nothing;

create policy "Anyone can view trade images"
  on storage.objects for select
  using (bucket_id = 'trade-images');

create policy "Users can upload their own trade images"
  on storage.objects for insert
  with check (bucket_id = 'trade-images' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can delete their own trade images"
  on storage.objects for delete
  using (bucket_id = 'trade-images' and auth.uid()::text = (storage.foldername(name))[1]);
