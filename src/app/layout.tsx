import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { AppearanceProvider, APPEARANCE_PREPAINT_SCRIPT } from "@/lib/appearance";

export const metadata: Metadata = {
  title: {
    default: "Beacon",
    template: "%s · Beacon",
  },
  description: "Beacon — self-hosted control center for an Unraid server.",
  applicationName: "Beacon",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Beacon",
    statusBarStyle: "black-translucent",
  },
  icons: {
    // ?v= cache-buster (v0.9.7): iOS caches home-screen icons by URL very
    // aggressively; a version bump is the only reliable way to push a new
    // icon out (existing installs may still need remove/re-add once).
    icon: [
      { url: "/favicon-96.png?v=2", type: "image/png", sizes: "96x96" },
      { url: "/icons/icon-192.png?v=2", type: "image/png", sizes: "192x192" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png?v=2", sizes: "180x180" },
      { url: "/apple-touch-icon.png?v=2", sizes: "180x180" },
    ],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  // Appearance-aware chrome colors; dark stays the default experience.
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#161619" },
    { media: "(prefers-color-scheme: light)", color: "#f7f7f8" },
  ],
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover exposes env(safe-area-inset-*) for notched iPhones
  // in standalone mode; safe areas are consumed by the shell and bottom nav.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Pre-paint appearance: no theme flash on reload/navigation. */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_PREPAINT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <AppearanceProvider>
          <AppShell>{children}</AppShell>
        </AppearanceProvider>
      </body>
    </html>
  );
}
