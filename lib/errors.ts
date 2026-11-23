export type ParsedApiError = {
  status: number;
  message: string;
  code?: string;
  reason?: string;
  invalidKey: boolean;
  timeout: boolean;
};

const KNOWN_MESSAGES: Record<string, string> = {
  "invalid email or password": "邮箱或密码不正确",
  "Invalid or expired 2FA session": "验证已失效，请重新登录",
  "Authorization header is required": "登录状态已失效，请重新登录",
  "API key is required in Authorization header (Bearer scheme), x-api-key header, or x-goog-api-key header":
    "缺少可用的 API 密钥",
  "Invalid API key": "密钥无效，或该分组不能调用图片接口",
};

export function redactSecrets(message: string, secrets: Array<string | null | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("••••");
  }
  return out;
}

export function parseApiError(status: number, body: unknown): ParsedApiError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : null;
  const message = stringField(nested?.message) || stringField(record.message) || `请求失败（${status}）`;
  const code = stringField(nested?.code) || stringField(record.code) || stringField(record.reason);
  const reason = stringField(record.reason) || stringField(nested?.type);
  const invalidKey =
    status === 401 &&
    (code === "INVALID_API_KEY" ||
      reason === "INVALID_API_KEY" ||
      /invalid api key/i.test(message));
  const timeout = status === 504 || code === "UPSTREAM_TIMEOUT" || reason === "UPSTREAM_TIMEOUT";
  return {
    status,
    message: KNOWN_MESSAGES[message] ?? message,
    code,
    reason,
    invalidKey,
    timeout,
  };
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function unwrapEnvelope(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  if ("code" in record && "data" in record && (record.code === 0 || record.code === "0")) {
    return record.data;
  }
  return body;
}
