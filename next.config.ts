import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SSE streams must not be buffered by gzip
  compress: false,
};

export default nextConfig;
