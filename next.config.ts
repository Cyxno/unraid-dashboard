import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  // Produces a self-contained server bundle for the Docker runtime stage.
  output: "standalone",
  // Baked at build time as the fallback app version (used when APP_VERSION
  // is not provided at runtime). Not sensitive — exposed via /api/version.
  env: {
    APP_VERSION_FALLBACK: readPackageVersion(),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            // Next.js hydration + Recharts require inline scripts/styles;
            // everything else is self. No external origins are allowed.
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "connect-src 'self'",
              "font-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
