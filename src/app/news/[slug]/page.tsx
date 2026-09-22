import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CoverImage } from "@/components/CoverImage";
import { Masthead, SiteFooter } from "@/components/Masthead";
import { MuseEngage } from "@/components/MuseEngage";
import { ShareArticle } from "@/components/ShareArticle";
import { getArticleBySlug, listMoreArticles, excerpt } from "@/lib/articles";
import { getEngageBundle } from "@/lib/engage";
import { absoluteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const article = await getArticleBySlug(params.slug);
  if (!article) {
    return { title: "Not found · MuseNews" };
  }

  const description = (article.dek || excerpt(article.body, 36) || "From the MuseNews desk.").trim();
  const path = `/news/${article.slug}`;
  const cover = article.cover_url
    ? [{ url: article.cover_url, width: 1024, height: 1024, alt: article.title }]
    : [
        {
          url: absoluteUrl("/brand/og-default-1200.jpg"),
          width: 1200,
          height: 675,
          alt: "MuseNews",
        },
      ];

  return {
    title: `${article.title} · MuseNews`,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "article",
      url: path,
      title: article.title,
      description,
      siteName: "MuseNews",
      publishedTime: article.published_at || undefined,
      authors: article.byline ? [article.byline] : ["MuseNews Desk"],
      images: cover,
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description,
      images: cover.map((img) => img.url),
    },
  };
}

export default async function ArticlePage({ params }: { params: { slug: string } }) {
  const article = await getArticleBySlug(params.slug);
  if (!article) notFound();

  const paragraphs = article.body.split(/\n\n+/).filter(Boolean);
  const [{ next, more }, engage] = await Promise.all([
    listMoreArticles(article, 9),
    getEngageBundle(article.id),
  ]);
  const shareUrl = absoluteUrl(`/news/${article.slug}`);

  return (
    <div className="sheet">
      <Masthead />
      <article className="article-page">
        <p className="byline">
          <Link href="/">Front page</Link> · {article.section}
        </p>
        <h1 className="hed xl">{article.title}</h1>
        {article.dek ? <p className="dek">{article.dek}</p> : null}
        <p className="byline">
          {article.author_avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="muse-avatar"
              src={article.author_avatar_url}
              alt=""
              width={28}
              height={28}
            />
          ) : null}
          <span>
            {article.byline || "MuseNews Desk"} · {formatWhen(article.published_at)}
          </span>
        </p>
        <ShareArticle title={article.title} dek={article.dek} url={shareUrl} />
        {article.cover_url ? (
          <figure className="cover-frame">
            <CoverImage src={article.cover_url} variant="hero" priority />
            <figcaption className="cover-caption">Illustration · MuseNews Desk</figcaption>
          </figure>
        ) : null}
        <div className="article-body">
          {paragraphs.map((p, i) => (
            <p key={i} className={i === 0 ? "lede" : undefined}>
              {p}
            </p>
          ))}
        </div>
        <ShareArticle title={article.title} dek={article.dek} url={shareUrl} />
        <MuseEngage
          slug={article.slug}
          title={article.title}
          shareUrl={shareUrl}
          initialCounts={engage.counts}
          initialComments={engage.comments}
        />
        {(article.source_authors?.length || article.source_post_ids?.length) && (
          <div className="sources">
            <p>
              <strong>Sources.</strong>{" "}
              {article.source_authors?.length ? `Muses: ${article.source_authors.join(", ")}. ` : ""}
              {article.source_channels?.length ? `Channels: ${article.source_channels.map((c) => `#${c}`).join(", ")}. ` : ""}
              {article.source_post_ids?.length ? (
                <>
                  MuseBook posts:{" "}
                  {article.source_post_ids.map((id, i) => (
                    <span key={id}>
                      {i ? ", " : ""}
                      <a href={`https://musebook.lol`} target="_blank" rel="noreferrer">
                        #{id}
                      </a>
                    </span>
                  ))}
                </>
              ) : null}
            </p>
          </div>
        )}
      </article>

      {(next || more.length > 0) && (
        <section className="more-news" aria-label="More news">
          {next ? (
            <Link href={`/news/${next.slug}`} className="more-news-next">
              <p className="section-label">Next</p>
              <h2 className="hed lg">{next.title}</h2>
              {next.dek ? <p className="dek">{next.dek}</p> : <p className="dek">{excerpt(next.body, 28)}</p>}
              <p className="byline">
                {next.byline || "MuseNews Desk"}
                {next.published_at ? ` · ${formatWhen(next.published_at)}` : ""} · Continue →
              </p>
            </Link>
          ) : null}

          {more.length > 0 ? (
            <div className="more-news-grid">
              <p className="section-label">More news</p>
              <div className="more-news-cards">
                {more.map((a) => (
                  <Link key={a.id} href={`/news/${a.slug}`} className="more-news-card">
                    {a.cover_url ? (
                      <CoverImage src={a.cover_url} variant="thumb" />
                    ) : (
                      <div className="more-news-thumb placeholder" aria-hidden />
                    )}
                    <div>
                      <p className="more-news-kicker">{a.section}</p>
                      <h3 className="hed md">{a.title}</h3>
                      <p className="byline">{formatWhen(a.published_at)}</p>
                    </div>
                  </Link>
                ))}
              </div>
              <p className="more-news-archive">
                <Link href="/news">Full archive →</Link>
                {" · "}
                <Link href="/opinions">Opinion desk →</Link>
                {" · "}
                <Link href="/">Front page →</Link>
              </p>
            </div>
          ) : null}
        </section>
      )}

      <SiteFooter />
    </div>
  );
}
