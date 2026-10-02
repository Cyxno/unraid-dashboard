# Private HTTPS with Tailscale

Run Beacon entirely inside your tailnet — never exposed to the public
internet — while still getting the HTTPS secure context that browser
notifications, Web Push and installed PWAs require.

```
iPhone / Ubuntu / laptop
        │
        │ Tailscale (private, identity-aware)
        ▼
https://<machine>.<tailnet>.ts.net
        │  Tailscale Serve (reverse proxy, TLS termination)
        ▼
http://127.0.0.1:8090
        ▼
Beacon
```

## Why this architecture

- **Beacon stays private.** Nothing is port-forwarded, no public reverse
  proxy, no tunnel to the internet. Access is restricted by Tailscale
  identity and your ACLs.
- **HTTPS secure context for free.** Browser notifications, Web Push and
  installed PWAs require a secure context; Tailscale Serve provides a
  real TLS certificate for your machine's `ts.net` name.
- **No extra proxy layer.** Tailscale Serve proxies straight to Beacon —
  Nginx Proxy Manager (or any other reverse proxy) is not needed unless
  you already share other services through one.
- **Streaming works.** Beacon's live updates use server-sent events and
  are served with proxy-friendly headers (`cache-control: no-store`,
  `x-accel-buffering: no`); Tailscale Serve passes them through without
  special configuration.

## Requirements

- Tailscale installed on the Unraid host (and on the devices you want to
  use Beacon from).
- **MagicDNS** enabled for the tailnet.
- **HTTPS Certificates** enabled (admin console → DNS → HTTPS
  Certificates). Tailscale provisions a certificate for the machine's
  `<machine>.<tailnet>.ts.net` name automatically on first use.
- Beacon running and reachable at `127.0.0.1:8090` (the default with
  host networking).

## Enable Serve

One command on the Unraid host:

```sh
tailscale serve --bg localhost:8090
```

`--bg` runs it in the background and **persists across reboots** — Serve
configuration is stored in the Tailscale daemon state and resumes
automatically after `tailscale down`/`up` or a host reboot. No boot
script is needed.

## Verify

```sh
tailscale serve status        # shows the configured proxy
tailscale serve status --json # machine-readable
```

Then open Beacon from any tailnet device:

```
https://<machine>.<tailnet>.ts.net
```

Confirm it is a secure context: the browser shows the padlock, and the
notification diagnostic (dev console) reports `secureContext: true`.
Settings → Notifications should now offer *Enable notifications* instead
of the "requires HTTPS" state.

## Tailscale Serve vs Tailscale Funnel

| | Reachable from | Use for Beacon |
| --- | --- | --- |
| `tailscale serve` | your tailnet only | ✅ **yes — this is the documented setup** |
| `tailscale funnel` | the public internet | ❌ never needed for Beacon |

