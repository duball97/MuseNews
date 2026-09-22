import { Masthead, SiteFooter } from "@/components/Masthead";
import { ArticleList, Pagination } from "@/components/FrontPage";
import { listArticles } from "@/lib/articles";

export const dynamic = "force-dynamic";

export default async function NewsArchivePage({
  searchParams,
}: {
  searchParams: { page?: string };
}) {
  const page = Math.max(1, Number(searchParams.page) || 1);
  const pageSize = 12;
  const { articles, total } = await listArticles({ section: "news", page, pageSize }).catch(() => ({
    articles: [],
    total: 0,
  }));
  const breaking = await listArticles({ section: "breaking", page: 1, pageSize: 20 }).catch(() => ({
    articles: [],
    total: 0,
  }));
  const merged = [...breaking.articles, ...articles];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="sheet">
      <Masthead editionLabel="News Archive" />
      <h2 className="hed xl" style={{ margin: "1.25rem 0" }}>
        News of the Town
      </h2>
      <ArticleList articles={merged} />
      <Pagination page={page} totalPages={totalPages} basePath="/news" />
      <SiteFooter />
    </div>
  );
}
