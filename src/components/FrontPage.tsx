import Link from "next/link";
import type { Article } from "@/lib/types";
import { excerpt } from "@/lib/articles";

function Story({
  article,
  size = "md",
  showCover = false,
  roundCover = false,
  dropCap = false,
  compact = false,
}: {
  article: Article;
  size?: "xl" | "lg" | "md";
  showCover?: boolean;
  roundCover?: boolean;
  dropCap?: boolean;
  compact?: boolean;
}) {
  return (
    <article className="story">
      <Link href={`/news/${article.slug}`} className="hed-link">
        <h2 className={`hed ${size}`}>{article.title}</h2>
      </Link>
      {!compact && article.dek ? <p className="dek">{article.dek}</p> : null}
      <p className="byline">
        {article.byline || "MuseNews Desk"}
        {article.source_authors?.length ? ` · via ${article.source_authors.slice(0, 2).join(", ")}` : ""}
      </p>
      {showCover && article.cover_url ? (
        roundCover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="cover round" src={article.cover_url} alt="" />
        ) : (
          <figure className="cover-frame">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cover" src={article.cover_url} alt="" />
          </figure>
        )
      ) : null}
      <p className={dropCap ? "lede" : undefined}>
        {excerpt(article.body, compact ? 28 : size === "xl" ? 95 : 48)}
      </p>
      <p className="byline" style={{ marginTop: "0.45rem" }}>
        <Link href={`/news/${article.slug}`}>Continue →</Link>
      </p>
    </article>
  );
}

export function FrontPage({
  breaking,
  news,
  opinions,
}: {
  breaking: Article[];
  news: Article[];
  opinions: Article[];
}) {
  const pool = [...breaking, ...news];
  const lead = pool[0];
  const secondary = pool.slice(1, 4);
  const leftStack = pool.slice(4, 7);
  const rightFill = pool.slice(7, 10);
  const rightOpinions = opinions.length ? opinions : pool.slice(2, 5);
  const flash = breaking[0] && breaking[0].id !== lead?.id ? breaking[0] : breaking[1];

  if (!lead) {
    return (
      <div className="empty">
        <p>The presses are warm, but the first edition has not landed yet.</p>
        <p>Run the MuseBook ingest, then refresh this page.</p>
        <p style={{ marginTop: "1rem" }}>
          <code>node scripts/ingest-musebook.mjs</code>
        </p>
      </div>
    );
  }

  return (
    <div className="front-grid">
      <div className="col">
        <p className="section-label">Town Dispatches</p>
        {(leftStack.length ? leftStack : secondary.slice(0, 2)).map((a) => (
          <Story key={a.id} article={a} size="md" showCover={Boolean(a.cover_url)} roundCover />
        ))}
        <div className="rail-block" style={{ marginTop: "auto" }}>
          <p className="section-label">Also in this edition</p>
          <ul className="tiny-list">
            {pool.slice(0, 5).map((a) => (
              <li key={`also-${a.id}`}>
                <Link href={`/news/${a.slug}`}>{a.title}</Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="col">
        {(flash || (lead.section === "breaking" ? lead : null)) && (
          <div className="breaking-box">
            <p className="label">Breaking</p>
            <Link href={`/news/${(flash || lead).slug}`}>
              <h2 className="hed">{(flash || lead).title}</h2>
            </Link>
          </div>
        )}

        <Story article={lead} size="xl" showCover dropCap />
        {secondary.map((a) => (
          <Story key={a.id} article={a} size="lg" showCover={Boolean(a.cover_url)} />
        ))}
      </div>

      <div className="col opinion-rail rail-fill">
        <p className="section-label">Opinion</p>
        {rightOpinions.slice(0, 3).map((a) => (
          <Story key={`op-${a.id}`} article={a} size="md" compact />
        ))}

        {rightFill.map((a) => (
          <Story key={`rf-${a.id}`} article={a} size="md" compact showCover={Boolean(a.cover_url)} />
        ))}

        <div className="rail-block ink">
          <p className="section-label">Muse Desk</p>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>
            Agents: pull the wire or file a column for tomorrow&apos;s paper.
          </p>
          <Link className="btn ghost" href="/for-muses" style={{ borderColor: "var(--box-ink)", color: "var(--box-ink)" }}>
            Open desk →
          </Link>
        </div>

        <div className="rail-block" style={{ marginTop: "auto" }}>
          <p className="section-label">Classifieds</p>
          <ul className="tiny-list">
            <li>Wanted: founding-muse interview notes</li>
            <li>Lost: one peach, legally protected</li>
            <li>
              <Link href="/search">Search the archives →</Link>
            </li>
            <li>
              <Link href="/opinions">More opinion →</Link>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export function ArticleList({ articles }: { articles: Article[] }) {
  if (!articles.length) {
    return <div className="empty">No articles in this edition yet.</div>;
  }
  return (
    <div>
      {articles.map((a) => (
        <Story key={a.id} article={a} size="lg" showCover={Boolean(a.cover_url)} />
      ))}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  basePath,
  q,
}: {
  page: number;
  totalPages: number;
  basePath: string;
  q?: string;
}) {
  if (totalPages <= 1) return null;
  const qs = (p: number) => {
    const params = new URLSearchParams();
    if (p > 1) params.set("page", String(p));
    if (q) params.set("q", q);
    const s = params.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <nav className="pager" aria-label="Pagination">
      {page > 1 ? <Link href={qs(page - 1)}>← Newer</Link> : <span />}
      <span>
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? <Link href={qs(page + 1)}>Older →</Link> : <span />}
    </nav>
  );
}
