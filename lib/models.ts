import type { ImageModelId, ImageResolution } from "./types";

export const MODELS: {
  id: ImageModelId;
  label: string;
  qualities: string[];
  resolutions: ImageResolution[];
}[] = [
  {
    id: "gpt-image-2",
    label: "gpt-image-2",
    qualities: ["auto", "low", "medium", "high"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "gpt-image-2.5-flare",
    label: "gpt-image-2.5-flare",
    qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "gpt-image-2.5-sunburst",
    label: "gpt-image-2.5-sunburst",
    qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "gpt-image-2.6-flare",
    label: "gpt-image-2.6-flare",
    qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "gpt-image-2.6-sunburst",
    label: "gpt-image-2.6-sunburst",
    qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "gemini-3-pro-image",
    label: "gemini-3-pro-image",
    qualities: ["auto"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "gemini-3.1-flash-image",
    label: "gemini-3.1-flash-image",
    qualities: ["auto"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "gemini-nano-banana-2.1",
    label: "gemini-nano-banana-2.1",
    qualities: ["auto"],
    resolutions: ["1K", "2K", "4K"],
  },
  {
    id: "firefly-gpt-image-2",
    label: "firefly-gpt-image-2",
    qualities: ["auto"],
    resolutions: ["1K", "2K"],
  },
];

export const RESOLUTIONS: ImageResolution[] = ["1K", "2K", "4K"];

export const ASPECTS = ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5"] as const;

export type AspectId = (typeof ASPECTS)[number];

/**
 * Pixel sizes are divisible by 16 (gpt-image-2 requirement) and land in the
 * Sub2API billing tier of the same name: long edge ≤1024 is 1K, ≤2048 is 2K,
 * otherwise 4K. 4K stays within the documented 3840 edge.
 */
export const PIXEL_SIZES: Record<ImageResolution, Record<AspectId, string>> = {
  "1K": {
    "1:1": "1024x1024",
    "16:9": "1024x576",
    "9:16": "576x1024",
    "3:2": "1008x672",
    "2:3": "672x1008",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "5:4": "960x768",
    "4:5": "768x960",
  },
  "2K": {
    "1:1": "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2": "2016x1344",
    "2:3": "1344x2016",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "5:4": "1920x1536",
    "4:5": "1536x1920",
  },
  "4K": {
    "1:1": "2560x2560",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "3:2": "3072x2048",
    "2:3": "2048x3072",
    "4:3": "3072x2304",
    "3:4": "2304x3072",
    "5:4": "2560x2048",
    "4:5": "2048x2560",
  },
};

export const DEFAULT_MODEL: ImageModelId = "gpt-image-2";
export const DEFAULT_RESOLUTION: ImageResolution = "1K";
export const DEFAULT_ASPECT: AspectId = "1:1";
export const DEFAULT_QUALITY = "auto";
/** SuperGPT upstream is unreliable with n; the page always generates one image. */
export const FIXED_COUNT = 1;
export const MAX_COUNT = 1;

export function isImageModelId(value: string): value is ImageModelId {
  return MODELS.some((item) => item.id === value);
}

export function isAspect(value: string): value is AspectId {
  return (ASPECTS as readonly string[]).includes(value);
}

export function pixelSize(resolution: ImageResolution, aspect: string): string {
  const ratio = isAspect(aspect) ? aspect : DEFAULT_ASPECT;
  return PIXEL_SIZES[resolution][ratio];
}

export function qualitiesFor(model: ImageModelId): string[] {
  return MODELS.find((item) => item.id === model)?.qualities ?? ["auto"];
}

export function resolutionsFor(model: ImageModelId): ImageResolution[] {
  return MODELS.find((item) => item.id === model)?.resolutions ?? [...RESOLUTIONS];
}

export function aspectValue(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  if (!w || !h) return 1;
  return w / h;
}
