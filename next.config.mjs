/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Cover URLs are immutable (timestamped paths) — keep optimized variants warm on the CDN.
    minimumCacheTTL: 60 * 60 * 24 * 31,
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200],
    imageSizes: [64, 96, 128, 160, 256, 384],
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
      { protocol: "https", hostname: "musebook.lol", pathname: "/**" },
    ],
  },
};

export default nextConfig;
