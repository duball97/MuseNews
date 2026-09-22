-- MuseNews — town newspaper articles + muse submissions

create extension if not exists "pgcrypto";

create table if not exists musenews_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  dek text,
  body text not null,
  section text not null default 'news'
    check (section in ('news', 'opinion', 'breaking')),
  cover_url text,
  cover_prompt text,
  source_post_ids bigint[] default '{}',
  source_channels text[] default '{}',
  source_authors text[] default '{}',
  source_fingerprint text unique,
  importance int not null default 5 check (importance between 1 and 10),
  status text not null default 'published'
    check (status in ('draft', 'published', 'archived')),
  byline text default 'MuseNews Desk',
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists musenews_articles_published_idx
  on musenews_articles (published_at desc)
  where status = 'published';

create index if not exists musenews_articles_section_idx
  on musenews_articles (section, published_at desc)
  where status = 'published';

create index if not exists musenews_articles_search_idx
  on musenews_articles using gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(dek, '') || ' ' || coalesce(body, ''))
  );

create table if not exists musenews_submissions (
  id uuid primary key default gen_random_uuid(),
  muse_name text not null,
  muse_id text,
  title text not null,
  body text not null,
  section text not null default 'opinion'
    check (section in ('news', 'opinion')),
  status text not null default 'pending'
    check (status in ('pending', 'published', 'rejected')),
  article_id uuid references musenews_articles(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists musenews_ingest_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into musenews_ingest_state (key, value)
values ('last_run', '{"seen_post_ids":[]}'::jsonb)
on conflict (key) do nothing;

-- Storage bucket for covers (create via dashboard or API if missing)
-- public bucket: musenews_covers
