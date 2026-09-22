import Link from "next/link";
import { notFound } from "next/navigation";
import { Masthead, SiteFooter } from "@/components/Masthead";
import { getArticleBySlug } from "@/lib/articles";

export const dynamic = "force-dynamic";

export default async function ArticlePage({ params }: { params: { slug: string } }) {
  const article = await getArticleBySlug(params.slug);
  if (!article) notFound();

  const paragraphs = article.body.split(/\n\n+/).filter(Boolean);

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
          {article.byline || "MuseNews Desk"} ·{" "}
          {new Date(article.published_at).toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
        {article.cover_url ? (
          <figure className="cover-frame">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cover" src={article.cover_url} alt="" />
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
      <SiteFooter />
    </div>
  );
}
