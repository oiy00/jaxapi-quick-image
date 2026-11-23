export type ImageResolution = "1K" | "2K" | "4K";

export type ImageModelId =
  | "gpt-image-2"
  | "gpt-image-2.5-flare"
  | "gpt-image-2.5-sunburst"
  | "gpt-image-2.6-flare"
  | "gpt-image-2.6-sunburst"
  | "gemini-3-pro-image"
  | "gemini-3.1-flash-image"
  | "gemini-nano-banana-2.1"
  | "firefly-gpt-image-2";


export type VideoModelId =
  | "video-ray"
  | "muse-video"
  | "DB-SD-2.0-Fast"
  | "JL-minimax-video-h3-2k"
  | "seedance2.5-V"
  | "minimax-h3-base-fast"
  | "minimax-h3-base-standard"
  | "minimax-h3-base-enhanced"
  | "minimax-h3-base-quality"
  | "minimax-h3-cinematic-fast"
  | "minimax-h3-cinematic-standard"
  | "minimax-h3-cinematic-enhanced"
  | "minimax-h3-cinematic-quality"
  | "minimax-h3-origin-fast"
  | "minimax-h3-origin-standard"
  | "minimax-h3-origin-enhanced"
  | "minimax-h3-origin-quality";

export type RunStatus = "pending" | "succeeded" | "failed" | "timeout";

export type GroupPlatform = "openai" | "grok" | "composite" | "anthropic" | "gemini" | string;

export type ApiGroup = {
  id: number;
  name: string;
  platform?: GroupPlatform;
  status?: "active" | "inactive" | string;
  rate_multiplier?: number;
  allow_image_generation?: boolean;
  image_rate_independent?: boolean;
  image_rate_multiplier?: number;
  image_price_1k?: number | null;
  image_price_2k?: number | null;
  image_price_4k?: number | null;
  peak_rate_enabled?: boolean;
};

export type ApiKeyRecord = {
  id: number;
  name: string;
  key: string;
  group_id: number | null;
  status: string;
  expires_at?: string | null;
  group?: ApiGroup | null;
};

export type PublicUser = {
  id: number;
  email: string;
  username?: string;
  balance: number;
  frozen_balance?: number;
};

export type StoredSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  user: PublicUser;
  source?: "host" | "local";
};

export type BillingInfo = {
  group_rate_multiplier?: number;
  resolved_rate_multiplier?: number;
  effective_rate_multiplier?: number;
  billing_scope?: string;
};

export type UsageNumbers = Record<string, number>;

export type HistoryImage = {
  blob?: Blob;
  mime: string;
  remoteUrl?: string;
};

export type HistoryRecord = {
  id: string;
  userId: number;
  createdAt: string;
  prompt: string;
  model: ImageModelId;
  resolution: ImageResolution;
  aspect: string;
  size: string;
  quality: string;
  count: number;
  mode: "generate" | "edit";
  status: RunStatus;
  error?: string;
  estimateUsd: number | null;
  costUsd: number | null;
  balanceAfter: number | null;
  usage: UsageNumbers | null;
  images: HistoryImage[];
};

export type PublicSettings = {
  site_name?: string;
  site_subtitle?: string;
  version?: string;
  turnstile_enabled?: boolean;
  tencent_captcha_enabled?: boolean;
  aliyun_captcha_enabled?: boolean;
  totp_enabled?: boolean;
  login_agreement_enabled?: boolean;
  registration_enabled?: boolean;
  password_reset_enabled?: boolean;
};
