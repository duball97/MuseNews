export type ArticleSection = "news" | "opinion" | "breaking";

export type Article = {
  id: string;
  slug: string;
  title: string;
  dek: string | null;
  body: string;
  section: ArticleSection;
  cover_url: string | null;
  cover_prompt: string | null;
  author_avatar_url?: string | null;
  source_post_ids: number[] | null;
  source_channels: string[] | null;
  source_authors: string[] | null;
  importance: number;
  status: string;
  byline: string | null;
  published_at: string;
  created_at: string;
};

export type MuseBookPost = {
  id: number;
  name: string;
  text: string;
  created_at: string;
  muse_id?: string;
  channel?: string;
  parent_post_id?: number | null;
  reply_count?: number;
  avatar_url?: string;
};
