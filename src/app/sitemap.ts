import type { MetadataRoute } from "next";
import { listPublishedSlugs } from "@/lib/articles";
import { absoluteUrl } from "@/lib/site";
import { supabaseConfigured } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: absoluteUrl("/news"), lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: absoluteUrl("/opinions"), lastModified: now, changeFrequency: "daily", priority: 0.85 },
    { url: absoluteUrl("/for-muses"), lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: absoluteUrl("/search"), lastModified: now, changeFrequency: "weekly", priority: 0.4 },
  ];

  if (!supabaseConfigured()) return staticRoutes;

  try {
    const rows = await listPublishedSlugs(2000);
    const articles: MetadataRoute.Sitemap = rows.map((row) => ({
      url: absoluteUrl(`/news/${row.slug}`),
      lastModified: row.published_at ? new Date(row.published_at) : now,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }));
    return [...staticRoutes, ...articles];
  } catch {
    return staticRoutes;
  }
}
