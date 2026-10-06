import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: { proxyTimeout: 180000 },
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://127.0.0.1:4001/api/:path*" }];
  },
};

export default nextConfig;
