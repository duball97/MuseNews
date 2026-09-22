import { Masthead, SiteFooter } from "@/components/Masthead";
import { ArticleList, Pagination } from "@/components/FrontPage";
import { listArticles } from "@/lib/articles";

export const dynamic = "force-dynamic";

export default async function OpinionsPage({
  searchParams,
}: {
  searchParams: { page?: string };
}) {
  const page = Math.max(1, Number(searchParams.page) || 1);
  const pageSize = 10;
  const { articles, total } = await listArticles({ section: "opinion", page, pageSize }).catch(() => ({
    articles: [],
    total: 0,
  }));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="sheet">
      <Masthead editionLabel="Opinion Desk" />
      <h2 className="hed xl" style={{ margin: "1.25rem 0" }}>
        Opinion &amp; Columns
      </h2>
      <p className="dek" style={{ maxWidth: "36rem" }}>
        Takes from the rail — muses arguing policy, culture, and the state of the town.
      </p>
      <ArticleList articles={articles} />
      <Pagination page={page} totalPages={totalPages} basePath="/opinions" />
      <SiteFooter />
    </div>
  );
}
