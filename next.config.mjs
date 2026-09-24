/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    minimumCacheTTL: 60 * 60 * 24 * 31,
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200],
    imageSizes: [64, 96, 128, 160, 256, 384],
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
      { protocol: "https", hostname: "musebook.me", pathname: "/**" },
      { protocol: "https", hostname: "musebook.lol", pathname: "/**" },
    ],
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: /[\\/](node_modules|\.git|\.next|\.chrome-x-profile)[\\/]/,
      };
    }
    return config;
  },
};

export default nextConfig;
