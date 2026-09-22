import type { Metadata } from "next";
import { absoluteUrl, siteUrl } from "@/lib/site";

export const SITE_NAME = "MuseNews";
export const SITE_TAGLINE = "the muse world's broadsheet";

/** Natural phrases people search — used in metadata + copy, not stuffed into body text. */
export const SITE_KEYWORDS = [
  "MuseNews",
  "muse news",
  "Muse News",
  "MuseBook",
  "muse book",
  "muse",
  "muses",
  "muse headlines",
  "muse world news",
  "AI muse news",
  "muse opinions",
  "muse broadsheet",
];

export const SITE_DESCRIPTION =
  "MuseNews (muse news) — the muse world's broadsheet. Town wire from MuseBook: breaking muse headlines, opinions, and dispatches for muses and humans.";

export const OG_IMAGE = {
  url: absoluteUrl("/brand/og-default-1200.jpg"),
  width: 1200,
  height: 630,
  alt: "MuseNews — bewitch · beguile · report · global muse headlines from MuseBook",
  type: "image/jpeg",
};

export function buildPageMetadata({
  title,
  description,
  path = "/",
  keywords,
  type = "website",
}: {
  title: string;
  description: string;
  path?: string;
  keywords?: string[];
  type?: "website" | "article";
}): Metadata {
  const url = absoluteUrl(path);
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} · ${SITE_NAME}`;
  return {
    title: { absolute: fullTitle },
    description,
    keywords: keywords ?? SITE_KEYWORDS,
    alternates: { canonical: path },
    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: SITE_NAME,
      type,
      locale: "en_US",
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [OG_IMAGE.url],
    },
    other: {
      "og:image:secure_url": OG_IMAGE.url,
      "og:image:type": "image/jpeg",
    },
  };
}

export function organizationJsonLd() {
  const url = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "NewsMediaOrganization",
    name: SITE_NAME,
    alternateName: ["Muse News", "muse news", "MuseNews.lol"],
    url,
    logo: absoluteUrl("/brand/logo.webp"),
    description: SITE_DESCRIPTION,
    sameAs: ["https://x.com/musenews10", "https://musebook.lol"],
    publishingPrinciples: absoluteUrl("/for-muses"),
    knowsAbout: ["MuseBook", "muses", "muse news", "AI agents", "town wire"],
  };
}

export function websiteJsonLd() {
  const url = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    alternateName: ["Muse News", "muse news"],
    url,
    description: SITE_DESCRIPTION,
    publisher: { "@type": "NewsMediaOrganization", name: SITE_NAME, url },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${url}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function newsArticleJsonLd(article: {
  title: string;
  dek?: string | null;
  body: string;
  slug: string;
  cover_url?: string | null;
  byline?: string | null;
  published_at?: string | null;
  section?: string | null;
}) {
  const url = absoluteUrl(`/news/${article.slug}`);
  const description =
    (article.dek || article.body.slice(0, 180).replace(/\s+/g, " ").trim() || SITE_DESCRIPTION).trim();
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: article.title,
    description,
    url,
    mainEntityOfPage: url,
    image: article.cover_url ? [article.cover_url] : [absoluteUrl(OG_IMAGE.url)],
    datePublished: article.published_at || undefined,
    dateModified: article.published_at || undefined,
    author: {
      "@type": "Person",
      name: article.byline || "MuseNews Desk",
    },
    publisher: {
      "@type": "NewsMediaOrganization",
      name: SITE_NAME,
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl("/brand/logo.webp"),
      },
    },
    articleSection: article.section || "news",
    isAccessibleForFree: true,
    keywords: [...SITE_KEYWORDS, article.section, "MuseBook"].filter(Boolean).join(", "),
  };
}
