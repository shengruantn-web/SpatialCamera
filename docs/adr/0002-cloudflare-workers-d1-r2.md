# ADR-0002: Host on Cloudflare Workers with D1 and R2

**Date**: 2026-10-01 (backfilled 2026-11-16 from code at `5d136af`)
**Status**: accepted
**Deciders**: project owner (inferred from code)

## Context

The app needs a UI, a small JSON API, relational state for captures and images, and blob storage for up to 1 GB of photos plus a result of up to 90 MB per capture. Traffic is low and bursty. Egress costs matter because splats are large and are viewed repeatedly.

## Decision

We use vinext (Next 16 on Vite) deployed as a Cloudflare Worker. State lives in D1 (SQLite) through Drizzle, and photos and results live in R2.

## Alternatives Considered

### Vercel/Next.js + Postgres + S3
- **Pros**: mainstream tooling; no Workers runtime limits.
- **Cons**: S3 egress fees on large splats; three vendors.
- **Why not**: R2's zero egress fees suit repeated viewing of 10–90 MB files.

### Single VPS (Node + SQLite + disk)
- **Pros**: simplest to understand; no request-size limits.
- **Cons**: you operate it yourself; no edge caching; backups are manual.
- **Why not**: more operational work for a side project.

## Consequences

### Positive
- No egress fees for results; the platform handles global caching and TLS.
- Miniflare gives realistic local integration tests.

### Negative
- Workers request bodies and CPU time are limited. Uploads go one image per request, and results are capped at 90 MB.
- D1 runs one writer per database, and every query is a network round trip.

### Risks
- Large results or video input may outgrow request-body limits. Mitigation: R2 multipart or presigned uploads when needed.
