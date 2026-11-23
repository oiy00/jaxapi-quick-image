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
};

export type RunView =
  | { status: "idle" }
  | { status: "pending"; startedAt: number; mode: "generate" | "edit" }
  | { status: "error"; message: string; timeout?: boolean }
  | {
      status: "success";
      images: { url: string; name: string }[];
      revisedPrompt?: string;
      costUsd: number | null;
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
