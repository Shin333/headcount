import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Headcount - CEO View",
  description: "The world's first AI company you can lurk on.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink-50 text-ink-900 antialiased">{children}</body>
    </html>
  );
}
