import type { UsageNumbers } from "./types";

export type ParsedGeneration = {
  images: { b64?: string; url?: string; revised?: string }[];
  usage: UsageNumbers | null;
};

export function parseGenerationBody(text: string): ParsedGeneration {
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("上游没有返回图片数据");
  }
  const payload = JSON.parse(text.slice(start)) as unknown;
  return parseGenerationPayload(payload);
}

export function parseGenerationPayload(payload: unknown): ParsedGeneration {
  if (!payload || typeof payload !== "object") {
    throw new Error("上游没有返回图片数据");
  }
  const record = payload as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  const images: ParsedGeneration["images"] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const b64 = typeof row.b64_json === "string" ? row.b64_json : undefined;
    const url = typeof row.url === "string" ? row.url : undefined;
    const revised = typeof row.revised_prompt === "string" ? row.revised_prompt : undefined;
    if (!b64 && !url) continue;
    images.push({ b64, url, revised });
  }
  return { images, usage: numericUsage(record.usage) };
}

export function b64ToBlob(b64: string, mime = "image/png"): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function numericUsage(usage: unknown): UsageNumbers | null {
  if (!usage || typeof usage !== "object") return null;
  const out: UsageNumbers = {};
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}
