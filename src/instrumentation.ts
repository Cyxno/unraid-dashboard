/**
 * Next.js instrumentation: runs once when the server process boots (and
 * again per server runtime in dev). Used to start the notification
 * evaluation loop without depending on anyone visiting an API route —
 * otherwise push delivery and history silently require a Settings visit.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startNotificationLoop } = await import("@/server/notifications");
    startNotificationLoop();
  } catch (error) {
    // Never block server startup on the notification system.
    console.warn(
      "[notifications] evaluation loop not started:",
      error instanceof Error ? error.message : error,
    );
  }
}
