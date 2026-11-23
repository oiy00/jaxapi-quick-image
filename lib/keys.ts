import type { ApiGroup, ApiKeyRecord } from "./types";

const IMAGE_PLATFORMS = new Set(["openai", "grok", "composite"]);

export const MEDIA_GROUP_NAME = "媒体台";
/** Live media-station group. Video and new keys may use only this id. */
export const MEDIA_GROUP_ID = 11;
/** ChatGPT image group. Never attach a media key or video job to it. */
export const FORBIDDEN_MEDIA_GROUP_ID = 7;
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
  return (
    groups.find(
      (group) =>
        group.id === MEDIA_GROUP_ID &&
        isMediaGroup(group) &&
        groupAllowsImage(group),
    ) ?? null
  );
}

export function videoGroupRejection(group: { id: number; name?: string | null } | null | undefined): "wrong_group" | null {
  if (!group) return "wrong_group";
  if (group.id === FORBIDDEN_MEDIA_GROUP_ID) return "wrong_group";
  if (group.id !== MEDIA_GROUP_ID) return "wrong_group";
  if ((group.name || "").trim() !== MEDIA_GROUP_NAME) return "wrong_group";
  return null;
}

/** Active key on group 11 named 媒体台. Group 7 never qualifies, even if it is also present. */
export function selectMediaGrant(keys: ApiKeyRecord[]): { ok: true; groupId: number; groupName: string } | { ok: false; code: "wrong_group" } {
  const eligible = keys.filter((key) => {
    if (key.status !== "active" || !key.group) return false;
    if (key.group.status && key.group.status !== "active") return false;
    return videoGroupRejection(key.group) === null;
  });
  const grant = eligible[0];
  if (!grant?.group) return { ok: false, code: "wrong_group" };
  return { ok: true, groupId: grant.group.id, groupName: grant.group.name };
}
