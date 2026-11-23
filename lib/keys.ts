import type { ApiGroup, ApiKeyRecord } from "./types";

const IMAGE_PLATFORMS = new Set(["openai", "grok", "composite"]);

export const MEDIA_GROUP_NAME = "媒体台";
export const AUTO_IMAGE_KEY_NAME = "JaxApi 媒体台";

export function isMediaGroup(group: ApiGroup | null | undefined): boolean {
  return (group?.name || "").trim() === MEDIA_GROUP_NAME;
}

export function keyBlockReason(key: ApiKeyRecord, now = Date.now()): string | null {
  if (!key.key?.trim()) return "密钥内容不可用";
  if (key.status !== "active") return "密钥未启用";
  if (key.expires_at) {
    const expires = Date.parse(key.expires_at);
    if (Number.isFinite(expires) && expires < now) return "密钥已过期";
  }
  if (key.group_id == null && !key.group) return "密钥没有分组";
  const group = key.group;
  if (!group) return "没有读到分组信息";
  if (group.status && group.status !== "active") return "分组已停用";
  if (!isMediaGroup(group)) return "不是媒体台分组";
  const platform = (group.platform || "").toLowerCase();
  if (platform && !IMAGE_PLATFORMS.has(platform)) return "分组平台不支持图片接口";
  if (group.allow_image_generation === false) return "分组未开通图片生成";
  if (group.allow_image_generation !== true && platform !== "openai" && platform !== "grok") {
    return "无法确认图片权限";
  }
  return null;
}

export function isImageCapable(key: ApiKeyRecord, now = Date.now()): boolean {
  return keyBlockReason(key, now) === null;
}

export function isMediaKey(key: ApiKeyRecord, now = Date.now()): boolean {
  return isImageCapable(key, now);
}

export function pickImageKey(
  keys: ApiKeyRecord[],
  preferredId?: number | null,
  now = Date.now(),
): ApiKeyRecord | null {
  const eligible = keys.filter((key) => isMediaKey(key, now));
  if (preferredId != null) {
    const preferred = eligible.find((key) => key.id === preferredId);
    if (preferred) return preferred;
  }
  const named = eligible.find((key) => key.name?.trim() === AUTO_IMAGE_KEY_NAME);
  return named ?? eligible[0] ?? null;
}

export function attachGroups(keys: ApiKeyRecord[], groups: ApiGroup[]): ApiKeyRecord[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  return keys.map((key) => {
    if (key.group || key.group_id == null) return key;
    const group = byId.get(key.group_id);
    return group ? { ...key, group } : key;
  });
}

export function keyLabel(key: Pick<ApiKeyRecord, "id" | "name" | "group">): string {
  const name = key.name?.trim() || `密钥 #${key.id}`;
  const group = key.group?.name?.trim();
  return group ? `${name} · ${group}` : name;
}

export function groupAllowsImage(group: ApiGroup): boolean {
  if (group.status && group.status !== "active") return false;
  const platform = (group.platform || "").toLowerCase();
  if (group.allow_image_generation === false) return false;
  if (group.allow_image_generation === true) return true;
  return platform === "openai" || platform === "grok" || platform === "composite";
}

export function pickImageGroup(groups: ApiGroup[]): ApiGroup | null {
  return groups.find((group) => isMediaGroup(group) && groupAllowsImage(group)) ?? null;
}
