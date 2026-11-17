import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Plain files in web/out, served by the FastAPI backend: one process, one origin.
  // The scaffold's cacheComponents/partialPrefetching are removed: they need a Next.js server.
  output: "export",
};

export default nextConfig;
