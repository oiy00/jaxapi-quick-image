import { parseApiError, redactSecrets, unwrapEnvelope } from "./errors";
import type { ParsedApiError } from "./errors";
import { shouldUseDirectApi } from "./session";

export class JaxClientError extends Error {
  status: number;
  code?: string;
  reason?: string;
  invalidKey: boolean;
  timeout: boolean;

  constructor(parsed: ParsedApiError) {
    super(parsed.message);
    this.status = parsed.status;
    this.code = parsed.code;
    this.reason = parsed.reason;
    this.invalidKey = parsed.invalidKey;
    this.timeout = parsed.timeout;
  }
}

type RequestOptions = {
  method?: string;
  token?: string;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
  secrets?: Array<string | null | undefined>;
};


export function apiUrl(path: string): string {
  if (shouldUseDirectApi()) return path;
  return `/api/jax${path}`;
}

export async function jaxRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers();
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 25_000;
  const startedAt = Date.now();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(path), {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    const parsed = text ? safeJson(text) : null;
    if (!response.ok) {
      const error = parseApiError(response.status, parsed);
      error.message = redactSecrets(error.message, options.secrets ?? []);
      throw new JaxClientError(error);
    }
    return unwrapEnvelope(parsed) as T;
  } catch (error) {
    if (error instanceof JaxClientError) throw error;
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const billedHint = "这次请求可能已经在上游完成并计费，请先到「使用记录」或余额核对，不要立刻重复提交。未展示的图片无法从这边自动找回。";
    if (error instanceof DOMException && error.name === "AbortError") {
      const ourTimer = Date.now() - startedAt >= timeoutMs - 250;
      throw new JaxClientError({
        status: 504,
        message: ourTimer
          ? `已等待 ${elapsedSec} 秒，浏览器端停止等待。${billedHint}`
          : `连接在约 ${elapsedSec} 秒时被中断（常见原因是前置代理在长时间无响应数据时断开）。${billedHint}`,
        reason: "UPSTREAM_TIMEOUT",
        invalidKey: false,
        timeout: true,
      });
    }
    throw new JaxClientError({
      status: 0,
      message: `网络在约 ${elapsedSec} 秒时中断，没有收到上游结果。${billedHint}`,
      invalidKey: false,
      timeout: false,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  const start = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const index =
    start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart);
  if (index < 0) return { message: text.slice(0, 300) };
  try {
    return JSON.parse(text.slice(index));
  } catch {
    return { message: text.slice(0, 300) };
  }
}
