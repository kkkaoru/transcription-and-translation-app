import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AzooKey Compare",
  description: "Compare Web Speech recognition with an asynchronous AzooKey Worker result.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
