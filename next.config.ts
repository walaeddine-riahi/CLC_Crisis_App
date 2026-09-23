import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/service-worker.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
  async rewrites() {
    return [{ source: "/", destination: "/crisis.html" }];
  },
  poweredByHeader: false,
};

export default nextConfig;
