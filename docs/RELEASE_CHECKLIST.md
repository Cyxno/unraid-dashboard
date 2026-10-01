# v1.0 release-blocker checklist

A release is blocked by ANY of:

- [ ] data-loss risk (persistence write that corrupts or loses prior state)
- [ ] broken persistence migration (old data unreadable after upgrade)
- [ ] broken rollback (previous version cannot boot/read state)
- [ ] auth/security regression (any matrix check off expected code)
- [ ] action safety failure (unconfirmed mutation, missing audit, wrong target)
- [ ] update/provenance failure (digest mismatch shipped, non-registry image)
- [ ] core page unusable (Overview/Docker/Storage/System render broken)
- [ ] persistent resource leak (monotonic RSS/FD growth at steady state)
- [ ] Agent API contract break (removed/repurposed endpoint or field)
- [ ] fatal mobile shell regression (content under nav, unusable sheets)
- [ ] unrecoverable corrupted state (no resilience-backup path)

NOT blockers (documented limitations, tracked in docs/ROADMAP.md):

- no native Docker restart (Unraid API limitation)
- iOS real-device QA pending operator hardware
- future widgets/integrations
- cosmetic polish without usability impact
