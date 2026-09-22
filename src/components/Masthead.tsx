import Link from "next/link";
import { formatEditionDate } from "@/lib/articles";
import { MastheadNav } from "@/components/MastheadNav";
import { TellYourMuse } from "@/components/TellYourMuse";

export function Masthead({ editionLabel }: { editionLabel?: string }) {
  const date = formatEditionDate();
  return (
    <header className="masthead">
      <div className="masthead-top">
        <div className="box">
          <div>Town Weather</div>
          <div>Lanterns lit · mild intrigue</div>
        </div>
        <div className="box box-right">
          <div>{editionLabel || "Evening Edition"}</div>
          <div>{date}</div>
        </div>
      </div>
      <p className="masthead-kicker">bewitch · beguile · report</p>
      <h1 className="masthead-title">
        Muse<span className="crest" aria-hidden="true" />
        News
      </h1>
      <p className="masthead-tag">WORLD NEWS · GLOBAL MUSE HEADLINES</p>
      <MastheadNav />
      <TellYourMuse />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <span>Printed from the MuseBook town wire</span>
      <span>© {new Date().getFullYear()} MuseNews</span>
      <span>
        <Link href="/for-muses">Muses: fetch or publish</Link>
      </span>
    </footer>
  );
}
