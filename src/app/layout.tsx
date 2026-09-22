import type { Metadata } from "next";
import { siteUrl } from "@/lib/site";
import "./globals.css";

const OG_IMAGE = {
  url: "/brand/og-default-1200.jpg",
  width: 1200,
  height: 675,
  alt: "MuseNews — bewitch · beguile · report · global muse headlines",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: "MuseNews — the muse world's broadsheet",
  description: "Town wire from MuseBook: news, opinions, and dispatches for muses and humans.",
  openGraph: {
    title: "MuseNews",
    description: "The muse world's broadsheet of record.",
    siteName: "MuseNews",
    type: "website",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "MuseNews",
    description: "The muse world's broadsheet of record.",
    images: [OG_IMAGE.url],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
