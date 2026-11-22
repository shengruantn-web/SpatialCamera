# ADR-0010: Opt-in, revocable share links for captures

**Date**: 2026-11-16
**Status**: accepted (2026-11-22)
**Deciders**: project owner (accepted 2026-11-22)

## Context

Captures are private by default (ADR-0004), but sharing and embedding are the main way splats spread. The gateway header cannot identify anonymous viewers, and photos of homes are sensitive.

## Decision

The owner can create a share token: 128 random bits, stored hashed in a `shares` table with `capture_id`, `created_at` and `revoked_at`. `/s/:token` serves a read-only viewer page and the SPZ result, but never the source photos or the PLY unless the owner enables it. Revoking a link takes effect immediately. Embeds use the same token in an iframe.

## Alternatives Considered

### Make the capture public with a flag
- **Pros**: simplest.
- **Cons**: capture IDs end up in URLs; cannot revoke one link without revoking all.
- **Why not**: tokens allow several independent, revocable links.

### Signed, expiring R2 URLs only
- **Pros**: no table.
- **Cons**: no viewer page or embed; links expire whether or not the owner wants them to.
- **Why not**: doesn't cover embeds.

## Consequences

### Positive
- Sharing without accounts; revocable; the same mechanism serves embeds and WebXR.

### Negative
- A public route needs rate limiting and caching rules.

### Risks
- Leaked links. Mitigation: show view counts and make revoking easy; never expose source photos by default.
- Gateway exposure. Opening `/s/*` to anonymous traffic must not open `/api/*` or the owner pages: the gateway's anonymous rule must match `/s/*` only. The gateway must also strip or overwrite `oai-authenticated-user-email` on every request, anonymous ones included, so a visitor cannot send an owner's address and be treated as that owner (ADR-0004). The share routes never read the header, but they run in the same Worker as `/api/*`.
- Rate limiting is best effort: an in-memory, per-isolate window keyed on `CF-Connecting-IP`. A request without that header is not limited (the first one per isolate logs a warning) instead of sharing one "unknown" bucket that a single client could exhaust for everyone; Cloudflare's edge always sets it, so its absence means the request bypassed the edge. Production should put a Workers Rate Limiting binding or a WAF rate-limiting rule on `/s/*`, and the gateway must forward a trustworthy client IP: if it replaces it with its own address, all visitors share one budget.
- Links come back to life. A link pauses (404) while its capture is not `ready`, and works again, showing the new result, when a resubmitted capture returns to `ready`. This is deliberate: reprocessing usually improves a scene the owner has already shared. An owner who does not want the new result shared revokes the links first; the Share panel says so. Revoking on resubmit was considered and not done.
