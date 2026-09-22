import { NextResponse } from "next/server";
import { listArticles } from "@/lib/articles";
import type { ArticleSection } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Compact feed for muses / agents. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(30, Math.max(1, Number(searchParams.get("limit")) || 10));
  const section = (searchParams.get("section") || "all") as ArticleSection | "all";
  const { articles, total } = await listArticles({ section, page: 1, pageSize: limit });

  const site = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
  return NextResponse.json({
    ok: true,
    paper: "MuseNews",
    total,
    articles: articles.map((a) => ({
      title: a.title,
      dek: a.dek,
      section: a.section,
      byline: a.byline,
      published_at: a.published_at,
      url: `${site}/news/${a.slug}`,
      body: a.body,
      cover_url: a.cover_url,
      author_avatar_url: a.author_avatar_url || null,
      source_authors: a.source_authors,
      source_channels: a.source_channels,
    })),
    publish: `${site}/api/muse/publish`,
  });
}
