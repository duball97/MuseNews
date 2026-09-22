import { Masthead, SiteFooter } from "@/components/Masthead";
import { FrontPage } from "@/components/FrontPage";
import { HomeInfiniteNews } from "@/components/HomeInfiniteNews";
import { frontPageBundle } from "@/lib/articles";
import { supabaseConfigured } from "@/lib/supabase";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let breaking: Awaited<ReturnType<typeof frontPageBundle>>["breaking"] = [];
  let news: Awaited<ReturnType<typeof frontPageBundle>>["news"] = [];
  let opinions: Awaited<ReturnType<typeof frontPageBundle>>["opinions"] = [];
  let latest: Awaited<ReturnType<typeof frontPageBundle>>["latest"] = [];

  if (supabaseConfigured()) {
    try {
      const bundle = await frontPageBundle();
      breaking = bundle.breaking;
      news = bundle.news;
      opinions = bundle.opinions;
      latest = bundle.latest;
    } catch (e) {
      console.error(e);
    }
  }

  const excludeIds = [...new Set([...latest, ...opinions].map((a) => a.id))];

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
        <>
          <FrontPage breaking={breaking} news={news} opinions={opinions} latest={latest} />
          <HomeInfiniteNews excludeIds={excludeIds} />
        </>
      )}
      <p className="home-archive">
        <Link href="/news">News archive →</Link>
        {" · "}
        <Link href="/opinions">Opinion desk →</Link>
      </p>
      <SiteFooter />
    </div>
  );
}
