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
};

export default nextConfig;
