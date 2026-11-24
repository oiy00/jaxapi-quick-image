/**
 * Reference-image limits for POST /v1/images/edits.
 *
 * Public plaza (https://console.supergpt.dev/api/v1/model-plaza), group
 * 「AI 画布 · 全能生图」: 「支持参考图编辑，FB 模型仅文生图。」
 * https://console.supergpt.dev/help/clients says image parameters depend on
 * the model, group, and client. That text does not set a count.
 *
 * Paid check, exactly one, 2026-11-24 14:41 Asia/Shanghai. No further paid
 * calls. POST https://api.supergpt.dev/v1/images/edits for gpt-image-2.5-flare
 * only. Five multipart parts used the repeated field name "image", not
 * "image[]". quality=low, size=1024x576, response_format=b64_json, n omitted.
 * Service group 11, accounts 31–32, the production upstream route.
 * HTTP 200, one output image, request id
 * 1d137fbe-6cf2-4a41-b794-b60017341370. The five synthetic references were
 * different numbered colors and shapes; the output showed all five, and the
 * reference captions were not in the prompt, so all five were read. The
 * response had no cost fields. The bitmap came back 1672×941 rather than the
 * requested 1024×576; this module does not change size handling.
 *
 * Only that exact model id is capped at 5. Every other id, including
 * gpt-image-2.5-flare-fb and unknown names, stays at 1.
 */
export const ABSOLUTE_REFERENCE_CAP = 5;
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
/** Five max-size references plus multipart overhead. The live Caddy hop in front of this app must allow the same size. */
export const MAX_EDIT_BODY_BYTES = 64 * 1024 * 1024;
export const REFERENCE_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
/** Repeated multipart name. Do not send image[]. */
export const REFERENCE_PART_NAME = "image";

const VERIFIED_REFERENCE_CAPS: Record<string, number> = {
  "gpt-image-2.5-flare": 5,
};

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

/** One part name per file. The verified flare request repeated "image". */
export function referencePartNames(count: number): string[] {
  const total = Math.max(0, Math.floor(count));
  return Array.from({ length: total }, () => REFERENCE_PART_NAME);
}

/**
 * Switching to a lower cap must not delete references. The caller warns and
 * the edit is refused until the user removes the extras.
 */
export function editBodyOverflow(fileSizes: number[]): boolean {
  const bytes = fileSizes.reduce((sum, size) => sum + Math.max(0, size), 0);
  const overhead = 2048 * (fileSizes.length + 4);
  return bytes + overhead > MAX_EDIT_BODY_BYTES;
}

/** Image calls always go through this app, even when other API calls are same-origin direct. */
export function imageRequestUrl(path: string, basePath = ""): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${base}/api/jax${path}`;
}

export function multipartClosed(body: Uint8Array, contentType: string): boolean {
  const boundary = boundaryOf(contentType);
  if (!boundary) return false;
  return indexOfBytes(body, encode(`--${boundary}--`)) >= 0;
}

/** Both the button and Ctrl/Cmd+Enter must use this. Acknowledged means the user already saw 先核对记录. */
export function submitAfterUncertainFailure(uncertain: boolean, acknowledged: boolean): "submit" | "acknowledge" {
  if (uncertain && !acknowledged) return "acknowledge";
  return "submit";
}

export function lostResponseMessage(elapsedMs: number): string {
  const ms = Math.max(0, Math.round(elapsedMs));
  return `网络在 ${ms} 毫秒时中断，没有收到响应。请求可能已经到达中转站并仍在完成、扣费，请先核对使用记录和余额，不要立刻再提交。未展示的图片无法从这边自动找回。`;
}

export function capChangeWarning(count: number, cap: number): string | null {
  const limit = Math.min(ABSOLUTE_REFERENCE_CAP, Math.max(1, Math.floor(cap)));
  if (count <= limit) return null;
  return `当前模型一次只能提交 ${limit} 张参考图，你还留着 ${count} 张。多出的没有删除；请先移除后再生成，否则不会发给上游。`;
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
