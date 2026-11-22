# Architecture Decision Records

ADRs 0001–0006 were **backfilled** on 2026-11-16 from the code at commit `5d136af`. Their deciders and rationale are inferred and should be confirmed by the project owner. ADRs 0007–0010 are proposals from the 2026-11-16 review.

Use [template.md](template.md) for new records.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-pull-based-gpu-worker-with-leases.md) | Pull-based GPU worker with leased jobs | accepted (backfilled) | 2026-10-01 |
| [0002](0002-cloudflare-workers-d1-r2.md) | Host on Cloudflare Workers with D1 and R2 | accepted (backfilled) | 2026-10-01 |
| [0003](0003-two-reconstruction-backends.md) | Two reconstruction backends: Nerfstudio and pycolmap + Brush | accepted (backfilled) | 2026-10-01 |
| [0004](0004-auth-via-hosting-gateway-header.md) | Identify owners via the hosting gateway header | accepted (backfilled) | 2026-10-01 |
| [0005](0005-never-fake-progress.md) | Show only real processing state | accepted (backfilled) | 2026-10-01 |
| [0006](0006-ply-as-delivery-format.md) | Deliver results as uncompressed Gaussian PLY | accepted (backfilled); superseded for viewing by 0007's SPZ (S5), PLY kept as archive | 2026-10-01 |
| [0007](0007-spz-and-lod-delivery.md) | Deliver SPZ with progressive LOD | SPZ implemented (S5, pending acceptance); LOD proposed | 2026-11-16 |
| [0008](0008-feed-forward-preview-tier.md) | Feed-forward preview tier | accepted 2026-11-22 (licence gate before use) | 2026-11-16 |
| [0009](0009-video-input-with-frame-selection.md) | Video input with worker-side frame selection | accepted 2026-11-22 | 2026-11-16 |
| [0010](0010-opt-in-share-links.md) | Opt-in, revocable share links | accepted 2026-11-22 | 2026-11-16 |
