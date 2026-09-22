export function siteUrl() {
  const fromEnv = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  // Prefer the public domain over ephemeral *.vercel.app hosts for OG/share links.
  if (process.env.VERCEL_ENV === "production") return "https://musenews.lol";
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
  return "https://musenews.lol";
}

export function absoluteUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = siteUrl();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
