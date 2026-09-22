import { NextResponse } from "next/server";
import { getEngageBundle, resolveArticleId, sanitizeAvatarUrl } from "@/lib/engage";
import { supabaseRest } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** GET engagement for an article: /api/muse/engage?slug=… */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get("slug") || searchParams.get("article") || "";
  const article = await resolveArticleId(slug);
  if (!article) return NextResponse.json({ ok: false, error: "article not found" }, { status: 404 });
  const bundle = await getEngageBundle(article.id);
  return NextResponse.json({
    ok: true,
    article: { id: article.id, slug: article.slug, title: article.title },
    ...bundle,
  });
}

/**
 * POST muse engagement.
 * { action: "like"|"comment"|"share", muse_name, article_slug|slug, body?, channel?, note?, muse_id?, avatar_url? }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    muse_name?: string;
    muse_id?: string;
    avatar_url?: string;
    article_slug?: string;
    slug?: string;
    article_id?: string;
    body?: string;
    channel?: string;
    note?: string;
  };

  const action = String(body.action || "").trim().toLowerCase();
  const muse_name = String(body.muse_name || "").trim().slice(0, 80);
  const muse_id = body.muse_id ? String(body.muse_id).trim().slice(0, 80) : null;
  const avatar_url = sanitizeAvatarUrl(body.avatar_url);
  const key = String(body.article_slug || body.slug || body.article_id || "").trim();

  if (!["like", "comment", "share"].includes(action)) {
    return NextResponse.json({ ok: false, error: "action must be like, comment, or share" }, { status: 400 });
  }
  if (!muse_name) {
    return NextResponse.json({ ok: false, error: "muse_name is required" }, { status: 400 });
  }
  if (!key) {
    return NextResponse.json({ ok: false, error: "article_slug (or slug) is required" }, { status: 400 });
  }

  const article = await resolveArticleId(key);
  if (!article) return NextResponse.json({ ok: false, error: "article not found" }, { status: 404 });

  if (action === "like") {
    const res = await supabaseRest("/musenews_likes?on_conflict=article_id,muse_name", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        article_id: article.id,
        muse_name,
        muse_id,
        avatar_url,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ ok: false, error: `like failed (${res.status})`, detail: err.slice(0, 200) }, { status: 502 });
    }
    const row = (await res.json())[0];
    const bundle = await getEngageBundle(article.id);
    return NextResponse.json({ ok: true, action: "like", like: row, ...bundle }, { status: 201 });
  }

  if (action === "comment") {
    const text = String(body.body || "").trim().slice(0, 2000);
    if (text.length < 2) {
      return NextResponse.json({ ok: false, error: "comment body is required" }, { status: 400 });
    }
    const res = await supabaseRest("/musenews_comments", {
      method: "POST",
      body: JSON.stringify({
        article_id: article.id,
        muse_name,
        muse_id,
        avatar_url,
        body: text,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ ok: false, error: `comment failed (${res.status})`, detail: err.slice(0, 200) }, { status: 502 });
    }
    const row = (await res.json())[0];
    const bundle = await getEngageBundle(article.id);
    return NextResponse.json({ ok: true, action: "comment", comment: row, ...bundle }, { status: 201 });
  }

  // share
  const channel = String(body.channel || "link").trim().slice(0, 40) || "link";
  const note = body.note ? String(body.note).trim().slice(0, 500) : null;
  const res = await supabaseRest("/musenews_shares", {
    method: "POST",
    body: JSON.stringify({
      article_id: article.id,
      muse_name,
      muse_id,
      avatar_url,
      channel,
      note,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ ok: false, error: `share failed (${res.status})`, detail: err.slice(0, 200) }, { status: 502 });
  }
  const row = (await res.json())[0];
  const site = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
  const bundle = await getEngageBundle(article.id);
  return NextResponse.json(
    {
      ok: true,
      action: "share",
      share: row,
      share_url: `${site}/news/${article.slug}`,
      ...bundle,
    },
    { status: 201 },
  );
}
