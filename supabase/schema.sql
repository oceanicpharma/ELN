-- Oceanic Lab Workflow: Supabase database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, and choose Run. Safe to run again.

-- One table per record type. Each row keeps the full record in `doc` (JSON) plus a few columns
-- you can read and filter at a glance in the Table Editor, like the old Google Sheet.
create table if not exists public.entries (
  id          text primary key,               -- CHEM-2026-0001
  summary     text,                           -- title
  status      text,                           -- Draft / Submitted / Signed
  version     integer not null default 1,     -- blocks two people overwriting each other
  updated_at  timestamptz not null default now(),
  updated_by  text,
  doc         jsonb not null                  -- the full record (do not edit by hand)
);

create table if not exists public.requests (
  id          text primary key,               -- SR-2026-0001
  sample_id   text unique,                    -- CHEM-2026-0001-S01
  summary     text,
  status      text,                           -- Requested / Received
  version     integer not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  doc         jsonb not null
);

create table if not exists public.samples (
  id          text primary key,               -- CHEM-2026-0001-S01
  ana_entry   text unique,                    -- ANA-2026-0001
  summary     text,
  status      text,                           -- Registered / In testing / Ready for review / Approved / Report issued
  version     integer not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  doc         jsonb not null
);

-- Append-only audit trail: a full copy of every version of every record, with who and when.
create table if not exists public.audit_log (
  seq         bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  by_email    text not null,
  collection  text not null,
  record_id   text not null,
  version     integer not null,
  action      text,
  snapshot    jsonb not null
);
create index if not exists audit_log_record on public.audit_log (collection, record_id, version);

-- The audit trail can be added to, never changed or deleted (not even by the app).
create or replace function public.audit_log_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_log_no_change on public.audit_log;
create trigger audit_log_no_change before update or delete on public.audit_log
  for each row execute function public.audit_log_is_append_only();

-- Lock the tables down. Browsers can't read or write them directly; only the Netlify
-- server function (which uses the secret service key and checks each user) can.
alter table public.entries   enable row level security;
alter table public.requests  enable row level security;
alter table public.samples   enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.entries, public.requests, public.samples, public.audit_log from anon, authenticated;

-- Private file storage (replaces the Google Drive folders LAB-Working and LAB-Records).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-files', 'lab-files', false, 20971520, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
