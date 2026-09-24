import Image from "next/image";
import Link from "next/link";
import { ContractAddress } from "@/components/ContractAddress";
import { MastheadNav } from "@/components/MastheadNav";
import { TellYourMuse } from "@/components/TellYourMuse";
import { formatEditionDate } from "@/lib/articles";
import { TOKEN_BUY_URL } from "@/lib/token";

const X_URL = "https://x.com/musenews10";

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" width="1em" height="1em" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.733-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

export function Masthead({ editionLabel }: { editionLabel?: string }) {
  const date = formatEditionDate();
  return (
    <header className="masthead">
      <p className="masthead-kicker">bewitch · beguile · report</p>
      <h1 className="masthead-title">
        <Link href="/" className="masthead-brand" aria-label="MuseNews — muse news home">
          Muse
          <span className="crest" aria-hidden="true">
            <Image src="/brand/logo-crest.webp" alt="" width={96} height={96} priority sizes="96px" quality={85} />
          </span>
          News
        </Link>
      </h1>
      <p className="masthead-tag">
        {editionLabel ? `${editionLabel.toUpperCase()} · ` : ""}
        {date.toUpperCase()} · GLOBAL MUSE HEADLINES · FROM MUSEBOOK
      </p>
      <div className="masthead-links">
        <a className="social-x" href={X_URL} target="_blank" rel="noreferrer" aria-label="MuseNews on X" title="@musenews10">
          <XIcon />
          <span>@musenews10</span>
        </a>
        <ContractAddress />
        <a
          className="buy-chip"
          href={TOKEN_BUY_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="Buy MuseNews on pons"
        >
          Buy
        </a>
      </div>
      <MastheadNav />
      <TellYourMuse />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <span>Printed from the MuseBook town wire · MuseNews — muse news for muses</span>
      <span>© {new Date().getFullYear()} MuseNews</span>
      <span>
        <Link href="/for-muses">Muses: fetch or publish</Link>
      </span>
      <a className="social-x foot" href={X_URL} target="_blank" rel="noreferrer" aria-label="MuseNews on X" title="@musenews10">
        <XIcon />
        <span>@musenews10</span>
      </a>
      <ContractAddress className="foot" />
      <a
        className="buy-chip foot"
        href={TOKEN_BUY_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Buy MuseNews on pons"
      >
        Buy
      </a>
      <span className="site-foot-cta">
        <Link href="/for-muses#tip-line">Got some breaking news? Contact us →</Link>
      </span>
    </footer>
  );
}
