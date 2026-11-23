import { defaultDuration, videoSpec, videoTierLabel } from "./video-models.ts";

export type VideoJobStatus = "queued" | "in_progress" | "completed" | "failed" | string;

export type VideoJob = {
  id: string;
  status: VideoJobStatus;
  progress: number | null;
  model?: string;
  seconds?: number;
  size?: string;
  error?: string | null;
  url?: string | null;
  raw: Record<string, unknown>;
};

/**
 * Unverified draft kept only so tests can show it is not sent.
 * Pixel size, seconds, and tier_label are guesses. The app does not POST this body.
 */
export function createVideoPayload(input: { model: string; prompt: string; duration: number }): Record<string, unknown> {
  const spec = videoSpec(input.model);
  if (!spec) throw new Error(`未知视频模型：${input.model}`);
  const duration = spec.durations.includes(input.duration) ? input.duration : defaultDuration(spec.id);
  return {
    unverified: true,
    model: spec.id,
    prompt: input.prompt,
    seconds: duration,
    duration,
    resolution: spec.resolution,
    tier_label: videoTierLabel(spec.id, duration),
  };
}

export function parseVideoJob(payload: unknown): VideoJob | null {
  const record = unwrapRecord(payload);
  if (!record) return null;
  const id = firstString(record, ["id", "video_id", "request_id", "task_id", "job_id"]);
  const status = firstString(record, ["status", "state"]) ?? inferStatus(record);
  const url = firstVideoUrl(record);
  if (!id && !url) return null;
  const seconds = firstNumber(record, ["seconds", "duration", "duration_seconds"]);
  return {
    id: id ?? "",
    status: (status ?? (url ? "completed" : "queued")) as VideoJobStatus,
    progress: firstNumber(record, ["progress", "percent"]),
    model: firstString(record, ["model"]) ?? undefined,
    seconds: seconds ?? undefined,
    size: firstString(record, ["size", "resolution"]) ?? undefined,
    error: firstString(record, ["error", "message"]) ?? errorFromObject(record.error) ?? undefined,
    url,
    raw: record,
  };
}

export function isVideoJobTerminal(job: VideoJob): boolean {
  const status = job.status.toLowerCase();
  return status === "completed" || status === "failed" || status === "error" || status === "cancelled" || status === "canceled" || Boolean(job.url);
}

export function isVideoJobFailed(job: VideoJob): boolean {
  const status = job.status.toLowerCase();
  return status === "failed" || status === "error" || status === "cancelled" || status === "canceled";
}

export function videoStatusPath(job: VideoJob): string | null {
  if (!job.id) return null;
  if (job.id.includes("/")) return null;
  return `/v1/videos/${job.id}`;
}

export function videoContentPath(job: VideoJob): string | null {
  if (!job.id) return null;
  if (job.id.includes("/")) return null;
  return `/v1/videos/${job.id}/content`;
}

function unwrapRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }
  if (Array.isArray(record.data) && record.data[0] && typeof record.data[0] === "object") {
    return record.data[0] as Record<string, unknown>;
  }
  return record;
}

function inferStatus(record: Record<string, unknown>): string | null {
  if (firstVideoUrl(record)) return "completed";
  return null;
}

function firstVideoUrl(record: Record<string, unknown>): string | null {
  const direct = firstString(record, ["url", "video_url", "content_url"]);
  if (direct) return direct;
  const video = record.video;
  if (video && typeof video === "object") {
    const url = firstString(video as Record<string, unknown>, ["url", "video_url"]);
    if (url) return url;
  }
  const output = record.output;
  if (output && typeof output === "object") {
    const url = firstString(output as Record<string, unknown>, ["url"]);
    if (url) return url;
  }
  return null;
}

function errorFromObject(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value && "message" in value && typeof (value as { message: unknown }).message === "string") {
    return (value as { message: string }).message;
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}
