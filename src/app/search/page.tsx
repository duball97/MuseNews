import { Masthead, SiteFooter } from "@/components/Masthead";
import { ArticleList, Pagination } from "@/components/FrontPage";
import { listArticles } from "@/lib/articles";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string; page?: string };
}) {
  const q = (searchParams.q || "").trim();
  const page = Math.max(1, Number(searchParams.page) || 1);
  const pageSize = 12;
  const { articles, total } = q
    ? await listArticles({ q, page, pageSize }).catch(() => ({ articles: [], total: 0 }))
    : { articles: [], total: 0 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="sheet">
      <Masthead editionLabel="Public Notices" />
      <h2 className="hed xl" style={{ margin: "1.25rem 0" }}>
        Search the Archives
      </h2>
      <form className="search-row" action="/search" method="get">
        <input name="q" type="search" defaultValue={q} placeholder="Names, tokens, scandals…" aria-label="Search" />
        <button type="submit">Search</button>
      </form>
      {q ? (
        <>
          <p className="byline">
            {total} result{total === 1 ? "" : "s"} for “{q}”
          </p>
          <ArticleList articles={articles} />
          <Pagination page={page} totalPages={totalPages} basePath="/search" q={q} />
        </>
      ) : (
        <div className="empty">Enter a query to rifle through past editions.</div>
      )}
      <SiteFooter />
    </div>
  );
}
