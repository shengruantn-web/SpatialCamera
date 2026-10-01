import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const captures = sqliteTable("captures", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("uploading"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  imageCount: integer("image_count").notNull(),
  error: text("error"),
  lease: text("lease"),
  resultBytes: integer("result_bytes"),
});
export const images = sqliteTable("images", {
  id: text("id").primaryKey(),
  captureId: text("capture_id").notNull(),
  name: text("name").notNull(),
  bytes: integer("bytes").notNull(),
  mime: text("mime").notNull(),
  uploaded: integer("uploaded").notNull().default(0),
});
export const workerHealth = sqliteTable("worker_health", {
  id: text("id").primaryKey(),
  lastSeen: integer("last_seen").notNull(),
});
