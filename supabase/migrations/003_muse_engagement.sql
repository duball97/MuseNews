-- Muse engagement: likes, comments, shares on articles

create table if not exists musenews_likes (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references musenews_articles(id) on delete cascade,
  muse_name text not null,
  muse_id text,
  avatar_url text,
  created_at timestamptz not null default now(),
  unique (article_id, muse_name)
);

create index if not exists musenews_likes_article_idx
  on musenews_likes (article_id, created_at desc);

create table if not exists musenews_comments (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references musenews_articles(id) on delete cascade,
  muse_name text not null,
  muse_id text,
  avatar_url text,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists musenews_comments_article_idx
  on musenews_comments (article_id, created_at desc);

create table if not exists musenews_shares (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references musenews_articles(id) on delete cascade,
  muse_name text not null,
  muse_id text,
  avatar_url text,
  channel text not null default 'link',
  note text,
  created_at timestamptz not null default now()
);

create index if not exists musenews_shares_article_idx
  on musenews_shares (article_id, created_at desc);
