import { supabaseRest } from "@/lib/supabase";

export type EngageCounts = {
  likes: number;
  comments: number;
  shares: number;
};

export type EngageComment = {
  id: string;
  muse_name: string;
  muse_id: string | null;
  avatar_url: string | null;
  body: string;
  created_at: string;
};

function sanitizeAvatarUrl(raw: unknown): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (s.length > 500) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function resolveArticleId(slugOrId: string): Promise<{ id: string; slug: string; title: string } | null> {
  const key = String(slugOrId || "").trim();
  if (!key) return null;
  const bySlug = await supabaseRest(
    `/musenews_articles?slug=eq.${encodeURIComponent(key)}&status=eq.published&select=id,slug,title&limit=1`,
  );
  if (bySlug.ok) {
    const rows = await bySlug.json();
    if (rows[0]) return rows[0];
  }
  const byId = await supabaseRest(
    `/musenews_articles?id=eq.${encodeURIComponent(key)}&status=eq.published&select=id,slug,title&limit=1`,
  );
  if (!byId.ok) return null;
  const rows = await byId.json();
  return rows[0] || null;
}

export async function getEngageBundle(articleId: string) {
  const empty = {
    counts: { likes: 0, comments: 0, shares: 0 } satisfies EngageCounts,
    comments: [] as EngageComment[],
  };
  try {
    const [likesRes, commentsRes, sharesRes] = await Promise.all([
      supabaseRest(`/musenews_likes?article_id=eq.${articleId}&select=id`, {
        headers: { Prefer: "count=exact", Range: "0-0" },
      }),
      supabaseRest(
        `/musenews_comments?article_id=eq.${articleId}&select=id,muse_name,muse_id,avatar_url,body,created_at&order=created_at.desc&limit=40`,
      ),
      supabaseRest(`/musenews_shares?article_id=eq.${articleId}&select=id`, {
        headers: { Prefer: "count=exact", Range: "0-0" },
      }),
    ]);

    const likeRange = likesRes.headers.get("content-range");
    const shareRange = sharesRes.headers.get("content-range");
    const likes = likeRange?.includes("/") ? Number(likeRange.split("/")[1]) || 0 : 0;
    const shares = shareRange?.includes("/") ? Number(shareRange.split("/")[1]) || 0 : 0;
    const comments = commentsRes.ok ? ((await commentsRes.json()) as EngageComment[]) : [];

    return {
      counts: { likes, comments: comments.length, shares } satisfies EngageCounts,
      comments,
    };
  } catch (err) {
    console.error("getEngageBundle", err);
    return empty;
  }
}

export { sanitizeAvatarUrl };
