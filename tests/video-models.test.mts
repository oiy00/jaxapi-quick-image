import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL } from "../lib/models.ts";
import { DEFAULT_VIDEO_MODEL, VERIFIED_VIDEO_REQUESTS, VIDEO_MODELS, VIDEO_PIXEL_SIZE, isVerifiedVideoRequest } from "../lib/video-models.ts";

test("768p uses the official MiniMax H3 16:9 size", () => {
  assert.equal(VIDEO_PIXEL_SIZE["768p"], "1344x768");
  assert.equal(DEFAULT_MODEL, "gpt-image-2.5-flare");
  assert.equal(DEFAULT_VIDEO_MODEL, "muse-video");
  assert.deepEqual(VERIFIED_VIDEO_REQUESTS, [
    { id: "muse-video", duration: 10 },
    { id: "minimax-h3-base-fast", duration: 10 },
  ]);
  assert.equal(isVerifiedVideoRequest("video-ray", 10), false);
  assert.equal(isVerifiedVideoRequest("muse-video", 20), false);
});

test("every video model has a pixel size for its resolution", () => {
  for (const model of VIDEO_MODELS) {
    assert.match(VIDEO_PIXEL_SIZE[model.resolution], /^\d+x\d+$/, model.id);
  }
});