Double-check you used `serve`, not `funnel`: Funnel publishes the
service to the whole internet (behind Tailscale's edge). Beacon requires
no public exposure for any feature — push delivery comes from the
browser's own push service, not from an inbound connection.

## HTTPS certificate notes

Tailscale provisions TLS certificates under your tailnet's `ts.net`
name. Like all web certificates, these names appear in public
Certificate Transparency logs — so your **hostname** is technically
discoverable. The **service itself is not**: nothing listens publicly,
and access remains restricted by Tailscale authentication and your
ACLs. Avoid a sensitive machine name if this bothers you.

## iPhone / iPad PWA migration

Browser permissions, service workers, push subscriptions and installed
PWAs are **origin-bound**. If you previously installed Beacon from an
HTTP origin (`http://<ip>:8090`), that PWA is a different origin from
the new HTTPS one — reinstall from the new address:

1. Update Beacon to v1.2.0 or later.
2. Ensure Tailscale is active on the iPhone.
3. Open `https://<machine>.<tailnet>.ts.net` in Safari.
4. Remove the old home-screen icon (if installed from the HTTP origin).
5. Share → **Add to Home Screen** from the HTTPS origin.
6. Open the new PWA → Settings → Notifications → **Enable
   notifications** (permission is requested from this explicit click).
7. **Send test notification** → confirm delivery.
8. Fully close the PWA (swipe away), reopen, and send the test again —
   this proves push works with no tab open.

Step 4–5 matter because the old HTTP origin can never gain push
support; everything must live on the HTTPS origin.

## Desktop (Firefox / Chrome / Edge)

Use `https://<machine>.<tailnet>.ts.net` from now on instead of
`http://<lan-ip>:8090`. Verify in the browser console (dev builds):

```js
window.isSecureContext            // true
Notification.permission           // "default" | "granted" | "denied"
"PushManager" in window           // true
"serviceWorker" in navigator      // true
```

Then Settings → Notifications → Enable notifications → Send test
notification.

## Notifications (VAPID)

Web Push needs no public hosting and no inbound firewall rule: the
browser's push service delivers messages **to the device**; Beacon only
needs to be reachable by the device when subscribing. Configure the
VAPID keys (see [INSTALL.md](INSTALL.md#9-optional-push-notifications-vapid)):

```sh
npx web-push generate-vapid-keys
```

- One keypair **per Beacon installation** (not per device).
- Keep the private key server-side and back it up with your
  configuration (container env / Unraid template).
- Changing the keys later invalidates existing subscriptions — devices
  simply re-enable from Settings → Notifications.
- Private key: set it in the container environment only; never commit
  it anywhere.

## Restrict access further (ACLs / grants)

By default, Serve is reachable from your tailnet. To limit Beacon to
specific users or devices, use Tailscale **grants** (the currently
recommended policy form) to allow only TCP/443 to the Beacon host for a
trusted group:

```json
{
  "grants": [
    {
      "src": ["group:beacon-users"],
      "dst": ["tag:beacon-host"],
      "ip": ["tcp/443"]
    }
  ]
}
```

Tag the Unraid host (`tag:beacon-host`) and put your trusted devices in
`group:beacon-users` in the same policy file. Everything else in the
tailnet loses access to the Serve endpoint. The classic ACL equivalent
is `dst: ["tag:beacon-host:443"]`.

## Optional: reduce LAN exposure

Beacon's container uses host networking and listens on **all
interfaces** (`PORT=8090`), so direct LAN access on
`http://<unraid-ip>:8090` keeps working alongside Tailscale Serve. That
is the documented default and is fine on a trusted LAN.

If you prefer Beacon to be reachable **only** through the tailnet:

- Keep the container as-is (binding to loopback only is not configurable
  in host-networking mode without changing the image), and
- restrict TCP 8090 with a host firewall (Unraid `iptables` / your
  existing firewall chain) to loopback plus the interfaces you trust.

This is a hardening choice, not a requirement. Either way, all writes
stay guarded, confirmed and audited.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Settings → Notifications says "requires HTTPS" | You are on an HTTP origin. Use the `https://…ts.net` address. |
| "home-screen install required" on iPhone | Push only works in the installed PWA: Share → Add to Home Screen from the HTTPS origin. |
| "blocked" badge in browser | The browser (or its global setting / a private window) denies notifications — check the padlock icon → Notifications and the browser's notification settings. |
| Enable button does nothing / keeps asking | Firefox requires a user gesture: always start from the Enable button itself, not a reload. |
| Old PWA shows old data / no notifications | It belongs to the old HTTP origin — remove it and reinstall from the HTTPS origin. |
| `tailscale serve status` empty after reboot | Serve with `--bg` (persisted); plain foreground Serve does not survive. |
| Live updates stall | Confirm `tailscale serve status` is active and you are on the tailnet; Beacon's SSE headers are already proxy-friendly. |
| Tailscale offline on a device | Push subscriptions still exist, but delivery requires the device's push service connectivity; the PWA also needs the tailnet to reach Beacon at all. |
