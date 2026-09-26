"use client";

import { useEffect, useState } from "react";

/**
 * Debounces a fast-changing value (e.g. search input) so expensive
 * filter/sort passes run at most once per delay. Light debounce only:
 * at current scale filtering is already instant; this keeps it instant
 * at 10x scale without adding perceptible latency.
 */
export function useDebouncedValue<T>(value: T, delayMs = 150): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
