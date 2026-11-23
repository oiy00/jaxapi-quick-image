import { jaxRequest } from "./jax-client";
import { AUTO_IMAGE_KEY_NAME, attachGroups, pickImageGroup } from "./keys";
export { AUTO_IMAGE_KEY_NAME };
import { toPublicUser } from "./session";
import type { ApiGroup, ApiKeyRecord, BillingInfo, PublicSettings, PublicUser, StoredSession } from "./types";

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  requires_2fa?: boolean;
  temp_token?: string;
  user_email_masked?: string;
  user?: unknown;
};

export type LoginResult =
  | { kind: "session"; session: StoredSession }
  | { kind: "totp"; tempToken: string; emailMasked?: string };

export async function loginWithPassword(email: string, password: string): Promise<LoginResult> {
  const data = await jaxRequest<TokenPayload>("/api/v1/auth/login", {
    json: { email, password },
    secrets: [password],
  });
  if (data.requires_2fa && data.temp_token) {
    return { kind: "totp", tempToken: data.temp_token, emailMasked: data.user_email_masked };
  }
  const session = sessionFromPayload(data);
  if (!session) throw new Error("登录响应缺少会话信息");
  return { kind: "session", session };
}

export async function loginWithTotp(tempToken: string, code: string): Promise<StoredSession> {
  const data = await jaxRequest<TokenPayload>("/api/v1/auth/login/2fa", {
    json: { temp_token: tempToken, totp_code: code },
    secrets: [tempToken],
  });
  const session = sessionFromPayload(data);
  if (!session) throw new Error("验证响应缺少会话信息");
  return session;
}

export async function refreshSession(session: StoredSession): Promise<StoredSession | null> {
  if (!session.refreshToken) return null;
  const data = await jaxRequest<TokenPayload>("/api/v1/auth/refresh", {
    json: { refresh_token: session.refreshToken },
    secrets: [session.accessToken, session.refreshToken],
  });
  if (!data.access_token) return null;
  const user = (await fetchMe(data.access_token)) ?? session.user;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    user,
    source: session.source,
  };
}

export async function fetchMe(token: string): Promise<PublicUser | null> {
  const data = await jaxRequest<unknown>("/api/v1/auth/me", {
    method: "GET",
    token,
    secrets: [token],
  });
  return toPublicUser(data);
}

export async function logoutSession(session: StoredSession): Promise<void> {
  if (!session.refreshToken) return;
  try {
    await jaxRequest("/api/v1/auth/logout", {
      json: { refresh_token: session.refreshToken },
      token: session.accessToken,
      secrets: [session.accessToken, session.refreshToken],
    });
  } catch {
    // Local sign-out still proceeds.
  }
}

export async function fetchPublicSettings(): Promise<PublicSettings> {
  return jaxRequest<PublicSettings>("/api/v1/settings/public", { method: "GET" });
}

export async function fetchImageKeys(token: string): Promise<ApiKeyRecord[]> {
  const keys: ApiKeyRecord[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await jaxRequest<unknown>(`/api/v1/keys?page=${page}&page_size=100`, {
      method: "GET",
      token,
      secrets: [token],
    });
    const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const items = Array.isArray(record.items) ? record.items : Array.isArray(data) ? data : [];
    keys.push(...items.map(asKey).filter((item): item is ApiKeyRecord => item !== null));
    const pages = Number(record.pages);
    if (!Number.isFinite(pages) || page >= pages || items.length === 0) break;
  }
  let groups: ApiGroup[] = [];
  try {
    const data = await jaxRequest<unknown>("/api/v1/groups/available", {
      method: "GET",
      token,
      secrets: [token],
    });
    const list = Array.isArray(data) ? data : [];
    groups = list.map(asGroup).filter((item): item is ApiGroup => item !== null);
  } catch {
    groups = [];
  }
  return attachGroups(keys, groups);
}

export async function fetchAvailableGroups(token: string): Promise<ApiGroup[]> {
  const data = await jaxRequest<unknown>("/api/v1/groups/available", {
    method: "GET",
    token,
    secrets: [token],
  });
  const list = Array.isArray(data) ? data : [];
  return list.map(asGroup).filter((item): item is ApiGroup => item !== null);
}

