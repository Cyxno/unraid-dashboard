import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

/**
 * Appearance system (v0.9.0): pure-function coverage with stubbed browser
 * globals (localStorage, documentElement.dataset, matchMedia). The provider
 * component itself is thin React wiring around these functions.
 */

/* --- minimal browser stubs ------------------------------------------------ */

class LocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const localStorageStub = new LocalStorageStub();
const dataset: Record<string, string> = {};
let customProps: Record<string, string> = {};
let systemDark = true;

Object.assign(globalThis, {
  window: {
    localStorage: localStorageStub,
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? systemDark : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  document: {
    documentElement: {
      get dataset() {
        return dataset;
      },
      set dataset(value) {
        Object.assign(dataset, value);
      },
      style: {
        setProperty: (key: string, value: string) => {
          customProps[key] = value;
        },
        removeProperty: (key: string) => {
          delete customProps[key];
        },
      },
    },
  },
});

import { normalizeAppearance, loadAppearance, saveAppearance, resolveTheme, applyAppearance, DEFAULT_APPEARANCE } from "../src/lib/appearance";

beforeEach(() => {
  localStorageStub.removeItem("beacon.appearance.v1");
  for (const key of Object.keys(dataset)) delete dataset[key];
  customProps = {};
  systemDark = true;
});

describe("v0.9.0 appearance persistence + migration", () => {
  it("defaults: Beacon Dark, emerald, comfortable, full motion", () => {
    assert.deepEqual(loadAppearance(), DEFAULT_APPEARANCE);
    assert.equal(DEFAULT_APPEARANCE.theme, "dark");
    assert.equal(DEFAULT_APPEARANCE.density, "comfortable");
    assert.equal(DEFAULT_APPEARANCE.motion, "full");
  });

  it("round-trips a saved appearance", () => {
    const saved = { theme: "ocean", accent: "violet", accentHex: null, density: "compact", motion: "reduced" };
    saveAppearance(saved as never);
    assert.deepEqual(loadAppearance(), saved);
  });

  it("migrates invalid/legacy payloads to defaults (never crashes)", () => {
    assert.equal(normalizeAppearance(null).theme, "dark");
    assert.equal(normalizeAppearance("junk").theme, "dark");
    assert.equal(normalizeAppearance({ theme: "neon-vaporwave" }).theme, "dark");
    assert.equal(normalizeAppearance({ accent: "hot-pink" }).accent, "emerald");
    assert.equal(normalizeAppearance({ density: "dense" }).density, "comfortable");
    assert.equal(normalizeAppearance({ motion: "cinematic" }).motion, "full");
  });

  it("invalid custom hex falls back safely; valid hex is kept for custom accent", () => {
    assert.equal(normalizeAppearance({ accent: "custom", accentHex: "red" }).accentHex, "#22c55e");
    assert.equal(normalizeAppearance({ accent: "custom", accentHex: "#a855f7" }).accentHex, "#a855f7");
    assert.equal(normalizeAppearance({ accent: "emerald", accentHex: "#a855f7" }).accentHex, null);
  });
});

describe("v0.9.0 system theme resolution", () => {
  it("system follows prefers-color-scheme; explicit themes pass through", () => {
    systemDark = true;
    assert.equal(resolveTheme("system", true), "dark");
    systemDark = false;
    assert.equal(resolveTheme("system", false), "light");
    assert.equal(resolveTheme("midnight", true), "midnight");
    assert.equal(resolveTheme("light", false), "light");
  });
});

describe("v0.9.0 application via data-attributes", () => {
  it("applies theme/accent/density/motion to <html>", () => {
    applyAppearance({ theme: "ocean", accent: "violet", accentHex: null, density: "compact", motion: "reduced" }, true);
    assert.equal(dataset.theme, "ocean");
    assert.equal(dataset.accent, "violet");
    assert.equal(dataset.density, "compact");
    assert.equal(dataset.motion, "reduced");
  });

  it("custom accent sets the --accent-custom property", () => {
    applyAppearance({ theme: "dark", accent: "custom", accentHex: "#ff7700", density: "comfortable", motion: "full" }, true);
    assert.equal(dataset.accent, "custom");
    assert.equal(customProps["--accent-custom"], "#ff7700");
  });

  it("non-custom accent clears the custom property", () => {
    customProps["--accent-custom"] = "#ff7700";
    applyAppearance({ theme: "dark", accent: "emerald", accentHex: null, density: "comfortable", motion: "full" }, true);
    assert.equal(dataset.accent, "emerald");
    assert.ok(!("--accent-custom" in customProps));
  });

  it("system theme resolves at application time", () => {
    systemDark = false;
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: "system" }, false);
    assert.equal(dataset.theme, "light");
  });
});
