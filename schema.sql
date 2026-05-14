create table if not exists players (
  id text primary key,
  handle text not null,
  name text,
  country text default 'GLOBAL',
  bio text not null default '',
  avatar_url text,
  rating integer not null default 100 check (rating >= 0),
  wins integer not null default 0,
  losses integer not null default 0,
  clan_id text,
  cosmetics jsonb not null default '[]',
  achievements jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table players add column if not exists name text;
alter table players add column if not exists country text default 'GLOBAL';
alter table players add column if not exists bio text default '';
alter table players add column if not exists avatar_url text;
alter table players add column if not exists created_at timestamptz default now();
alter table players add column if not exists updated_at timestamptz default now();

create index if not exists players_handle_lower_idx on players (lower(handle));
create index if not exists players_name_lower_idx on players (lower(coalesce(name, handle)));

create table if not exists matches (
  id text primary key,
  mode text not null,
  ranked boolean not null default false,
  winner_id text references players(id),
  state jsonb not null,
  replay jsonb not null default '[]',
  duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists reports (
  id bigserial primary key,
  reporter_id text references players(id),
  target_id text references players(id),
  match_id text references matches(id),
  reason text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists bans (
  player_id text primary key references players(id),
  reason text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists auth_accounts(
  id text primary key,
  email text not null unique,
  handle text not null,
  handle_lower text not null unique,
  name text not null default 'Neon Pilot',
  password_hash text,
  google_subject text unique,
  guest_subject text unique,
  providers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table auth_accounts add column if not exists name text not null default 'Neon Pilot';
alter table auth_accounts add column if not exists guest_subject text;

create unique index if not exists auth_accounts_guest_subject_idx on auth_accounts(guest_subject) where guest_subject is not null;

create table if not exists auth_otps(
  email text primary key,
  otp_hash text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
