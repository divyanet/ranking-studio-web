import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ranking Studio Web - Free Ranking Video Maker (Top 3-10 Countdowns)",
  description:
    "Make ranking countdown videos in your browser. Add Top 3-10 clips, style the title with 32 text presets, trim, add music and export MP4 or WebM. No watermark, no account, nothing is uploaded - everything runs on your device.",
  keywords: ["ranking video maker", "top 10 countdown maker", "ranking studio", "shorts ranking editor"],
  robots: { index: true, follow: true },
  openGraph: {
    title: "Ranking Studio Web - Free Ranking Video Maker",
    description: "Top 3-10 ranking countdown videos, made and exported 100% in your browser. No watermark, no uploads.",
    type: "website",
  },
};

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Anton&family=Bangers&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;700&family=Montserrat:wght@500;700;800&display=swap";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={FONTS_HREF} rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
