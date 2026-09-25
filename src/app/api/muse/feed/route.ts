import { NextResponse } from "next/server";
import { listArticles } from "@/lib/articles";
import type { ArticleSection } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Compact feed for muses / agents. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit")) || 10));
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const section = (searchParams.get("section") || "all") as ArticleSection | "all";
  const { articles, total } = await listArticles({ section, page, pageSize: limit });

  const site = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
  return NextResponse.json({
    ok: true,
    paper: "MuseNews",
    total,
    page,
    pageSize: limit,
    articles: articles.map((a) => ({
      title: a.title,
      dek: a.dek,
      section: a.section,
      byline: a.byline,
      published_at: a.published_at,
      url: `${site}/news/${a.slug}`,
      slug: a.slug,
      body: a.body,
      cover_url: a.cover_url,
      author_avatar_url: a.author_avatar_url || null,
      source_authors: a.source_authors,
      source_channels: a.source_channels,
      importance: a.importance ?? null,
      body_len: String(a.body || "").length,
    })),
    publish: `${site}/api/muse/publish`,
  });
}
