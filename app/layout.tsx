// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";
import ClientShell from "@/app/components/ClientShell";
import OfflineOverlay from "@/app/components/OfflineOverlay";
import { Providers } from "@/app/components/Providers";

const inter = { className: "font-sans" };

export async function generateMetadata(): Promise<Metadata> {
  // Use environment variables only, no server-side fetch during build
  return {
    title: process.env.NEXT_PUBLIC_APP_NAME || "CODEWITH-VIVEK",
    description: "CODEWITH-VIVEK ~ Learn, Code, Grow",
    manifest: "/manifest.json",
    authors: [
      { name: "VIVEK", url: "https://t.me/VS_ONHUNT" },
    ],
    creator: "CODEWITH-VIVEK",
    icons: {
      icon: "/favicon.ico",
      apple: "/logo.png",
    },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Don't fetch server info on the server - let client handle it
  // This avoids server-side MongoDB connection issues during initial render
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} antialiased`}>
        <Providers>
          <OfflineOverlay />
          <ClientShell>{children}</ClientShell>
        </Providers>
      </body>
    </html>
  );
}
