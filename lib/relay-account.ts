import { attachGroups, selectMediaGrant } from "./keys.ts";
import { toPublicUser } from "./session.ts";
import type { ApiGroup, ApiKeyRecord } from "./types.ts";

export type RelayGrant =
  | { ok: true; userId: number; balance: number; groupId: number; groupName: string }
  | { ok: false; code: "unauthorized" | "wrong_group" | "upstream_unknown" };

type FetchLike = typeof fetch;

/**
 * Identifies the logged-in relay account and whether they hold an active group-11 媒体台 key.
 * Does not follow redirects. Does not call /v1/videos.
 */
export async function fetchRelayMediaGrant(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<RelayGrant> {
  const token = input.token.trim();
  if (!token) return { ok: false, code: "unauthorized" };
  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    return { ok: false, code: "upstream_unknown" };
  }
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    return { ok: false, code: "upstream_unknown" };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const me = await getJson(fetchImpl, new URL("/api/v1/auth/me", base), token);
  if (me.kind === "redirect" || me.kind === "network") return { ok: false, code: "upstream_unknown" };
  if (me.kind === "status") return { ok: false, code: "unauthorized" };
  const user = toPublicUser(unwrap(me.body));
  if (!user) return { ok: false, code: "unauthorized" };

  const keys: ApiKeyRecord[] = [];
  let groups: ApiGroup[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const listed = await getJson(fetchImpl, new URL(`/api/v1/keys?page=${page}&page_size=100`, base), token);
    if (listed.kind !== "ok") return { ok: false, code: listed.kind === "status" ? "unauthorized" : "upstream_unknown" };
    const record = unwrap(listed.body);
    const object = record && typeof record === "object" ? (record as Record<string, unknown>) : {};
    const items = Array.isArray(object.items) ? object.items : Array.isArray(record) ? record : [];
    keys.push(...items.map(asKey).filter((item): item is ApiKeyRecord => item !== null));
    const pages = Number(object.pages);
    if (!Number.isFinite(pages) || page >= pages || items.length === 0) break;
  }
  const groupList = await getJson(fetchImpl, new URL("/api/v1/groups/available", base), token);
  if (groupList.kind === "ok") {
    const record = unwrap(groupList.body);
    const list = Array.isArray(record) ? record : [];
    groups = list.map(asGroup).filter((item): item is ApiGroup => item !== null);
  }
  const grant = selectMediaGrant(attachGroups(keys, groups));
  if (!grant.ok) return { ok: false, code: "wrong_group" };
  return { ok: true, userId: user.id, balance: user.balance, groupId: grant.groupId, groupName: grant.groupName };
}

async function getJson(fetchImpl: FetchLike, url: URL, token: string): Promise<
  { kind: "ok"; body: unknown } | { kind: "status" } | { kind: "redirect" } | { kind: "network" }
> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "curl/8.5.0" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { kind: "network" };
  }
  if (response.status >= 300 && response.status < 400) return { kind: "redirect" };
  if (!response.ok) return { kind: "status" };
  return { kind: "ok", body: await response.json().catch(() => null) };
}

function unwrap(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  if ("data" in record && record.data && typeof record.data === "object") return record.data;
  return body;
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
    allow_image_generation: typeof record.allow_image_generation === "boolean" ? record.allow_image_generation : undefined,
  };
}
