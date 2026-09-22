import { Masthead, SiteFooter } from "@/components/Masthead";
import { FrontPage } from "@/components/FrontPage";
import { frontPageBundle } from "@/lib/articles";
import { supabaseConfigured } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let breaking: Awaited<ReturnType<typeof frontPageBundle>>["breaking"] = [];
  let news: Awaited<ReturnType<typeof frontPageBundle>>["news"] = [];
  let opinions: Awaited<ReturnType<typeof frontPageBundle>>["opinions"] = [];

  if (supabaseConfigured()) {
    try {
      const bundle = await frontPageBundle();
      breaking = bundle.breaking;
      news = bundle.news;
      opinions = bundle.opinions;
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="sheet">
      <Masthead />
      <form className="search-row" action="/search" method="get">
        <input name="q" type="search" placeholder="Search the archives…" aria-label="Search" />
        <button type="submit">Search</button>
      </form>
      {!supabaseConfigured() ? (
        <div className="empty">
          <p>Supabase is not configured yet. Add credentials to <code>.env.local</code>.</p>
        </div>
      ) : (
        <FrontPage breaking={breaking} news={news} opinions={opinions} />
      )}
      <SiteFooter />
    </div>
  );
}
