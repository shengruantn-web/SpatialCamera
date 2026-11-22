# ADR-0010: Opt-in, revocable share links for captures

**Date**: 2026-11-16
**Status**: proposed
**Deciders**: project owner (pending)

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
