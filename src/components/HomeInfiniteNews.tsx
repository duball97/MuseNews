"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StoryCard } from "@/components/FrontPage";
import type { Article } from "@/lib/types";

const PAGE_SIZE = 8;

export function HomeInfiniteNews({ excludeIds = [] }: { excludeIds?: string[] }) {
  const exclude = useRef(new Set(excludeIds));
  const [items, setItems] = useState<Article[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);

  const loadMore = useCallback(async () => {
    if (inFlight.current || done) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      let nextPage = page;
      let collected: Article[] = [];
      // Keep paging until we gather a batch of unseen stories (front edition may overlap early pages)
      for (let guard = 0; guard < 6 && collected.length < PAGE_SIZE; guard += 1) {
        const res = await fetch(`/api/articles?page=${nextPage}&limit=${PAGE_SIZE}&section=all`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) throw new Error(data?.error || `Could not load page ${nextPage}`);
        const batch = (Array.isArray(data.articles) ? data.articles : []) as Article[];
        setTotal(typeof data.total === "number" ? data.total : null);
        if (!batch.length) {
          setDone(true);
          break;
        }
        for (const a of batch) {
          if (exclude.current.has(a.id)) continue;
          exclude.current.add(a.id);
          collected.push(a);
        }
        nextPage += 1;
        if (batch.length < PAGE_SIZE) {
          setDone(true);
          break;
        }
      }
      if (collected.length) {
        setItems((prev) => [...prev, ...collected]);
      } else if (!done) {
        setDone(true);
      }
      setPage(nextPage);
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [done, page]);

  useEffect(() => {
    if (!started || done || loading) return;
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "320px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [started, done, loading, loadMore]);

  return (
    <section className="home-more" aria-label="More news">
      <div className="home-more-head">
        <p className="section-label">See more news</p>
        {total != null ? (
          <span className="home-more-meta">
            {items.length ? `${items.length} loaded` : null}
            {total ? ` · ${total} in the archives` : null}
          </span>
        ) : null}
      </div>

      {!started ? (
        <div className="home-more-cta">
          <button type="button" className="btn" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "See more news"}
          </button>
          <p className="dek" style={{ margin: "0.65rem 0 0" }}>
            Keep scrolling after you open the wire — more dispatches load as you go.
          </p>
        </div>
      ) : null}

      {items.length ? (
        <div className="home-more-list">
          {items.map((a) => (
            <StoryCard key={a.id} article={a} size="lg" showCover={Boolean(a.cover_url)} />
          ))}
        </div>
      ) : null}

      {error ? <p className="home-more-error">{error}</p> : null}

      {started && !done ? (
        <div className="home-more-cta" ref={sentinelRef}>
          <button type="button" className="btn ghost" onClick={loadMore} disabled={loading}>
            {loading ? "Loading more…" : "Load more"}
          </button>
        </div>
      ) : null}

      {started && done ? (
        <p className="home-more-end">End of the wire for now.</p>
      ) : null}
    </section>
  );
}
