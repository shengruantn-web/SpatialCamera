# ADR-0009: Accept video input and select frames on the worker

**Date**: 2026-11-16
**Status**: accepted (2026-11-22); implemented in S10 (2026-11-23), with one deviation (retention, below)
**Deciders**: project owner (accepted 2026-11-22)

## Context

Taking 50–200 well-overlapped photos is the hardest step for casual users. Phone video naturally gives dense overlap, but uploading every frame is wasteful and blurry frames hurt alignment. Workers request bodies are limited (ADR-0002).

## Decision

Users can upload one video (MP4/MOV, length and size caps to be decided). The browser uploads it to R2 via multipart. The worker extracts frames with ffmpeg. It keeps the sharpest frame per window (variance of Laplacian), drops near-duplicates, and targets 100–200 frames before alignment.

## Implementation status (S10, 2026-11-23)

Implemented as decided, with these specifics (spec §7.11):

- **Caps.** One MP4 or MOV per capture, up to 1 GiB and 10 minutes. The browser uploads it through R2 multipart in 8 MiB parts (at most 128), three at a time, each part passing through the API (no presigned URLs). Migration `0005_video_source` adds `captures.source_kind` (`photos`/`video`) and the video columns; it is schema-only.
- **Selection.** The worker downloads the video and runs `gpu-worker/video_frames.py` as a stage. It uses ffprobe, then ffmpeg to decode up to 600 auto-rotated candidates, at most 1920 px on the long edge. Each candidate is scored by variance of the Laplacian and a 64-bit dHash. The script keeps the sharpest candidate in each window, drops picks below a fraction of the median sharpness, and drops near-duplicates of the previous pick. Stricter passes run first, which yields 100–200 frames when the clip allows it. The frames then go through the unchanged photo pipeline.
- **Abandoned uploads.** Restarting or deleting a capture aborts its open upload. R2's default 7-day lifecycle rule for incomplete multipart uploads is the backstop for anything not aborted, so production must keep it.
- **Shares (ADR-0010).** Share links never serve the video. Only the owner and the worker holding the lease can read it.

**Deviation: when the video is deleted.** This ADR says the video is deleted "after frame extraction". S10 deletes it when the capture is published (`ready`) instead, in the same attempt collection that removes leftover results (right after the result upload, otherwise by the 5-minute cron), unless the owner ticked "Keep the original video" at upload. A failed capture keeps its video, so a retry needs no new upload. Deleting at extraction would need a new worker-to-API call, and would force a fresh upload of up to 1 GB whenever alignment or training fails. The cost is that the video is stored for the length of processing plus at most one cron interval. The owner cannot change the keep choice after upload in this shipment.

**Not done.** The UI gives no guidance on rolling shutter or motion blur beyond "a slow, steady walk", and HDR (HLG/PQ) video is not tone-mapped before frames are extracted. Browser-side extraction for previews (the WebCodecs alternative below) is still possible later.

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
