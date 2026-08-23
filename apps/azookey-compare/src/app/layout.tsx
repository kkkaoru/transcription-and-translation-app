// This file runs with bun.
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kotoba Beacon Cloudflare Pipeline",
  description: "Verify Nova-3, Vibrato, and AzooKey in one Cloudflare Worker audio pipeline.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
