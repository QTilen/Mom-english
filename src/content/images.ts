import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { db, nowIso } from "../db";
import { enqueue } from "../jobs/queue";

// Screenshots for picture lessons live in data/images on the Pi only. They are
// for private study and are never committed to the repository.

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function extensionFor(contentType: string): string | undefined {
  return EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()];
}

export function imagePath(filename: string): string {
  return path.join(config.imagesDir, path.basename(filename));
}

// Stores the picture and queues Claude to turn it into a lesson.
export function addImage(data: Buffer, ext: string, source: string | null): number {
  fs.mkdirSync(config.imagesDir, { recursive: true });
  const filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
  fs.writeFileSync(imagePath(filename), data);
  const info = db
    .prepare("INSERT INTO images (filename, source, status, created_at) VALUES (?, ?, 'pending', ?)")
    .run(filename, source, nowIso());
  const id = Number(info.lastInsertRowid);
  enqueue("picture_lesson", { imageId: id });
  return id;
}

export interface ImageRow {
  id: number;
  filename: string;
  source: string | null;
  status: string;
  exercise_ids_json: string | null;
  created_at: string;
}

export function getImage(id: number): ImageRow | undefined {
  return db.prepare("SELECT * FROM images WHERE id = ?").get(id) as ImageRow | undefined;
}

export function listImages(): ImageRow[] {
  return db.prepare("SELECT * FROM images ORDER BY id DESC").all() as ImageRow[];
}

export function deleteImage(id: number): void {
  const row = getImage(id);
  if (!row) return;
  // Exercises made from it stay in the bank but are never served again.
  const ids: number[] = row.exercise_ids_json ? JSON.parse(row.exercise_ids_json) : [];
  for (const exId of ids) db.prepare("UPDATE exercises SET source = 'retired' WHERE id = ?").run(exId);
  db.prepare("DELETE FROM images WHERE id = ?").run(id);
  fs.rmSync(imagePath(row.filename), { force: true });
}
