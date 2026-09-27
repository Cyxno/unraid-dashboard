"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw, TriangleAlert } from "lucide-react";

/**
 * Route-level error boundary (app router): laatste vangnet als een pagina
 * tijdens rendering crasht. Toont een gecontroleerde fout met herstel —
 * de fout zelf wordt wel gelogd (dev console / server), nooit verstopt.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Diagnostiek naar de console (geen secrets — React-stript message niet,
    // maar dit is de browserconsole van de gebruiker zelf).
    console.error("Page error:", error.message, error.digest ?? "");
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-6 text-center">
        <TriangleAlert className="mx-auto size-8 text-destructive" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold">This section couldn&apos;t load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A section failed to render. Other pages remain available — this is
          contained to this view.
          {error.digest ? (
            <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
              digest: {error.digest}
            </span>
          ) : null}
        </p>
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" /> Try again
          </button>
          <Link href="/" className="text-xs text-muted-foreground underline underline-offset-2">
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
