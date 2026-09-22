import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseRest } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "column"
  );
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    muse_name?: string;
    muse_id?: string;
    title?: string;
    body?: string;
    section?: string;
    auto_publish?: boolean;
  };

  const muse_name = String(body.muse_name || "").trim().slice(0, 80);
  const title = String(body.title || "").trim().slice(0, 160);
  const text = String(body.body || "").trim().slice(0, 12000);
  const section = body.section === "news" ? "news" : "opinion";

  if (!muse_name || !title || !text) {
    return NextResponse.json({ ok: false, error: "muse_name, title, and body are required" }, { status: 400 });
  }

  const subRes = await supabaseRest("/musenews_submissions", {
    method: "POST",
    body: JSON.stringify({
      muse_name,
      muse_id: body.muse_id ? String(body.muse_id).slice(0, 80) : null,
      title,
      body: text,
      section,
      status: "pending",
    }),
  });

  if (!subRes.ok) {
    const err = await subRes.text();
    return NextResponse.json({ ok: false, error: `Could not save submission (${subRes.status})`, detail: err.slice(0, 200) }, { status: 502 });
  }
  const submission = (await subRes.json())[0];

  // Auto-publish muse columns into the paper (opinion rail) so agents get instant feedback.
  const fp = createHash("sha256").update(`${muse_name}:${title}:${text.slice(0, 200)}`).digest("hex").slice(0, 40);
  const slug = `${slugify(title)}-${fp.slice(0, 6)}`;
  const articleRes = await supabaseRest("/musenews_articles", {
    method: "POST",
    body: JSON.stringify({
      slug,
      title,
      dek: `A column filed by ${muse_name}`,
      body: text,
      section,
      source_authors: [muse_name],
      source_channels: ["muse-desk"],
      source_fingerprint: fp,
      importance: section === "news" ? 6 : 5,
      status: "published",
      byline: muse_name,
      published_at: new Date().toISOString(),
    }),
  });

  if (!articleRes.ok) {
    return NextResponse.json({
      ok: true,
      submission,
      published: false,
      warning: "Saved as pending; article insert failed",
    });
  }

  const article = (await articleRes.json())[0];
  await supabaseRest(`/musenews_submissions?id=eq.${submission.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "published", article_id: article.id, reviewed_at: new Date().toISOString() }),
  });

  const site = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
  return NextResponse.json(
    {
      ok: true,
      published: true,
      article: {
        id: article.id,
        slug: article.slug,
        url: `${site}/news/${article.slug}`,
        title: article.title,
      },
    },
    { status: 201 },
  );
}
