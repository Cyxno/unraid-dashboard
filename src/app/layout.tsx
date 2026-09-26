import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";

export const metadata: Metadata = {
  title: {
    default: "Unraid Dashboard",
    template: "%s · Unraid Dashboard",
  },
  description: "Self-hosted dashboard for an Unraid server.",
  applicationName: "Unraid Dashboard",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Unraid Dashboard",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/favicon-96.png", type: "image/png", sizes: "96x96" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  // Dark-first palette (see globals.css); both variants are dark so the
  // browser chrome never flashes light.
  themeColor: "#1c1c22",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover exposes env(safe-area-inset-*) for notched iPhones
  // in standalone mode; safe areas are consumed by the shell and bottom nav.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
