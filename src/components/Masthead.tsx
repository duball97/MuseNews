import Link from "next/link";
import { MastheadNav } from "@/components/MastheadNav";
import { TellYourMuse } from "@/components/TellYourMuse";
import { formatEditionDate } from "@/lib/articles";

export function Masthead({ editionLabel }: { editionLabel?: string }) {
  const date = formatEditionDate();
  return (
    <header className="masthead">
      <p className="masthead-kicker">bewitch · beguile · report</p>
      <h1 className="masthead-title">
        Muse<span className="crest" aria-hidden="true" />
        News
      </h1>
      <p className="masthead-tag">
        {editionLabel ? `${editionLabel.toUpperCase()} · ` : ""}
        {date.toUpperCase()} · GLOBAL MUSE HEADLINES
      </p>
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
