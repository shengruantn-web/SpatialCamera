# ADR-0001: Pull-based GPU worker with leased jobs

**Date**: 2026-10-01 (backfilled 2026-11-16 from code at `5d136af`)
**Status**: accepted
**Deciders**: project owner (inferred from code)

## Context

Gaussian splat training needs a CUDA or Apple Silicon GPU for 10–60 minutes per capture. The web app runs on Cloudflare Workers, which cannot run long GPU jobs. The GPU machine is often a workstation behind NAT and without a public address, and may be offline.

## Decision

A separate Python worker polls `POST /api/worker/claim`, and the oldest `queued` capture is claimed atomically with `UPDATE … RETURNING`. Each claim issues a random lease. Every later call must send that lease in `X-Job-Lease`. The worker sends a heartbeat every 25 s, and a job with no update for 10 minutes becomes a retryable `failed`. Workers authenticate with one shared bearer `WORKER_TOKEN` of at least 32 characters.

## Alternatives Considered

### Push to a serverless GPU endpoint (RunPod, Modal, Replicate)
- **Pros**: no machine to operate; scales to zero.
- **Cons**: paid per job; needs a public callback and provider credentials; harder to run locally.
- **Why not**: conflicts with "bring your own compute" (PRD §3). A push adapter can still be added later behind the same state machine.

### Cloudflare Queues consumer
- **Pros**: managed retries and dead-letter queues.
- **Cons**: the consumer must be a Worker or call out over HTTP anyway, and the GPU box still has to pull.
- **Why not**: adds a moving part without removing the poll.

## Consequences

### Positive
- Works behind NAT; any machine with the token can join.
- Leases fence stale workers out of status changes.
- The protocol is small enough to test with Miniflare.

### Negative
- Idle polling every 10 s costs requests, and each poll currently also runs DDL and a sweep (spec D8).
- A single shared token gives no per-worker identity or revocation.

### Risks
- Lease fencing covers status changes but not the R2 result key (spec D3). Mitigation: per-attempt object keys (spec T2).
- If the heartbeat stops before upload, a finished splat can be lost (spec D1). Mitigation: spec T1.
