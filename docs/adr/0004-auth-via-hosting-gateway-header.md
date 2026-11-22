# ADR-0004: Identify owners via the hosting gateway's authenticated-email header

**Date**: 2026-10-01 (backfilled 2026-11-16 from code at `5d136af`)
**Status**: accepted
**Deciders**: project owner (inferred from code)

## Context

Captures are personal (photos of homes and belongings) and must be visible only to their owner. The app is deployed behind a hosting gateway that authenticates users and adds `oai-authenticated-user-email` to each request. Building our own sign-in would cost more than the rest of v1.

## Decision

The API scopes every capture to the email in the gateway header. Requests without the header are rejected. `LOCAL_DEV="true"` substitutes a fixed identity, but only for requests to localhost. Mutating requests also reject cross-origin `Origin` headers.

## Alternatives Considered

### Own auth (Cloudflare Access, Clerk, Auth.js)
- **Pros**: portable across hosts; supports sharing with guests.
- **Cons**: another vendor or session store; more UI to build.
- **Why not**: unnecessary while the gateway already authenticates.

## Consequences

### Positive
- No passwords, sessions, or user table to secure.

### Negative
- The app is coupled to one gateway, and the email is the owner key, so a changed email loses access to existing captures.
- Anonymous share links (PRD R5.4) will need a separate token mechanism (ADR-0010).

### Risks
- If the Worker is ever reachable without the gateway, the header can be forged. Mitigation: only accept traffic routed through the gateway, and keep `LOCAL_DEV` restricted to localhost.
