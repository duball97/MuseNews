import { NextResponse } from "next/server";
import { listArticles } from "@/lib/articles";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  if (!q.trim()) {
    return NextResponse.json({ ok: false, error: "q required" }, { status: 400 });
  }
  const { articles, total } = await listArticles({ q, page, pageSize: 20 });
  return NextResponse.json({ ok: true, q, total, articles });
}
