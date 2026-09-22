import { supabaseRest } from "./supabase";
import type { Article, ArticleSection } from "./types";

const SELECT =
  "id,slug,title,dek,body,section,cover_url,cover_prompt,source_post_ids,source_channels,source_authors,importance,status,byline,published_at,created_at";

export async function listArticles({
  section,
  page = 1,
  pageSize = 12,
  q,
}: {
  section?: ArticleSection | "all";
  page?: number;
  pageSize?: number;
  q?: string;
} = {}): Promise<{ articles: Article[]; total: number }> {
  const from = Math.max(0, (page - 1) * pageSize);
  const params = new URLSearchParams();
  params.set("select", SELECT);
  params.set("status", "eq.published");
  params.set("order", "published_at.desc");
  params.set("offset", String(from));
  params.set("limit", String(pageSize));

  if (section && section !== "all") {
    params.set("section", `eq.${section}`);
  }
  if (q && q.trim()) {
    const term = q.trim().replace(/[%(),]/g, "");
    params.set("or", `(title.ilike.*${term}*,dek.ilike.*${term}*,body.ilike.*${term}*,byline.ilike.*${term}*)`);
  }

  const res = await supabaseRest(`/musenews_articles?${params}`, {
    headers: { Prefer: "count=exact" },
  });
  if (!res.ok) {
    console.error("listArticles", res.status, await res.text().catch(() => ""));
    return { articles: [], total: 0 };
  }
  const articles = (await res.json()) as Article[];
  const range = res.headers.get("content-range");
  const total = range?.includes("/") ? Number(range.split("/")[1]) || articles.length : articles.length;
  return { articles, total };
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const res = await supabaseRest(
    `/musenews_articles?slug=eq.${encodeURIComponent(slug)}&status=eq.published&select=${SELECT}&limit=1`,
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Article[];
  return rows[0] || null;
}

/** Older pieces after this one, then fill with other recent so readers can keep clicking. */
export async function listMoreArticles(article: Article, limit = 8): Promise<{ next: Article | null; more: Article[] }> {
  const before = article.published_at || article.created_at;
  const olderParams = new URLSearchParams();
  olderParams.set("select", SELECT);
  olderParams.set("status", "eq.published");
  olderParams.set("id", `neq.${article.id}`);
  if (before) olderParams.set("published_at", `lt.${before}`);
  olderParams.set("order", "published_at.desc");
  olderParams.set("limit", String(limit));

  const olderRes = await supabaseRest(`/musenews_articles?${olderParams}`);
  const older: Article[] = olderRes.ok ? ((await olderRes.json()) as Article[]) : [];

  if (older.length < limit) {
    const fillParams = new URLSearchParams();
    fillParams.set("select", SELECT);
    fillParams.set("status", "eq.published");
    fillParams.set("id", `neq.${article.id}`);
    fillParams.set("order", "published_at.desc");
    fillParams.set("limit", String(limit + 4));
    const fillRes = await supabaseRest(`/musenews_articles?${fillParams}`);
    if (fillRes.ok) {
      const recent = (await fillRes.json()) as Article[];
      const seen = new Set(older.map((a) => a.id));
      for (const a of recent) {
        if (seen.has(a.id)) continue;
        older.push(a);
        seen.add(a.id);
        if (older.length >= limit) break;
      }
    }
  }

  const next = older[0] || null;
  const more = older.slice(1);
  return { next, more };
}

export async function frontPageBundle() {
  // Latest edition window — front page rotates these so refresh feels alive.
  const latest = await listArticles({ section: "all", pageSize: 18 });
  const articles = latest.articles;
  const breaking = articles.filter((a) => a.section === "breaking");
  const news = articles.filter((a) => a.section === "news" || a.section === "breaking");
  const opinions = articles.filter((a) => a.section === "opinion");
  return { breaking, news, opinions, latest: articles };
}

export function excerpt(body: string, words = 55) {
  const parts = body.replace(/\s+/g, " ").trim().split(" ");
  if (parts.length <= words) return body.trim();
  return parts.slice(0, words).join(" ") + "…";
}

export function formatEditionDate(d = new Date()) {
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
