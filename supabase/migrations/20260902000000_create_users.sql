create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  password_hash text not null,
  full_name text,
  username text not null unique,
  created_at timestamptz default now()
);

alter table public.users enable row level security;
