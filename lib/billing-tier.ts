import type { ImageResolution } from "./types";

/** Mirrors Sub2API v0.2.24 ClassifyImageBillingTier. */
export function classifyImageBillingTier(size: string): ImageResolution | null {
  const trimmed = size.trim();
  const normalized = trimmed.toLowerCase();
  switch (normalized) {
    case "":
    case "auto":
      return null;
    case "1k":
      return "1K";
    case "2k":
      return "2K";
    case "4k":
      return "4K";
    case "2048x2048":
    case "2048x1152":
      return "2K";
    case "3840x2160":
    case "2160x3840":
      return "4K";
    default:
      break;
  }
  const parts = normalized.split("x");
  if (parts.length !== 2) return null;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  const maxEdge = Math.max(width, height);
  if (maxEdge <= 1024) return "1K";
  if (maxEdge <= 2048) return "2K";
  return "4K";
}
