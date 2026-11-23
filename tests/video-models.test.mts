import assert from "node:assert/strict";
import test from "node:test";
import { VIDEO_MODELS, VIDEO_PIXEL_SIZE } from "../lib/video-models.ts";

test("768p uses the official MiniMax H3 16:9 size", () => {
  assert.equal(VIDEO_PIXEL_SIZE["768p"], "1344x768");
});

test("every video model has a pixel size for its resolution", () => {
  for (const model of VIDEO_MODELS) {
    assert.match(VIDEO_PIXEL_SIZE[model.resolution], /^\d+x\d+$/, model.id);
  }
});
