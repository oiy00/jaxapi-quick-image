/**
 * Reference-image limits for POST /v1/images/edits.
 *
 * Verified 2026-11-24 from the public model plaza, not from a billed request:
 * https://console.supergpt.dev/api/v1/model-plaza
 * Group「AI 画布 · 全能生图」description:
 * 「支持参考图编辑，FB 模型仅文生图。」
 * https://console.supergpt.dev/help/clients says image parameters depend on the
 * model, group, and client. Neither page says an edits request may carry more
 * than one input image, or that an image array is forwarded.
 *
 * OpenAI's own images.edit `image[]` shape is not evidence this relay forwards
 * it. Until a model is added below from an official contract or a captured
 * non-production result, every model stays at one reference.
 */
export const ABSOLUTE_REFERENCE_CAP = 5;
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
export const REFERENCE_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

const VERIFIED_REFERENCE_CAPS: Record<string, number> = {};

export function verifiedReferenceCap(model: string): number {
  const listed = VERIFIED_REFERENCE_CAPS[model];
  if (listed == null || !Number.isFinite(listed)) return 1;
  return Math.min(ABSOLUTE_REFERENCE_CAP, Math.max(1, Math.floor(listed)));
}

export function referenceCap(model: string, override?: number): number {
  if (override == null) return verifiedReferenceCap(model);
  if (!Number.isFinite(override)) return 1;
  return Math.min(ABSOLUTE_REFERENCE_CAP, Math.max(1, Math.floor(override)));
}

export type ReferencePlan = {
  accept: number;
  blocked: number;
  replace: boolean;
};

/** Cap 1 keeps today's replace-the-only-image behavior. Higher caps append. */
export function planReferenceIntake(existingCount: number, validIncoming: number, cap: number): ReferencePlan {
  const limit = Math.min(ABSOLUTE_REFERENCE_CAP, Math.max(1, Math.floor(cap)));
  if (validIncoming <= 0) return { accept: 0, blocked: 0, replace: false };
  if (limit <= 1) return { accept: 1, blocked: Math.max(0, validIncoming - 1), replace: true };
  const room = Math.max(0, limit - Math.max(0, existingCount));
  const accept = Math.min(room, validIncoming);
  return { accept, blocked: validIncoming - accept, replace: false };
}

export function intakeNotice(plan: ReferencePlan, cap: number): string | null {
  if (plan.blocked <= 0) return null;
  if (cap <= 1) return "这个模型一次只能附一张参考图，多出的没有加入。";
  if (plan.accept === 0) return `最多 ${cap} 张参考图，不能再加。`;
  return `已加入 ${plan.accept} 张，另外 ${plan.blocked} 张超出上限，没有加入。`;
}

export function editRejection(model: string | null, imageCount: number): string | null {
  const cap = verifiedReferenceCap(model ?? "");
  if (imageCount > cap) {
    return `这个模型一次只能提交 ${cap} 张参考图，本次有 ${imageCount} 张，已拒绝，没有发给上游。`;
  }
  return null;
}

export type PreparedReference =
  | { ok: true; type: string; name: string }
  | { ok: false; message: string };

export function prepareReferenceFile(
  input: { type: string; size: number; name: string },
  index = 0,
  now = Date.now(),
): PreparedReference {
  const type = input.type === "image/jpg" ? "image/jpeg" : input.type.toLowerCase();
  if (!REFERENCE_MIME.includes(type as (typeof REFERENCE_MIME)[number])) {
    return { ok: false, message: "请使用 PNG、JPEG 或 WebP 图片。" };
  }
  if (input.size > MAX_REFERENCE_BYTES) return { ok: false, message: "参考图超过 12MB。" };
  if (input.size <= 0) return { ok: false, message: "这张图片是空的。" };
  const trimmed = input.name.trim();
  const generic = trimmed === "" || trimmed === "image.png" || trimmed === "blob" || !trimmed.includes(".");
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  return { ok: true, type, name: generic ? `paste-${now}-${index + 1}.${ext}` : trimmed };
}

/** Text paste must win. Images are taken only when the clipboard has no text. */
export function clipboardPasteKind(input: { text: string; imageCount: number }): "text" | "images" | "ignore" {
  if (input.text.length > 0) return "text";
  if (input.imageCount > 0) return "images";
  return "ignore";
}

export type EditInspection = {
  parsed: boolean;
  model: string | null;
  imageCount: number;
};

export function inspectEditMultipart(body: Uint8Array, contentType: string): EditInspection {
  const boundary = boundaryOf(contentType);
  if (!boundary) return { parsed: false, model: null, imageCount: 0 };
  const marker = encode(`--${boundary}`);
  const indexes = findAll(body, marker);
  if (indexes.length === 0) return { parsed: false, model: null, imageCount: 0 };
  let model: string | null = null;
  let imageCount = 0;
  for (let i = 0; i < indexes.length; i += 1) {
    const after = indexes[i] + marker.length;
    if (body[after] === 45 && body[after + 1] === 45) continue;
    let cursor = after;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    else if (body[cursor] === 10) cursor += 1;
    const end = i + 1 < indexes.length ? indexes[i + 1] : body.length;
    if (end <= cursor) continue;
    const part = body.subarray(cursor, end);
    const headerEnd = indexOfBytes(part, encode("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const header = latin1(part.subarray(0, headerEnd));
    const name = /name="([^"]+)"/i.exec(header)?.[1] ?? /name=([^;\s]+)/i.exec(header)?.[1];
    if (!name) continue;
    let value = part.subarray(headerEnd + 4);
    if (value.length >= 2 && value[value.length - 2] === 13 && value[value.length - 1] === 10) {
      value = value.subarray(0, value.length - 2);
    }
    if (name === "model") model = new TextDecoder().decode(value).trim();
    if (name === "image" || name === "image[]") imageCount += 1;
  }
  return { parsed: true, model, imageCount };
}

function boundaryOf(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value || null;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function latin1(value: Uint8Array): string {
  let text = "";
  for (const byte of value) text += String.fromCharCode(byte);
  return text;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0 || hay.length < needle.length) return -1;
  for (let i = from; i <= hay.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function findAll(hay: Uint8Array, needle: Uint8Array): number[] {
  const found: number[] = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const at = indexOfBytes(hay, needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + needle.length;
  }
  return found;
}
