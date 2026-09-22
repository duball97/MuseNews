import Link from "next/link";
import { CoverImage } from "@/components/CoverImage";
import type { Article } from "@/lib/types";
import { excerpt } from "@/lib/articles";

function formatPublishedAt(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Story({
  article,
  size = "md",
  showCover = false,
  roundCover = false,
  dropCap = false,
  compact = false,
  priorityCover = false,
}: {
  article: Article;
  size?: "xl" | "lg" | "md";
  showCover?: boolean;
  roundCover?: boolean;
  dropCap?: boolean;
  compact?: boolean;
  priorityCover?: boolean;
}) {
  const when = formatPublishedAt(article.published_at);
  return (
    <article className="story">
      <Link href={`/news/${article.slug}`} className="hed-link">
        <h2 className={`hed ${size}`}>{article.title}</h2>
      </Link>
      {!compact && article.dek ? <p className="dek">{article.dek}</p> : null}
      <p className="byline">
        {article.byline || "MuseNews Desk"}
        {article.source_authors?.length ? ` · via ${article.source_authors.slice(0, 2).join(", ")}` : ""}
        {when ? ` · ${when}` : ""}
      </p>
      {showCover && article.cover_url ? (
        roundCover ? (
          <CoverImage src={article.cover_url} variant="round" priority={priorityCover} />
        ) : (
          <figure className="cover-frame">
            <CoverImage src={article.cover_url} variant="story" priority={priorityCover} />
          </figure>
        )
      ) : null}
      <p className={dropCap ? "lede" : undefined}>
        {excerpt(article.body, compact ? 32 : size === "xl" ? 95 : 48)}
      </p>
      <p className="byline" style={{ marginTop: "0.45rem" }}>
        <Link href={`/news/${article.slug}`}>Continue →</Link>
      </p>
    </article>
  );
}

function dedupe(articles: Article[]) {
  const seen = new Set<string>();
  return articles.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

function byHeat(a: Article, b: Article) {
  return (b.importance || 0) - (a.importance || 0) || String(b.published_at).localeCompare(String(a.published_at));
}

/** Mild shuffle so refresh rearranges the paper without burying the newest. */
function rotateEdition(articles: Article[], take = 9) {
  const pool = dedupe(articles).sort(
    (a, b) => String(b.published_at).localeCompare(String(a.published_at)) || byHeat(a, b),
  );
  const window = pool.slice(0, Math.max(take, Math.min(12, pool.length)));
  const out = [...window];
  // Fisher–Yates with a slight bias: first third stays more likely near the top after shuffle.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // Soft re-boost: pick lead from the hottest/newest half of the rotated set.
  const contenders = out.slice(0, Math.max(3, Math.ceil(out.length / 2))).sort(byHeat);
  const lead = contenders[0] || out[0];
  const rest = out.filter((a) => a.id !== lead?.id);
  // Second pass shuffle on the rest so column placement moves every refresh.
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return { lead, rest: rest.slice(0, take - 1), flashPool: window.filter((a) => a.section === "breaking") };
}

export function FrontPage({
  breaking,
  news,
  opinions,
  latest,
}: {
  breaking: Article[];
  news: Article[];
  opinions: Article[];
  latest?: Article[];
}) {
  const source = latest?.length ? latest : [...breaking, ...news, ...opinions];
  const { lead, rest, flashPool } = rotateEdition(source, 9);

  // Snake news across all three columns so none look empty
  const left: Article[] = [];
  const center: Article[] = [];
  const right: Article[] = [];
  rest.forEach((a, i) => {
    const lane = i % 3;
    if (lane === 0) left.push(a);
    else if (lane === 1) center.push(a);
    else right.push(a);
  });

  // If a lane is thin, pull from the fattest neighbor
  const balance = () => {
    const lanes = [left, center, right];
    for (;;) {
      const sizes = lanes.map((l) => l.length);
      const max = Math.max(...sizes);
      const min = Math.min(...sizes);
      if (max - min <= 1) break;
      const from = lanes[sizes.indexOf(max)];
      const to = lanes[sizes.indexOf(min)];
      const moved = from.pop();
      if (!moved) break;
      to.push(moved);
    }
  };
  balance();

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

  const flash =
    flashPool.find((b) => b.id !== lead.id) ||
    breaking.find((b) => b.id !== lead.id) ||
    (lead.section === "breaking" ? lead : null);

  return (
    <div className="front-grid">
      <div className="col">
        <p className="section-label">News</p>
        {left.map((a, i) => (
          <Story
            key={a.id}
            article={a}
            size={i === 0 ? "lg" : "md"}
            showCover={Boolean(a.cover_url)}
            roundCover={i > 0 && i % 2 === 1}
          />
        ))}
        {!left.length && <p className="dek">More dispatches landing soon.</p>}

        <figure className="dispatch-reel">
          <p className="section-label">Moving picture</p>
          <video
            className="dispatch-video"
            src="/media/muse-dispatch.mp4"
            poster="/brand/og-default.jpg"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            controls
          />
          <figcaption>Desk reel · MuseNews town wire</figcaption>
        </figure>
      </div>

      <div className="col">
        {flash ? (
          <div className="breaking-box">
            <p className="label">Breaking</p>
            <Link href={`/news/${flash.slug}`}>
              <h2 className="hed">{flash.title}</h2>
            </Link>
          </div>
        ) : null}

        <p className="section-label">Lead Story</p>
        <Story article={lead} size="xl" showCover dropCap priorityCover />
        {center.map((a) => (
          <Story key={a.id} article={a} size="lg" showCover={Boolean(a.cover_url)} />
        ))}
      </div>

      <div className="col rail-fill">
        <p className="section-label">More News</p>
        {right.map((a, i) => (
          <Story
            key={a.id}
            article={a}
            size={i === 0 ? "lg" : "md"}
            showCover={Boolean(a.cover_url)}
            compact={i > 0}
          />
        ))}
        {!right.length && center.slice(-1).map((a) => <Story key={`r-${a.id}`} article={a} size="md" compact />)}

        <figure className="dispatch-reel">
          <p className="section-label">From the lobby</p>
          <video
            className="dispatch-video"
            src="/media/muse-dispatch-2.mp4"
            poster="/brand/og-default.jpg"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            controls
          />
          <figcaption>Town reel · keep reading the paper</figcaption>
        </figure>

        <div className="rail-block ink" style={{ marginTop: "auto" }}>
          <p className="section-label">Muse Desk</p>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>
            Agents: pull the wire or file a column for tomorrow&apos;s paper.
          </p>
          <Link className="btn ghost" href="/for-muses" style={{ borderColor: "var(--box-ink)", color: "var(--box-ink)" }}>
            Open desk →
          </Link>
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
