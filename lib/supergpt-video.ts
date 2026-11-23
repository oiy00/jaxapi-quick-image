import { isSafeUpstreamVideoId, parseVideoJob, supergptVideoCreateBody } from "./videos.ts";

export const SUPERGPT_HOST = "api.supergpt.dev";
export const SUPERGPT_USER_AGENT = "curl/8.5.0";

export type CreateOutcome =
  | { kind: "accepted"; upstreamId: string; status: string; progress: number | null }
  | { kind: "confirmed_failure"; status: number; message: string }
  | { kind: "ambiguous"; message: string };

export type PollOutcome =
  | { kind: "running"; status: string; progress: number | null }
  | { kind: "completed"; progress: number | null }
  | { kind: "failed"; message: string }
  | { kind: "ambiguous" };

export type ContentOutcome =
  | { kind: "ready"; contentType: string; body: Uint8Array }
  | { kind: "not_ready" }
  | { kind: "refused"; message: string }
  | { kind: "ambiguous" };

type FetchLike = typeof fetch;

export function assertSuperGptBase(base: string): string {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.hostname !== SUPERGPT_HOST || url.username || url.password || url.search || url.hash) {
    throw new Error("SUPERGPT_BASE_URL 只能是 https://api.supergpt.dev/v1");
  }
  return base.replace(/\/$/, "");
}

export function videoCollectionUrl(base: string): string {
  return `${assertSuperGptBase(base)}/videos`;
}

export function videoItemUrl(base: string, upstreamId: string): string | null {
  if (!isSafeUpstreamVideoId(upstreamId)) return null;
  return `${assertSuperGptBase(base)}/videos/${upstreamId}`;
}

export function videoContentUrl(base: string, upstreamId: string): string | null {
  const item = videoItemUrl(base, upstreamId);
  return item ? `${item}/content` : null;
}

export async function createSuperGptVideo(input: {
  baseUrl: string;
  apiKey: string;
  body: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<CreateOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(videoCollectionUrl(input.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: upstreamHeaders(input.apiKey),
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    });
  } catch {
    return { kind: "ambiguous", message: "视频上游没有在时限内给出明确结果。没有自动重试。" };
  }
  if (response.status >= 300 && response.status < 400) {
    return { kind: "ambiguous", message: "视频上游返回了重定向，没有跟随，也没有重试。" };
  }
  if (response.status >= 500 || response.status === 408) {
    return { kind: "ambiguous", message: `视频上游返回 ${response.status}，结果不明。没有自动重试。` };
  }
  if (response.status >= 400) {
    return { kind: "confirmed_failure", status: response.status, message: await confirmedMessage(response) };
  }
  const payload = await response.json().catch(() => null);
  const job = parseVideoJob(payload);
  if (!job?.id || !isSafeUpstreamVideoId(job.id)) {
    return { kind: "ambiguous", message: "视频上游没有返回可用的任务编号。没有自动重试。" };
  }
  return { kind: "accepted", upstreamId: job.id, status: job.status || "queued", progress: job.progress };
}

export async function pollSuperGptVideo(input: {
  baseUrl: string;
  apiKey: string;
  upstreamId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PollOutcome> {
  const url = videoItemUrl(input.baseUrl, input.upstreamId);
  if (!url) return { kind: "ambiguous" };
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: upstreamHeaders(input.apiKey),
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    });
  } catch {
    return { kind: "ambiguous" };
  }
  if (response.status >= 300 && response.status < 400) return { kind: "ambiguous" };
  if (response.status === 404) return { kind: "failed", message: "上游确认任务不存在。" };
  if (response.status >= 500 || response.status === 408) return { kind: "ambiguous" };
  if (response.status >= 400) return { kind: "failed", message: await confirmedMessage(response) };
  const job = parseVideoJob(await response.json().catch(() => null));
  if (!job) return { kind: "ambiguous" };
  const status = job.status.toLowerCase();
  if (status === "completed" || status === "succeeded" || status === "success") {
    return { kind: "completed", progress: 100 };
  }
  if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
    return { kind: "failed", message: job.error || "上游确认生成失败。" };
  }
  return { kind: "running", status: job.status || "in_progress", progress: job.progress };
}

export async function readSuperGptContent(input: {
  baseUrl: string;
  apiKey: string;
  upstreamId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<ContentOutcome> {
  const url = videoContentUrl(input.baseUrl, input.upstreamId);
  if (!url) return { kind: "refused", message: "任务编号不能用来请求内容。" };
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: upstreamHeaders(input.apiKey),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    });
  } catch {
    return { kind: "ambiguous" };
  }
  if (response.status >= 300 && response.status < 400) {
    return { kind: "refused", message: "内容地址返回了重定向，没有跟随。" };
  }
  if (response.status === 404 || response.status === 409) return { kind: "not_ready" };
  if (!response.ok) return { kind: "ambiguous" };
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (contentType.includes("json") || contentType.includes("html")) {
    return { kind: "refused", message: "上游没有直接返回视频内容。不会根据响应里的地址再去拉取。" };
  }
  const length = Number(response.headers.get("content-length") || "0");
  const maxBytes = input.maxBytes ?? 80 * 1024 * 1024;
  if (Number.isFinite(length) && length > maxBytes) return { kind: "refused", message: "视频文件超过大小限制。" };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { kind: "refused", message: "视频文件超过大小限制。" };
  return { kind: "ready", contentType: contentType.split(";")[0] || "application/octet-stream", body: bytes };
}

export function createBodyOrNull(input: { model: string; prompt: string; duration: number }): Record<string, string> | null {
  return supergptVideoCreateBody(input);
}

function upstreamHeaders(apiKey: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("content-type", "application/json");
  headers.set("accept", "*/*");
  headers.set("user-agent", SUPERGPT_USER_AGENT);
  return headers;
}

async function confirmedMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null);
  const job = parseVideoJob(payload);
  const message = job?.error?.replace(/\s+/g, " ").slice(0, 180);
  return message || `上游拒绝了这次请求（${response.status}）。`;
}
