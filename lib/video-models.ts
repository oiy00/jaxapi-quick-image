import type { VideoModelId } from "./types";

export type VideoResolution = "720p" | "768p" | "2k";

export type VideoModelSpec = {
  id: VideoModelId;
  label: string;
  resolution: VideoResolution;
  /** Allowed clip lengths in seconds. */
  durations: number[];
  /** Configured absolute customer sell price in USD per request. Do not multiply again. */
  prices: Record<number, number>;
};

const MINIMAX_BASE = {
  durations: [5, 10, 15],
  resolution: "768p" as const,
};

/** Seventeen video models for a group named 媒体台. The live assignment is group 11, but code matches the name. Image models must not appear here. */
export const VIDEO_MODELS: VideoModelSpec[] = [
  {
    id: "video-ray",
    label: "video-ray",
    resolution: "720p",
    durations: [10],
    prices: { 10: 0.6 },
  },
  {
    id: "muse-video",
    label: "muse-video",
    resolution: "720p",
    durations: [10, 20, 30, 60],
    prices: { 10: 1.2, 20: 2.4, 30: 3.6, 60: 7.2 },
  },
  {
    id: "DB-SD-2.0-Fast",
    label: "DB-SD-2.0-Fast",
    resolution: "720p",
    durations: [15],
    prices: { 15: 6 },
  },
  {
    id: "JL-minimax-video-h3-2k",
    label: "JL-minimax-video-h3-2k",
    resolution: "2k",
    durations: [10, 15],
    prices: { 10: 6, 15: 6 },
  },
  {
    id: "seedance2.5-V",
    label: "seedance2.5-V",
    resolution: "720p",
    durations: [30],
    prices: { 30: 22.8 },
  },
  { id: "minimax-h3-base-fast", label: "minimax-h3-base-fast", ...MINIMAX_BASE, prices: { 5: 0.3, 10: 0.6, 15: 0.9 } },
  { id: "minimax-h3-base-standard", label: "minimax-h3-base-standard", ...MINIMAX_BASE, prices: { 5: 0.45, 10: 0.9, 15: 1.35 } },
  { id: "minimax-h3-base-enhanced", label: "minimax-h3-base-enhanced", ...MINIMAX_BASE, prices: { 5: 0.9, 10: 1.8, 15: 2.7 } },
  { id: "minimax-h3-base-quality", label: "minimax-h3-base-quality", ...MINIMAX_BASE, prices: { 5: 1.2, 10: 2.4, 15: 3.6 } },
  { id: "minimax-h3-cinematic-fast", label: "minimax-h3-cinematic-fast", ...MINIMAX_BASE, prices: { 5: 0.3, 10: 0.6, 15: 0.9 } },
  { id: "minimax-h3-cinematic-standard", label: "minimax-h3-cinematic-standard", ...MINIMAX_BASE, prices: { 5: 0.45, 10: 0.9, 15: 1.35 } },
  { id: "minimax-h3-cinematic-enhanced", label: "minimax-h3-cinematic-enhanced", ...MINIMAX_BASE, prices: { 5: 0.9, 10: 1.8, 15: 2.7 } },
  { id: "minimax-h3-cinematic-quality", label: "minimax-h3-cinematic-quality", ...MINIMAX_BASE, prices: { 5: 1.2, 10: 2.4, 15: 3.6 } },
  { id: "minimax-h3-origin-fast", label: "minimax-h3-origin-fast", ...MINIMAX_BASE, prices: { 5: 0.45, 10: 0.9, 15: 1.35 } },
  { id: "minimax-h3-origin-standard", label: "minimax-h3-origin-standard", ...MINIMAX_BASE, prices: { 5: 0.75, 10: 1.5, 15: 2.25 } },
  { id: "minimax-h3-origin-enhanced", label: "minimax-h3-origin-enhanced", ...MINIMAX_BASE, prices: { 5: 1.2, 10: 2.4, 15: 3.6 } },
  { id: "minimax-h3-origin-quality", label: "minimax-h3-origin-quality", ...MINIMAX_BASE, prices: { 5: 1.5, 10: 3.0, 15: 4.5 } },
];

export const DEFAULT_VIDEO_MODEL: VideoModelId = "muse-video";

/**
 * Pixel size sent as SuperGPT `size`.
 * 768p must be the MiniMax H3 16:9 size 1344x768. 1366x768 is rejected upstream.
 * 720p and 2k use the configured sizes below; 2k was not re-verified in this change.
 */
export const VIDEO_PIXEL_SIZE: Record<VideoResolution, string> = {
  "720p": "1280x720",
  "768p": "1344x768",
  "2k": "2560x1440",
};

/**
 * Saved probes that actually finished.
 * muse-video 10s and minimax-h3-base-fast 10s completed.
 * video-ray never completed. Other priced rows stay visible but cannot be submitted.
 */
export const VERIFIED_VIDEO_REQUESTS: { id: VideoModelId; duration: number }[] = [
  { id: "muse-video", duration: 10 },
  { id: "minimax-h3-base-fast", duration: 10 },
];

export function isVerifiedVideoRequest(model: string, duration: number): boolean {
  return VERIFIED_VIDEO_REQUESTS.some((item) => item.id === model && item.duration === duration);
}

export function isVideoModelId(value: string): value is VideoModelId {
  return VIDEO_MODELS.some((item) => item.id === value);
}

export function videoSpec(id: string): VideoModelSpec | undefined {
  return VIDEO_MODELS.find((item) => item.id === id);
}

export function durationsFor(id: string): number[] {
  return videoSpec(id)?.durations ?? [];
}

export function defaultDuration(id: string): number {
  return durationsFor(id)[0] ?? 10;
}

/** SuperGPT plaza / group model_pricing tier label, e.g. "15秒 / 720p". */
export function videoTierLabel(id: string, duration: number): string | null {
  const spec = videoSpec(id);
  if (!spec || !spec.durations.includes(duration)) return null;
  return `${duration}秒 / ${spec.resolution}`;
}
