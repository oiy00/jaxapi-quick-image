import type { HistoryRecord, HistoryReference } from "./types";

/**
 * Reference images are kept with each history record so a past run can be reviewed.
 * They live only in this browser's IndexedDB, never on the server. To keep the
 * 40-record history small, each copy is re-encoded with its long edge capped here.
 * Re-encoding through a canvas also drops EXIF data such as GPS location.
 */
export const SNAPSHOT_LONG_EDGE = 1600;
export const SNAPSHOT_QUALITY = 0.85;
/** Originals at or under this size are kept as-is when the browser cannot re-encode them. */
export const SNAPSHOT_RAW_FALLBACK_BYTES = 2 * 1024 * 1024;

export function snapshotDimensions(width: number, height: number, longEdge = SNAPSHOT_LONG_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= longEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = longEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Attempts to save a record from the fullest form to the leanest. The result images
 * matter more than the references, so references are dropped first.
 */
export function persistAttempts(record: HistoryRecord): HistoryRecord[] {
  const attempts: HistoryRecord[] = [record];
  if (record.references && record.references.length > 0) {
    attempts.push({ ...record, references: [], referencesDropped: true });
  }
  if (record.images.length > 0 || (record.references && record.references.length > 0)) {
    attempts.push({
      ...record,
      images: [],
      references: [],
      referencesDropped: Boolean(record.referenceCount),
      error: [record.error, "图片太大，未能保存在这台浏览器。"].filter(Boolean).join(" "),
    });
  }
  return attempts;
}

/** Browser only. Returns null when the file cannot be decoded and is too large to keep raw. */
export async function snapshotReference(file: File): Promise<HistoryReference | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const size = snapshotDimensions(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await encode(canvas, "image/webp").catch(() => encode(canvas, "image/jpeg"));
      return { blob, mime: blob.type || "image/webp", name: file.name, width: size.width, height: size.height };
    } finally {
      bitmap.close();
    }
  } catch {
    if (file.size > SNAPSHOT_RAW_FALLBACK_BYTES) return null;
    return { blob: file, mime: file.type || "image/png", name: file.name };
  }
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // Safari returns PNG when it cannot write WebP; accept anything but an empty result.
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error("encode failed"));
      },
      type,
      SNAPSHOT_QUALITY,
    );
  });
}
