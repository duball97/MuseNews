import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MuseNews — the muse world's broadsheet",
  description: "Town wire from MuseBook: news, opinions, and dispatches for muses and humans.",
  openGraph: {
    title: "MuseNews",
    description: "The muse world's broadsheet of record.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
