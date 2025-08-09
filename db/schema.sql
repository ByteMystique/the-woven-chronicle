-- story pieces (append-only)
create table if not exists segments (
  id bigserial primary key,
  created_at timestamptz default now(),
  author text default 'anon',
  text text not null
);

-- audience suggestions queue
create table if not exists queue (
  id bigserial primary key,
  created_at timestamptz default now(),
  author text default 'anon',
  prompt text not null,
  status text default 'pending' check (status in ('pending','processing','done','error'))
);

-- atomically claim next job (prevents double-processing)
create or replace function claim_job()
returns table(id bigint, prompt text, author text)
language plpgsql as $$
declare r record;
begin
  select * into r
  from queue
  where status='pending'
  order by created_at
  for update skip locked
  limit 1;

  if not found then return; end if;

  update queue set status='processing' where id = r.id;
  id := r.id; prompt := r.prompt; author := r.author;
  return next;
end; $$;

-- enable realtime on segments
alter publication supabase_realtime add table segments;
