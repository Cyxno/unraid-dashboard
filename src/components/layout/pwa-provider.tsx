"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * PWA runtime state, provided once per app:
 * - service worker registration + pending-update signal (controlled refresh)
 * - online/offline state (drives the offline banner and write-action block)
 * - standalone/installed detection (iOS + display-mode)
 * - install prompt availability (beforeinstallprompt), never auto-prompted
 */

export type SwState = "unsupported" | "registering" | "ready" | "error";
export type PwaInstallState = "prompt-available" | "installed" | "ios" | "unsupported" | "desktop-unsupported";

interface PwaContextValue {
  sw: SwState;
  /** True when a newly installed worker is waiting to activate. */
  updateReady: boolean;
  /** Activates the waiting worker and reloads (user-initiated only). */
  applyUpdate: () => void;
  online: boolean;
  standalone: boolean;
  install: PwaInstallState;
  /** Presents the native install dialog; null when unavailable. */
  promptInstall: (() => void) | null;
}

const PwaContext = createContext<PwaContextValue>({
  sw: "registering",
  updateReady: false,
  applyUpdate: () => {},
  online: true,
  standalone: false,
  install: "unsupported",
  promptInstall: null,
});

export function usePwa(): PwaContextValue {
  return useContext(PwaContext);
}

function detectStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function detectIos(): boolean {
  const ua = window.navigator.userAgent;
  const isIosDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ masquerades as desktop Safari.
  const isIpadOs =
    ua.includes("Macintosh") && (window.navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints === 5;
  return isIosDevice || isIpadOs;
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const [sw, setSw] = useState<SwState>("registering");
  const [updateReady, setUpdateReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [standalone, setStandalone] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<{ prompt: () => Promise<void> } | null>(null);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    // Browser-only state must sync post-hydration to match SSR output.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStandalone(detectStandalone());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsIos(detectIos());

    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    const onDisplayMode = () => setStandalone(detectStandalone());
    window.matchMedia("(display-mode: standalone)").addEventListener("change", onDisplayMode);

    const onInstallPrompt = (event: Event) => {
      // Capture the prompt; never call it automatically.
      event.preventDefault();
      setInstallPrompt(event as Event & { prompt: () => Promise<void> });
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // Register the service worker (production builds only — no SW in dev).
    let registration: ServiceWorkerRegistration | null = null;
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          registration = reg;
          setSw("ready");
          const notifyWaiting = () => {
            if (reg.waiting && navigator.serviceWorker.controller) {
              setUpdateReady(true);
            }
          };
          notifyWaiting();
          reg.addEventListener("updatefound", () => {
            const installing = reg.installing;
            installing?.addEventListener("statechange", () => {
              if (installing.state === "installed" && navigator.serviceWorker.controller) {
                // A controller exists → this is an update, not the first install.
                setUpdateReady(true);
              }
            });
          });
        })
        .catch(() => setSw("error"));
    } else {
      setSw("unsupported");
    }

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.matchMedia("(display-mode: standalone)").removeEventListener("change", onDisplayMode);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    // Tell the waiting worker to activate; reload once it controls the page.
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      const waiting = registrations.find((reg) => reg.waiting)?.waiting;
      if (waiting) {
        waiting.postMessage("SKIP_WAITING");
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.location.reload();
        }, { once: true });
        // Safety: if activation stalls, reload anyway after a grace period.
        setTimeout(() => window.location.reload(), 4000);
      } else {
        window.location.reload();
      }
    });
  }, []);

  const promptInstall = useMemo(() => {
    if (!installPrompt) return null;
    return () => {
      void installPrompt.prompt();
    };
  }, [installPrompt]);

  const install: PwaInstallState = standalone
    ? "installed"
    : installPrompt
      ? "prompt-available"
      : isIos
        ? "ios"
        : "desktop-unsupported";

  const value = useMemo(
    () => ({ sw, updateReady, applyUpdate, online, standalone, install, promptInstall }),
    [sw, updateReady, applyUpdate, online, standalone, install, promptInstall],
  );

  return <PwaContext.Provider value={value}>{children}</PwaContext.Provider>;
}
