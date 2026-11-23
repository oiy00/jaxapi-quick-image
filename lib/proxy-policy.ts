const RULES: { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/api\/v1\/auth\/login$/ },
  { method: "POST", pattern: /^\/api\/v1\/auth\/login\/2fa$/ },
  { method: "POST", pattern: /^\/api\/v1\/auth\/refresh$/ },
  { method: "POST", pattern: /^\/api\/v1\/auth\/logout$/ },
  { method: "GET", pattern: /^\/api\/v1\/auth\/me$/ },
  { method: "GET", pattern: /^\/api\/v1\/settings\/public$/ },
  { method: "GET", pattern: /^\/api\/v1\/keys$/ },
  { method: "POST", pattern: /^\/api\/v1\/keys$/ },
  { method: "GET", pattern: /^\/api\/v1\/groups\/available$/ },
  { method: "GET", pattern: /^\/api\/v1\/groups\/rates$/ },
  { method: "POST", pattern: /^\/v1\/images\/generations$/ },
  { method: "POST", pattern: /^\/v1\/images\/edits$/ },
  { method: "GET", pattern: /^\/v1\/sub2api\/billing$/ },
];

const SENSITIVE_QUERY = new Set(["key", "api_key", "token", "access_token", "refresh_token"]);

export function isProxiedRequest(method: string, path: string): boolean {
  if (!path.startsWith("/") || path.includes("..") || path.includes("//") || path.includes("\\")) {
    return false;
  }
  return RULES.some((rule) => rule.method === method.toUpperCase() && rule.pattern.test(path));
}

export function timeoutFor(path: string): number {
  if (path === "/v1/images/generations" || path === "/v1/images/edits") return 600_000;
  return 25_000;
}

export function sanitizeQuery(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  searchParams.forEach((value, key) => {
    if (SENSITIVE_QUERY.has(key.toLowerCase())) return;
    next.append(key, value);
  });
  return next;
}

export function apiBaseUrl(): string {
  const configured = process.env.JAXAPI_BASE_URL?.trim() || "https://jaxapi.top";
  return configured.replace(/\/$/, "");
}
