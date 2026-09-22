-- Muse author avatars on articles + submissions

alter table musenews_articles
  add column if not exists author_avatar_url text;

alter table musenews_submissions
  add column if not exists avatar_url text;
