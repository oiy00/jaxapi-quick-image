import type { PublicUser, StoredSession } from "./types";

const SESSION_KEY = "jax.image.session.v1";

export const HOST_AUTH_TOKEN_KEY = "auth_token";
export const HOST_REFRESH_TOKEN_KEY = "refresh_token";
export const HOST_USER_KEY = "auth_user";
export const HOST_EXPIRES_AT_KEY = "token_expires_at";

const SENSITIVE_QUERY = new Set(["token", "user_id", "access_token", "refresh_token"]);

export function preferredKeyStorageKey(userId: number): string {
  return `jax.image.key.${userId}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("ui_mode") === "embedded") return true;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function isSameOriginHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "jaxapi.top" || host.endsWith(".jaxapi.top");
}

export function shouldUseDirectApi(): boolean {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_MODE === "same-origin") {
    return true;
  }
  return isSameOriginHost();
}

export function stripSensitiveQuery(currentUrl: string): string | null {
  const url = new URL(currentUrl, "https://jaxapi.top");
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY.has(key.toLowerCase())) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function stripSensitiveQueryInPlace(): void {
  if (typeof window === "undefined") return;
  const next = stripSensitiveQuery(window.location.href);
  if (!next) return;
  window.history.replaceState(window.history.state, "", next);
}

export function sessionFromHostStorage(store: { getItem(key: string): string | null }): StoredSession | null {
  const accessToken = store.getItem(HOST_AUTH_TOKEN_KEY)?.trim();
  if (!accessToken) return null;
  let user: PublicUser | null = null;
  const rawUser = store.getItem(HOST_USER_KEY);
  if (rawUser) {
    try {
      user = toPublicUser(JSON.parse(rawUser));
    } catch {
      user = null;
    }
  }
  if (!user) return null;
  const expiresRaw = store.getItem(HOST_EXPIRES_AT_KEY);
  const expiresAt = expiresRaw ? Number(expiresRaw) : undefined;
  return {
    accessToken,
    refreshToken: store.getItem(HOST_REFRESH_TOKEN_KEY) || undefined,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    user,
    source: "host",
  };
}

export function writeHostSession(
  store: { setItem(key: string, value: string): void },
  session: StoredSession,
): void {
  store.setItem(HOST_AUTH_TOKEN_KEY, session.accessToken);
  if (session.refreshToken) store.setItem(HOST_REFRESH_TOKEN_KEY, session.refreshToken);
  if (session.expiresAt) store.setItem(HOST_EXPIRES_AT_KEY, String(session.expiresAt));
  store.setItem(HOST_USER_KEY, JSON.stringify(session.user));
}

export function readSession(): StoredSession | null {
  const store = storage();
  if (!store) return null;
  const host = sessionFromHostStorage(store);
  if (host) return host;
  const raw = store.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.accessToken || !parsed.user?.id || !parsed.user.email) {
      store.removeItem(SESSION_KEY);
      return null;
    }
    return { ...parsed, source: parsed.source || "local" };
  } catch {
    store.removeItem(SESSION_KEY);
    return null;
  }
}

export function writeSession(session: StoredSession): void {
  const store = storage();
  if (!store) return;
  const next: StoredSession = {
    ...session,
    source: session.source || (isSameOriginHost() ? "host" : "local"),
  };
  if (next.source === "host" || isSameOriginHost()) {
    writeHostSession(store, next);
    return;
  }
  store.setItem(SESSION_KEY, JSON.stringify({ ...next, source: "local" }));
}

export function clearSession(): void {
  const store = storage();
  if (!store) return;
  const current = readSession();
  store.removeItem(SESSION_KEY);
  // Host session belongs to the main jaxapi.top app. Do not log the user out of the site.
  if (current?.source === "host") return;
}

export function readPreferredKeyId(userId: number): number | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(preferredKeyStorageKey(userId));
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

export function writePreferredKeyId(userId: number, keyId: number): void {
  const store = storage();
  if (!store) return;
  store.setItem(preferredKeyStorageKey(userId), String(keyId));
}

export function toPublicUser(input: unknown): PublicUser | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = Number(record.id);
  const email = typeof record.email === "string" ? record.email : "";
  const balance = Number(record.balance);
  if (!Number.isFinite(id) || !email) return null;
  const frozen = Number(record.frozen_balance);
  return {
    id,
    email,
    username: typeof record.username === "string" ? record.username : undefined,
    balance: Number.isFinite(balance) ? balance : 0,
    frozen_balance: Number.isFinite(frozen) ? frozen : undefined,
  };
}
