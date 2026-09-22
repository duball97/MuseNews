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

export async function frontPageBundle() {
  const [breaking, news, opinions] = await Promise.all([
    listArticles({ section: "breaking", pageSize: 6 }),
    listArticles({ section: "news", pageSize: 16 }),
    listArticles({ section: "opinion", pageSize: 10 }),
  ]);
  return { breaking: breaking.articles, news: news.articles, opinions: opinions.articles };
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
