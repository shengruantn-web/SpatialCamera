import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const captures = sqliteTable("captures", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("uploading"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  imageCount: integer("image_count").notNull(),
  // Maintained on every image upload so list/detail reads need no per-row COUNT.
  uploadedCount: integer("uploaded_count").notNull().default(0),
  error: text("error"),
  lease: text("lease"),
  resultBytes: integer("result_bytes"),
  // R2 key of the published PLY (`{id}/attempts/{leaseHash}/result.{nonce}.ply`; `…/result.ply` before 0003). NULL on legacy rows → `{id}/result.ply`.
  resultKey: text("result_key"),
  // Size of the attempt's SPZ. Recorded with `spz_key` by the SPZ PUT while exporting and published with
  // the PLY; served only once `ready`. NULL when the attempt delivered only a PLY (older workers, failed
  // conversion) and on legacy rows.
  spzBytes: integer("spz_bytes"),
  // R2 key of that SPZ (`{id}/attempts/{leaseHash}/result.{nonce}.spz`, one per PUT, never rewritten).
  // NULL with a non-NULL spz_bytes only on rows published before 0003 → `{attempt}/result.spz`.
  spzKey: text("spz_key"),
  // 1 from the first claim until the cron has removed every unpublished object under `{id}/attempts/`.
  gcPending: integer("gc_pending").notNull().default(0),
  // Per-stage entry times (ms since epoch) for the current attempt; reset on resubmit.
  queuedAt: integer("queued_at"),
  aligningAt: integer("aligning_at"),
  trainingAt: integer("training_at"),
  exportingAt: integer("exporting_at"),
  readyAt: integer("ready_at"),
  failedAt: integer("failed_at"),
  // Fraction of frames registered by alignment (0..1), reported by the worker.
  alignmentRatio: real("alignment_ratio"),
  // S10 (ADR-0009): 'photos' (image_count images rows) or 'video' (one MP4/MOV; frames are extracted by
  // the GPU worker, so image_count stays 0 and there are no images rows).
  sourceKind: text("source_kind").notNull().default("photos"),
  // R2 key of the source video (`{id}/video/{nonce}.mp4|mov`), fixed at create. NULL for photo captures and
  // once the video has been deleted after a published result (unless keep_video).
  videoKey: text("video_key"),
  // R2 multipart upload id while a video upload is in flight; NULL before start and after complete/abort.
  videoUploadId: text("video_upload_id"),
  // Declared size and type of the source video, frozen at create.
  videoBytes: integer("video_bytes"),
  videoMime: text("video_mime"),
  // 1 once the multipart upload completed with exactly video_bytes bytes.
  videoUploaded: integer("video_uploaded").notNull().default(0),
  // Owner opt-in: 1 keeps the source video after the splat is published.
  keepVideo: integer("keep_video").notNull().default(0),
}, (t) => [
  index("captures_owner_created_idx").on(t.owner, t.createdAt),
  index("captures_status_created_idx").on(t.status, t.createdAt),
  index("captures_status_updated_idx").on(t.status, t.updatedAt),
  index("captures_gc_pending_idx").on(t.gcPending, t.updatedAt),
]);
export const images = sqliteTable("images", {
  id: text("id").primaryKey(),
  captureId: text("capture_id").notNull(),
  name: text("name").notNull(),
  bytes: integer("bytes").notNull(),
  mime: text("mime").notNull(),
  uploaded: integer("uploaded").notNull().default(0),
  // R2 key of the accepted upload (`{captureId}/uploads/{imageId}/{nonce}`). NULL on legacy rows → `{captureId}/images/{imageId}`.
  objectKey: text("object_key"),
}, (t) => [
  index("images_capture_uploaded_idx").on(t.captureId, t.uploaded),
]);
export const workerHealth = sqliteTable("worker_health", {
  id: text("id").primaryKey(),
  lastSeen: integer("last_seen").notNull(),
});
// S8 (ADR-0010): read-only share links. The token is a bearer secret shown to the owner once; only its
// SHA-256 is stored, so a database leak does not reveal live links. Deleting a capture deletes its links.
export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  captureId: text("capture_id").notNull().references(() => captures.id, { onDelete: "cascade" }),
  // Lowercase hex SHA-256 of the 128-bit token; the public routes look links up by this.
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  // Set once by revoke; a revoked link is never served again.
  revokedAt: integer("revoked_at"),
  // Page loads (share page and embed), not scene or download requests.
  views: integer("views").notNull().default(0),
  // Owner opt-in: 1 lets viewers download the full PLY.
  allowDownload: integer("allow_download").notNull().default(0),
}, (t) => [
  uniqueIndex("shares_token_hash_idx").on(t.tokenHash),
  index("shares_capture_created_idx").on(t.captureId, t.createdAt),
]);
