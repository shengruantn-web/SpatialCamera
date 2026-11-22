# ADR-0009: Accept video input and select frames on the worker

**Date**: 2026-11-16
**Status**: accepted (2026-11-22)
**Deciders**: project owner (accepted 2026-11-22)

## Context

Taking 50–200 well-overlapped photos is the hardest step for casual users. Phone video naturally gives dense overlap, but uploading every frame is wasteful and blurry frames hurt alignment. Workers request bodies are limited (ADR-0002).

## Decision

Users can upload one video (MP4/MOV, length and size caps to be decided). The browser uploads it to R2 via multipart. The worker extracts frames with ffmpeg. It keeps the sharpest frame per window (variance of Laplacian), drops near-duplicates, and targets 100–200 frames before alignment.

## Alternatives Considered

### Extract frames in the browser (WebCodecs)
- **Pros**: smaller upload; reuses the photo pipeline unchanged.
- **Cons**: codec support varies, especially for HEVC on non-Apple browsers; heavy on phones.
- **Why not**: worker-side extraction is more reliable. Browser-side extraction can be added later for previews.

## Consequences

### Positive
- Much easier capture; denser coverage; better alignment rate.

### Negative
- Larger uploads; needs R2 multipart support and a new `source_kind` on captures.
- Rolling shutter and motion blur still need guidance in the UI.

### Risks
- Storage cost of keeping the source video. Mitigation: delete the video after frame extraction unless the user opts to keep it (PRD open question 3).
