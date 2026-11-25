import assert from "node:assert/strict";
import test from "node:test";
import { SNAPSHOT_LONG_EDGE, persistAttempts, snapshotDimensions } from "../lib/reference-snapshot.ts";
import type { HistoryRecord } from "../lib/types.ts";

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: "r1",
    userId: 1,
    createdAt: "2026-11-25T00:00:00.000Z",
    prompt: "p",
    model: "gpt-image-2.5-flare",
    resolution: "1K",
    aspect: "1:1",
    size: "1024x1024",
    quality: "auto",
    count: 1,
    mode: "edit",
    status: "succeeded",
    estimateUsd: 0.09,
    costUsd: 0.09,
    balanceAfter: 1,
    usage: null,
    images: [{ mime: "image/png", blob: new Blob(["x"]) }],
    references: [{ blob: new Blob(["r"]), mime: "image/webp", name: "a.webp" }],
    referenceCount: 1,
    ...overrides,
  };
}

test("snapshots cap the long edge and keep the ratio", () => {
  assert.deepEqual(snapshotDimensions(4000, 3000), { width: SNAPSHOT_LONG_EDGE, height: 1200 });
  assert.deepEqual(snapshotDimensions(1080, 1920), { width: 900, height: SNAPSHOT_LONG_EDGE });
});

test("small references are not upscaled", () => {
  assert.deepEqual(snapshotDimensions(800, 600), { width: 800, height: 600 });
});

test("bad dimensions do not produce a canvas size", () => {
  assert.deepEqual(snapshotDimensions(0, 100), { width: 0, height: 0 });
  assert.deepEqual(snapshotDimensions(Number.NaN, 100), { width: 0, height: 0 });
});

test("when storage is short, references go before result images", () => {
  const [full, noRefs, bare] = persistAttempts(record());
  assert.equal(full.references?.length, 1);
  assert.equal(noRefs.references?.length, 0);
  assert.equal(noRefs.referencesDropped, true);
  assert.equal(noRefs.images.length, 1);
  assert.equal(bare.images.length, 0);
  assert.match(bare.error ?? "", /未能保存/);
});

test("a text-only record without images has a single attempt", () => {
  assert.equal(persistAttempts(record({ images: [], references: [], referenceCount: 0, mode: "generate", status: "pending" })).length, 1);
});
