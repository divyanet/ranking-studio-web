import type { NextConfig } from "next";

const isGhPages = process.env.GH_PAGES === "1";
const basePath = isGhPages ? "/ranking-studio-web" : "";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  ...(isGhPages ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
