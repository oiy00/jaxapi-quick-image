import type { ImageModelId, ImageResolution } from "./types";
import { videoSpec } from "./video-models.ts";

/**
 * 媒体台绝对售价（美元 / 张）= 上游成本（SuperGPT 标价 × 1.5）× 2。
 * 预估与 Sub2API 分组 model_pricing 对齐，不再乘个人/分组倍率。
 */
export const MEDIA_IMAGE_PRICES: Record<string, Partial<Record<ImageResolution, number>>> = {
  "gpt-image-2": { "1K": 0.09, "2K": 0.12, "4K": 0.15 },
  "gpt-image-2.5-flare": { "1K": 0.09, "2K": 0.12, "4K": 0.15 },
  "gpt-image-2.5-sunburst": { "1K": 0.09, "2K": 0.12, "4K": 0.15 },
  "gemini-3.1-flash-image": { "1K": 0.09, "2K": 0.12, "4K": 0.15 },
  "gemini-nano-banana-2.1": { "1K": 0.09, "2K": 0.12, "4K": 0.15 },
  "firefly-gpt-image-2": { "1K": 0.09, "2K": 0.12 },
  "gemini-3-pro-image": { "1K": 0.15, "2K": 0.15, "4K": 0.15 },
  "gpt-image-2.6-flare": { "1K": 0.12, "2K": 0.18, "4K": 0.24 },
  "gpt-image-2.6-sunburst": { "1K": 0.12, "2K": 0.18, "4K": 0.24 },
  "gpt-image-2.5-flare-fb": { "1K": 0.09, "2K": 0.09, "4K": 0.09 },
  "gpt-image-2.5-sunburst-fb": { "1K": 0.09, "2K": 0.09, "4K": 0.09 },
  "gemini-3.1-flash-lite-image": { "1K": 0.09 },
};

export type PriceSource = "table";

export type ImageEstimate = {
  unitUsd: number;
  totalUsd: number;
  multiplier: number;
  source: PriceSource;
  resolution: ImageResolution;
  count: number;
  model: string;
};

export function mediaUnitPrice(model: string, resolution: ImageResolution): number | null {
  const price = MEDIA_IMAGE_PRICES[model]?.[resolution];
  if (typeof price === "number" && Number.isFinite(price) && price >= 0) return price;
  return null;
}

export function estimateImageCost(input: {
  model: string;
  resolution: ImageResolution;
  count?: number;
}): ImageEstimate | null {
  const count = Math.max(1, Math.floor(input.count || 1));
  const unit = mediaUnitPrice(input.model, input.resolution);
  if (unit == null) return null;
  return {
    unitUsd: unit,
    totalUsd: unit * count,
    multiplier: 1,
    source: "table",
    resolution: input.resolution,
    count,
    model: input.model,
  };
}

export function chargeFromBalance(before: number | null, after: number | null): number | null {
  if (before == null || after == null) return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  const delta = before - after;
  if (delta < -0.0000001) return null;
  return Math.round(delta * 1e6) / 1e6;
}

// Keep the type import used so model IDs stay aligned with the selector.
export type { ImageModelId };

export type VideoEstimate = {
  unitUsd: number;
  totalUsd: number;
  multiplier: number;
  source: "table";
  model: string;
  duration: number;
  resolution: string;
  tierLabel: string;
};

export function estimateVideoCost(input: { model: string; duration: number }): VideoEstimate | null {
  const spec = videoSpec(input.model);
  if (!spec) return null;
  const price = spec.prices[input.duration];
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  return {
    unitUsd: price,
    totalUsd: price,
    multiplier: 1,
    source: "table",
    model: spec.id,
    duration: input.duration,
    resolution: spec.resolution,
    tierLabel: `${input.duration}秒 / ${spec.resolution}`,
  };
}
