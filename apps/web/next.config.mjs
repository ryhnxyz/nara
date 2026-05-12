/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@nara-bot/core"],
  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
