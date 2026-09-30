# Roadmap

Beacon is in a mature 0.9 series: the feature set is complete for its scope
and the focus is on real-device validation, hardening and documentation
quality. No dates are promised; items land when they are verified.

## In progress / known limitations

- **Docker restart** — the verified Unraid API exposes no restart mutation.
  Restart will ship only when the API gains it, or as an explicitly designed
  stop/start transaction with recovery semantics (not auto-emulated).
- **iOS real-device validation** — server-side PWA identity is complete and
  verified; the on-device checklist lives in [PWA.md](PWA.md) and needs real
  hardware.
- **VM power actions** — intentionally out of scope; VM state is read-only.
- **Agent API on-demand** — the read-only v1 machine API ships in the app but
  is disabled until the operator configures a token.

## Direction (unguaranteed)

- Broader thermal attribution (per-process/per-VM attribution where the
  metrics allow it, clearly labeled as estimates).
- Static hosted demo (currently: local demo mode via placeholder credentials).
- v1.0 stabilization: API/UX freeze, extended soak, packaging polish.
