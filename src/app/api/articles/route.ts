import { NextResponse } from "next/server";
import { listArticles } from "@/lib/articles";
import type { ArticleSection } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(searchParams.get("limit")) || 12));
  const section = (searchParams.get("section") || "all") as ArticleSection | "all";
  const q = searchParams.get("q") || undefined;
  const { articles, total } = await listArticles({ section, page, pageSize, q });
  return NextResponse.json({ ok: true, page, pageSize, total, articles });
}
