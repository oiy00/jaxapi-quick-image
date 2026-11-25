import type { ImageModelId, ImageResolution, RunStatus, UsageNumbers } from "@/lib/types";

export type Draft = {
  prompt: string;
  model: ImageModelId;
  resolution: ImageResolution;
  aspect: string;
  quality: string;
  count: number;
};

export type HistoryCard = {
  id: string;
  createdAt: string;
  prompt: string;
  model: string;
  size: string;
  status: RunStatus;
  thumbUrl?: string;
  /** Reference images the run carried (0 for text-to-image). */
  referenceCount?: number;
};

export type ReferenceView = { id: string; name: string; url: string; width?: number; height?: number };

/** A past run shown read-only. The draft is kept separately and is never overwritten by viewing. */
export type ViewingRecord = {
  id: string;
  prompt: string;
  model: ImageModelId;
  resolution: ImageResolution;
  aspect: string;
  quality: string;
  estimateUsd: number | null;
  mode: "generate" | "edit";
  references: ReferenceView[];
  /** Count sent with the request; may exceed references.length for old records or when copies were dropped. */
  referenceCount: number;
  referencesDropped: boolean;
  /** This run is still waiting on the upstream; it cannot be deleted until it settles. */
  inFlight: boolean;
};

export type RunView =
  | { status: "idle" }
  | { status: "pending"; startedAt: number; mode: "generate" | "edit" }
  | { status: "error"; message: string; timeout?: boolean; uncertain?: boolean }
  | {
      status: "success";
      images: { url: string; name: string }[];
      revisedPrompt?: string;
      costUsd: number | null;
      costNote?: string;
      balanceAfter: number | null;
      usage: UsageNumbers | null;
      estimateUsd: number | null;
      size: string;
      model: string;
    };

export type EstimateView = {
  unitUsd: number;
  totalUsd: number;
  multiplier: number;
  source: "table";
  model?: string;
  resolution: ImageResolution;
  count: number;
};

export type KeyOption = {
  id: number;
  label: string;
};

export type ConnectionView =
  | { state: "loading" }
  | { state: "ready"; label: string }
  | { state: "blocked"; summary: string; details: string[] };
