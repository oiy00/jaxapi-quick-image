import assert from "node:assert/strict";
import test from "node:test";
import { MODELS } from "../lib/models.ts";
import {
  ABSOLUTE_REFERENCE_CAP,
  clipboardPasteKind,
  editRejection,
  inspectEditMultipart,
  intakeNotice,
  planReferenceIntake,
  prepareReferenceFile,
  verifiedReferenceCap,
} from "../lib/reference-images.ts";

test("every shipped image model stays at one reference", () => {
  for (const model of MODELS) {
    assert.equal(verifiedReferenceCap(model.id), 1, model.id);
  }
  assert.equal(verifiedReferenceCap("gpt-image-2.5-flare-fb"), 1);
  assert.equal(verifiedReferenceCap(""), 1);
  assert.equal(verifiedReferenceCap("not-a-model"), 1);
});

test("one reference replaces, and a higher cap appends until five", () => {
  assert.deepEqual(planReferenceIntake(0, 1, 1), { accept: 1, blocked: 0, replace: true });
  assert.deepEqual(planReferenceIntake(1, 2, 1), { accept: 1, blocked: 1, replace: true });
  assert.equal(intakeNotice(planReferenceIntake(1, 2, 1), 1), "这个模型一次只能附一张参考图，多出的没有加入。");

  assert.deepEqual(planReferenceIntake(0, 2, 5), { accept: 2, blocked: 0, replace: false });
  assert.deepEqual(planReferenceIntake(1, 5, 5), { accept: 4, blocked: 1, replace: false });
  assert.deepEqual(planReferenceIntake(5, 1, 5), { accept: 0, blocked: 1, replace: false });
  assert.equal(intakeNotice(planReferenceIntake(5, 1, 5), 5), "最多 5 张参考图，不能再加。");
  assert.equal(planReferenceIntake(0, 6, 5).accept, ABSOLUTE_REFERENCE_CAP);
  assert.equal(planReferenceIntake(0, 6, 5).blocked, 1);
  assert.equal(planReferenceIntake(0, 9, 99).accept, ABSOLUTE_REFERENCE_CAP);
});

test("clipboard text is never treated as a reference image", () => {
  assert.equal(clipboardPasteKind({ text: "弄堂", imageCount: 1 }), "text");
  assert.equal(clipboardPasteKind({ text: " ", imageCount: 1 }), "text");
  assert.equal(clipboardPasteKind({ text: "", imageCount: 2 }), "images");
  assert.equal(clipboardPasteKind({ text: "", imageCount: 0 }), "ignore");
});

test("reference files keep allowed types and reject the rest", () => {
  const png = prepareReferenceFile({ type: "image/png", size: 20, name: "door.png" }, 0, 10);
  assert.deepEqual(png, { ok: true, type: "image/png", name: "door.png" });
  const pasted = prepareReferenceFile({ type: "image/jpeg", size: 20, name: "image.png" }, 1, 10);
  assert.deepEqual(pasted, { ok: true, type: "image/jpeg", name: "paste-10-2.jpg" });
  assert.equal(prepareReferenceFile({ type: "image/gif", size: 20, name: "a.gif" }).ok, false);
  assert.equal(prepareReferenceFile({ type: "image/png", size: 12 * 1024 * 1024 + 1, name: "big.png" }).ok, false);
  assert.equal(prepareReferenceFile({ type: "image/png", size: 0, name: "empty.png" }).ok, false);
});

test("two input images are refused before an upstream edit", () => {
  const body = multipart("bound", [
    { name: "model", body: "gpt-image-2.5-flare" },
    { name: "prompt", body: "把天空改成黄昏" },
    { name: "image", filename: "a.png", type: "image/png", body: "one" },
    { name: "image", filename: "b.png", type: "image/png", body: "two" },
  ]);
  const seen = inspectEditMultipart(body, 'multipart/form-data; boundary="bound"');
  assert.equal(seen.parsed, true);
  assert.equal(seen.model, "gpt-image-2.5-flare");
  assert.equal(seen.imageCount, 2);
  assert.match(editRejection(seen.model, seen.imageCount) ?? "", /没有发给上游/);
});

test("a single image edit is not rejected", () => {
  const body = multipart("bound", [
    { name: "model", body: "gemini-3-pro-image" },
    { name: "image", filename: "a.png", type: "image/png", body: "only" },
  ]);
  const seen = inspectEditMultipart(body, "multipart/form-data; boundary=bound");
  assert.equal(seen.imageCount, 1);
  assert.equal(editRejection(seen.model, seen.imageCount), null);
});

test("image[] counts as an input image and an unparsed body is not guessed", () => {
  const body = multipart("bound", [{ name: "image[]", filename: "a.webp", type: "image/webp", body: "x" }]);
  assert.equal(inspectEditMultipart(body, "multipart/form-data; boundary=bound").imageCount, 1);
  assert.equal(inspectEditMultipart(new Uint8Array([1, 2, 3]), "application/json").parsed, false);
  assert.equal(editRejection(null, 2), editRejection("", 2));
});

function multipart(
  boundary: string,
  parts: { name: string; filename?: string; type?: string; body: string }[],
): Uint8Array {
  let raw = "";
  for (const part of parts) {
    raw += `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) raw += `; filename="${part.filename}"`;
    raw += "\r\n";
    if (part.type) raw += `Content-Type: ${part.type}\r\n`;
    raw += `\r\n${part.body}\r\n`;
  }
  raw += `--${boundary}--\r\n`;
  return new TextEncoder().encode(raw);
}