export async function createImageKey(token: string, groupId: number): Promise<ApiKeyRecord> {
  const data = await jaxRequest<unknown>("/api/v1/keys", {
    json: { name: AUTO_IMAGE_KEY_NAME, group_id: groupId },
    token,
    secrets: [token],
  });
  const record = asKey(data);
  if (!record) throw new Error("自动创建密钥失败，请稍后重试");
  return record;
}

export async function ensureImageKey(token: string, keys: ApiKeyRecord[], groups: ApiGroup[]): Promise<ApiKeyRecord[] | null> {
  const group = pickImageGroup(groups);
  if (!group) return null;
  const created = await createImageKey(token, group.id);
  return attachGroups([created, ...keys], groups);
}

export async function fetchGroupRates(token: string): Promise<unknown> {
  return jaxRequest("/api/v1/groups/rates", { method: "GET", token, secrets: [token] });
}

export async function requestImage(input: {
  apiKey: string;
  mode: "generate" | "edit";
  model: string;
  prompt: string;
  size: string;
  quality: string;
  count: number;
  file?: File;
}): Promise<unknown> {
  const path = input.mode === "edit" ? "/v1/images/edits" : "/v1/images/generations";
  const common = {
    token: input.apiKey,
    timeoutMs: 600_000,
    secrets: [input.apiKey],
  };
  if (input.file) {
    const form = new FormData();
    form.set("model", input.model);
    form.set("prompt", input.prompt);
    form.set("size", input.size);
    form.set("quality", input.quality);
    form.set("response_format", "b64_json");
    form.set("image", input.file, input.file.name);
    return jaxRequest(path, { ...common, form });
  }
  return jaxRequest(path, {
    ...common,
    json: {
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      response_format: "b64_json",
    },
  });
}


export function requestVideo(): Promise<never> {
  return Promise.reject(new Error("视频上游协议未验证，已禁止向中转站提交。"));
}

export function fetchVideoStatus(): Promise<never> {
  return Promise.reject(new Error("视频上游协议未验证，已禁止向中转站查询。"));
}

export async function fetchKeyBilling(apiKey: string): Promise<BillingInfo | null> {
  try {
    return await jaxRequest<BillingInfo>("/v1/sub2api/billing", {
      method: "GET",
      token: apiKey,
      secrets: [apiKey],
    });
  } catch {
    return null;
  }
}

function sessionFromPayload(data: TokenPayload): StoredSession | null {
  if (!data.access_token) return null;
  const user = toPublicUser(data.user);
  if (!user) return null;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    user,
  };
}

function asKey(input: unknown): ApiKeyRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = Number(record.id);
  if (!Number.isFinite(id)) return null;
  const groupId = record.group_id == null ? null : Number(record.group_id);
  return {
    id,
    name: typeof record.name === "string" ? record.name : "",
    key: typeof record.key === "string" ? record.key : "",
    group_id: Number.isFinite(groupId) ? groupId : null,
    status: typeof record.status === "string" ? record.status : "inactive",
    expires_at: typeof record.expires_at === "string" ? record.expires_at : null,
    group: asGroup(record.group),
  };
}

function asGroup(input: unknown): ApiGroup | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = Number(record.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    name: typeof record.name === "string" ? record.name : `分组 ${id}`,
    platform: typeof record.platform === "string" ? record.platform : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
    rate_multiplier: numberOrUndefined(record.rate_multiplier),
    allow_image_generation:
      typeof record.allow_image_generation === "boolean" ? record.allow_image_generation : undefined,
    image_rate_independent:
      typeof record.image_rate_independent === "boolean" ? record.image_rate_independent : undefined,
    image_rate_multiplier: numberOrUndefined(record.image_rate_multiplier),
    image_price_1k: numberOrNull(record.image_price_1k),
    image_price_2k: numberOrNull(record.image_price_2k),
    image_price_4k: numberOrNull(record.image_price_4k),
    peak_rate_enabled: typeof record.peak_rate_enabled === "boolean" ? record.peak_rate_enabled : undefined,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value == null) return value as null | undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
