import assert from "node:assert/strict";
import test from "node:test";
import { classifyImageBillingTier } from "../lib/billing-tier.ts";
import { ASPECTS, PIXEL_SIZES, RESOLUTIONS } from "../lib/models.ts";
import { chargeFromBalance, estimateImageCost, estimateVideoCost } from "../lib/pricing.ts";
import { isImageCapable, pickImageKey } from "../lib/keys.ts";
import { isProxiedRequest, sanitizeQuery } from "../lib/proxy-policy.ts";
import { parseApiError, redactSecrets } from "../lib/errors.ts";
import type { ApiKeyRecord } from "../lib/types.ts";

test("pixel sizes fall in the matching Sub2API billing tier", () => {
  for (const resolution of RESOLUTIONS) {
    for (const aspect of ASPECTS) {
      const size = PIXEL_SIZES[resolution][aspect];
      assert.equal(classifyImageBillingTier(size), resolution, size);
      const [width, height] = size.split("x").map(Number);
      assert.equal(width % 16, 0, size);
      assert.equal(height % 16, 0, size);
      assert.ok(Math.max(width, height) <= 3840, size);
    }
  }
});

test("estimate uses absolute per-model media prices and ignores multipliers", () => {
  const standard = estimateImageCost({ model: "gpt-image-2", resolution: "2K", count: 1 });
  assert.equal(standard?.source, "table");
  assert.equal(standard?.unitUsd, 0.12);
  assert.equal(standard?.totalUsd, 0.12);
  assert.equal(standard?.multiplier, 1);

  const pro = estimateImageCost({ model: "gemini-3-pro-image", resolution: "1K", count: 1 });
  assert.equal(pro?.unitUsd, 0.15);
  assert.equal(pro?.totalUsd, 0.15);

  const v26 = estimateImageCost({ model: "gpt-image-2.6-flare", resolution: "4K", count: 1 });
  assert.equal(v26?.unitUsd, 0.24);

  const firefly = estimateImageCost({ model: "firefly-gpt-image-2", resolution: "4K", count: 1 });
  assert.equal(firefly, null);
});

test("balance increase is not reported as a charge", () => {
  assert.equal(chargeFromBalance(1, 1.2), null);
  assert.equal(chargeFromBalance(1, 0.8), 0.2);
});

test("only 媒体台 keys are selected", () => {
  const keys: ApiKeyRecord[] = [
    key(1, "claude", "anthropic", false),
    key(2, "ChatGPT 生图", "openai", true),
    key(3, "媒体台", "openai", true, "JaxApi 媒体台"),
    key(4, "媒体台", "openai", true, "其它媒体台钥匙"),
  ];
  assert.equal(isImageCapable(keys[0]), false);
  assert.equal(isImageCapable(keys[1]), false);
  assert.equal(isImageCapable(keys[2]), true);
  assert.equal(pickImageKey(keys)?.id, 3);
  assert.equal(pickImageKey(keys, 4)?.id, 4);
  assert.equal(pickImageKey(keys, 2)?.id, 3);
});

test("proxy allowlist rejects unknown paths and query secrets", () => {
  assert.equal(isProxiedRequest("POST", "/api/v1/auth/login"), true);
  assert.equal(isProxiedRequest("POST", "/v1/images/generations"), true);
  assert.equal(isProxiedRequest("GET", "/v1/images/generations"), false);
  assert.equal(isProxiedRequest("POST", "/v1/videos"), false);
  assert.equal(isProxiedRequest("GET", "/v1/videos/video_123"), false);
  assert.equal(isProxiedRequest("GET", "/v1/videos/video_123/content"), false);
  assert.equal(isProxiedRequest("DELETE", "/v1/videos/video_123"), false);
  assert.equal(isProxiedRequest("POST", "/api/v1/auth/login/../admin"), false);
  const query = sanitizeQuery(new URLSearchParams("page=1&api_key=secret"));
  assert.equal(query.get("page"), "1");
  assert.equal(query.get("api_key"), null);
});

test("errors are translated without keeping a secret", () => {
  const parsed = parseApiError(401, { code: "INVALID_API_KEY", message: "Invalid API key" });
  assert.equal(parsed.invalidKey, true);
  assert.equal(redactSecrets("token sk-live-secret leaked", ["sk-live-secret"]), "token •••• leaked");
});

function key(id: number, groupName: string, platform: string, allow: boolean, keyName = groupName): ApiKeyRecord {
  return {
    id,
    name: keyName,
    key: `secret-${id}-value`,
    group_id: id,
    status: "active",
    group: { id, name: groupName, platform, allow_image_generation: allow, status: "active" },
  };
}

test("video estimates use absolute table prices and ignore multipliers", () => {
  const ray = estimateVideoCost({ model: "video-ray", duration: 10 });
  assert.equal(ray?.totalUsd, 0.6);
  assert.equal(ray?.multiplier, 1);
  assert.equal(ray?.tierLabel, "10秒 / 720p");

  const muse = estimateVideoCost({ model: "muse-video", duration: 60 });
  assert.equal(muse?.totalUsd, 7.2);

  const jl10 = estimateVideoCost({ model: "JL-minimax-video-h3-2k", duration: 10 });
  const jl15 = estimateVideoCost({ model: "JL-minimax-video-h3-2k", duration: 15 });
  assert.equal(jl10?.totalUsd, 6);
  assert.equal(jl15?.totalUsd, 6);

  const seedance = estimateVideoCost({ model: "seedance2.5-V", duration: 30 });
  assert.equal(seedance?.totalUsd, 22.8);

  const originQ = estimateVideoCost({ model: "minimax-h3-origin-quality", duration: 15 });
  assert.equal(originQ?.totalUsd, 4.5);

  assert.equal(estimateVideoCost({ model: "muse-video", duration: 15 }), null);
  assert.equal(estimateVideoCost({ model: "gpt-image-2", duration: 10 }), null);
});

import { createVideoPayload, parseVideoJob, isVideoJobTerminal, isVideoJobFailed } from "../lib/videos.ts";
import { VIDEO_MODELS } from "../lib/video-models.ts";

test("unverified video candidate is not a live upstream contract", () => {
  assert.equal(VIDEO_MODELS.length, 17);
  const payload = createVideoPayload({ model: "muse-video", prompt: "雨巷", duration: 30 });
  assert.equal(payload.model, "muse-video");
  assert.equal(payload.seconds, 30);
  assert.equal(payload.unverified, true);
  assert.equal("size" in payload, false);
});

test("local parser reads task ids without treating that shape as SuperGPT", () => {
  const queued = parseVideoJob({ id: "video_1", object: "video", status: "queued", progress: 0 });
  assert.equal(queued?.id, "video_1");
  assert.equal(isVideoJobTerminal(queued!), false);

  const done = parseVideoJob({ data: { id: "video_2", status: "completed", url: "https://example.com/a.mp4" } });
  assert.equal(done?.url, "https://example.com/a.mp4");
  assert.equal(isVideoJobTerminal(done!), true);
  assert.equal(isVideoJobFailed(done!), false);

  const failed = parseVideoJob({ id: "video_3", status: "failed", error: { message: "upstream rejected" } });
  assert.equal(isVideoJobFailed(failed!), true);
  assert.equal(failed?.error, "upstream rejected");
});
