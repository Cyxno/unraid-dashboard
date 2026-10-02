/**
 * Browser push-support classification (pure, testable).
 *
 * Distinguishes the states users actually confuse:
 * - insecure context        → push APIs don't exist outside HTTPS
 * - unsupported browser     → no PushManager/service worker at all
 * - iOS needs install       → iPhone/iPad Safari only delivers push to
 *                             HOME-SCREEN web apps (iOS 16.4+); a plain
 *                             Safari tab must not show a broken
 *                             "Enable" button
 * - supported               → normal flow
 */

export interface PushSupportInput {
  hasNotificationApi: boolean;
  hasPushManager: boolean;
  hasServiceWorker: boolean;
  secureContext: boolean;
  isAppleMobile: boolean;
  standalone: boolean;
}

export type PushSupportKind =
  | "supported"
  | "insecure-context"
  | "unsupported-browser"
  | "ios-needs-install";

export interface PushSupport {
  kind: PushSupportKind;
  /** Home-screen/standalone (true on installed PWAs, false in tabs). */
  installed: boolean;
}

export function evaluatePushSupport(input: PushSupportInput): PushSupport {
  // The install signal: display-mode standalone, or iOS's navigator.standalone.
  const installed = input.standalone;
  if (!input.secureContext) return { kind: "insecure-context", installed };
  if (!input.hasServiceWorker || !input.hasPushManager || !input.hasNotificationApi) {
    // On Apple mobiles the push APIs only exist in the installed PWA —
    // their absence there means "install first", not "browser unsupported".
    if (input.isAppleMobile && !installed) return { kind: "ios-needs-install", installed };
    return { kind: "unsupported-browser", installed };
  }
  if (input.isAppleMobile && !installed) return { kind: "ios-needs-install", installed };
  return { kind: "supported", installed };
}

/** Stable, UA-based Apple-mobile detection (no better feature signal exists;
 *  combined with display-mode/standalone rather than trusted on its own). */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPod/.test(userAgent)) return true;
  // iPadOS 13+ masquerades as desktop Safari.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const navigatorStandalone = (navigator as { standalone?: boolean }).standalone === true;
  const displayMode = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  return navigatorStandalone || displayMode;
}
