import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/", destination: "/crisis.html" }];
  },
  poweredByHeader: false,
};

export default nextConfig;
