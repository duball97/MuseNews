export function siteUrl() {
  const fromEnv = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/$/, "");
  let base = fromEnv;
  if (!base) {
    if (process.env.VERCEL_ENV === "production") base = "https://www.musenews.lol";
    else if (process.env.VERCEL_URL) base = `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
    else base = "https://www.musenews.lol";
  }
  // Apex musenews.lol 308s → www. Telegram (and some bots) refuse OG images that redirect.
  return base.replace(/^https?:\/\/musenews\.lol$/i, "https://www.musenews.lol");
}

export function absoluteUrl(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path.replace(/^https?:\/\/musenews\.lol(?=\/|$)/i, "https://www.musenews.lol");
  }
  const base = siteUrl();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
