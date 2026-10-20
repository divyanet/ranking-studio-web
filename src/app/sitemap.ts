import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://rankingstudio.example.com/",
      lastModified: new Date("2026-10-21"),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
