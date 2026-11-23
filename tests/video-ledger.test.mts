import assert from "node:assert/strict";
import test from "node:test";
import { MODELS } from "../lib/models.ts";
import { estimateVideoCost } from "../lib/pricing.ts";
import { VIDEO_MODELS } from "../lib/video-models.ts";
import { VideoLedger, sub2apiClampedSeconds, sub2apiResolutionKnown } from "../lib/video-ledger.ts";

const BRIEF: Record<string, Record<number, number>> = {
  "video-ray": { 10: 0.6 },
  "muse-video": { 10: 1.2, 20: 2.4, 30: 3.6, 60: 7.2 },
  "DB-SD-2.0-Fast": { 15: 6 },
  "JL-minimax-video-h3-2k": { 10: 6, 15: 6 },
  "seedance2.5-V": { 30: 22.8 },
  "minimax-h3-base-fast": { 5: 0.3, 10: 0.6, 15: 0.9 },
  "minimax-h3-base-standard": { 5: 0.45, 10: 0.9, 15: 1.35 },
  "minimax-h3-base-enhanced": { 5: 0.9, 10: 1.8, 15: 2.7 },
  "minimax-h3-base-quality": { 5: 1.2, 10: 2.4, 15: 3.6 },
  "minimax-h3-cinematic-fast": { 5: 0.3, 10: 0.6, 15: 0.9 },
  "minimax-h3-cinematic-standard": { 5: 0.45, 10: 0.9, 15: 1.35 },
  "minimax-h3-cinematic-enhanced": { 5: 0.9, 10: 1.8, 15: 2.7 },
  "minimax-h3-cinematic-quality": { 5: 1.2, 10: 2.4, 15: 3.6 },
  "minimax-h3-origin-fast": { 5: 0.45, 10: 0.9, 15: 1.35 },
  "minimax-h3-origin-standard": { 5: 0.75, 10: 1.5, 15: 2.25 },
  "minimax-h3-origin-enhanced": { 5: 1.2, 10: 2.4, 15: 3.6 },
  "minimax-h3-origin-quality": { 5: 1.5, 10: 3, 15: 4.5 },
};

test("catalog has the nine image models and seventeen video models", () => {
  assert.deepEqual(MODELS.map((item) => item.id), [
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.6-flare",
    "gpt-image-2.6-sunburst",
    "gemini-3-pro-image",
    "gemini-3.1-flash-image",
    "gemini-nano-banana-2.1",
    "firefly-gpt-image-2",
  ]);
  assert.deepEqual(VIDEO_MODELS.map((item) => item.id), Object.keys(BRIEF));
});

test("every video tier matches the absolute cost-times-two table", () => {
  for (const [model, tiers] of Object.entries(BRIEF)) {
    for (const [duration, price] of Object.entries(tiers)) {
      const quote = estimateVideoCost({ model, duration: Number(duration) });
      assert.equal(quote?.totalUsd, price, `${model} ${duration}`);
      assert.equal(quote?.multiplier, 1);
    }
  }
});

test("per-second Sub2API billing cannot represent the flat tiers", () => {
  assert.equal(sub2apiResolutionKnown("768p"), false);
  assert.equal(sub2apiResolutionKnown("2k"), false);
  assert.equal(sub2apiClampedSeconds(60), 15);
  assert.equal(sub2apiClampedSeconds(30), 15);
  const jlPerSecond = 0.4 * 10;
  assert.notEqual(jlPerSecond, estimateVideoCost({ model: "JL-minimax-video-h3-2k", duration: 10 })?.totalUsd);
  assert.equal(estimateVideoCost({ model: "JL-minimax-video-h3-2k", duration: 15 })?.totalUsd, 6);
  assert.notEqual(0.12 * sub2apiClampedSeconds(60), 7.2);
});

test("ledger charges the table once, ignores discounts, and rejects the wrong group", () => {
  const ledger = new VideoLedger({ u1: 10 });
  const denied = ledger.submit({
    userId: "u1",
    groupName: "ChatGPT 生图",
    idempotencyKey: "k1",
    model: "video-ray",
    duration: 10,
    prompt: "巷子",
    clientMultiplier: 0.26,
    now: 1_000,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "wrong_group");
  assert.equal(ledger.balanceOf("u1"), 10);

  const first = ledger.submit({
    userId: "u1",
    groupName: "媒体台",
    idempotencyKey: "k1",
    model: "video-ray",
    duration: 10,
    prompt: "巷子",
    clientMultiplier: 0.26,
    now: 1_000,
    id: "task-1",
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.task.priceUsd, 0.6);
  assert.equal(ledger.balanceOf("u1"), 9.4);

  const again = ledger.submit({
    userId: "u1",
    groupName: "媒体台",
    idempotencyKey: "k1",
    model: "video-ray",
    duration: 10,
    prompt: "巷子",
    now: 1_500,
  });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.task.id, "task-1");
  assert.equal(ledger.balanceOf("u1"), 9.4);
});

test("another user cannot read a task", () => {
  const ledger = new VideoLedger({ owner: 5, other: 5 });
  const created = ledger.submit({
    userId: "owner",
    groupName: "媒体台",
    idempotencyKey: "own",
    model: "video-ray",
    duration: 10,
    prompt: "只属于我",
    now: 2_000,
    id: "private",
  });
  assert.equal(created.ok, true);
  const peeked = ledger.read("private", "other", 3_000);
  assert.equal(peeked.ok, false);
  if (!peeked.ok) assert.equal(peeked.code, "forbidden");
  assert.equal(ledger.balanceOf("other"), 5);
});

test("failure and timeout release the hold once and do not resubmit", () => {
  const ledger = new VideoLedger({ u: 20 });
  const failed = ledger.submit({
    userId: "u",
    groupName: "媒体台",
    idempotencyKey: "fail",
    model: "muse-video",
    duration: 60,
    prompt: "[[fail]] 长镜头",
    now: 10_000,
    id: "fail-1",
  });
  assert.equal(failed.ok, true);
  assert.equal(ledger.balanceOf("u"), 12.8);
  const afterFail = ledger.read("fail-1", "u", 11_000);
  assert.equal(afterFail.ok, true);
  if (afterFail.ok) {
    assert.equal(afterFail.task.status, "failed");
    assert.equal(afterFail.task.charged, false);
  }
  assert.equal(ledger.balanceOf("u"), 20);
  ledger.read("fail-1", "u", 12_000);
  assert.equal(ledger.balanceOf("u"), 20);

  const stalled = ledger.submit({
    userId: "u",
    groupName: "媒体台",
    idempotencyKey: "stall",
    model: "video-ray",
    duration: 10,
    prompt: "[[stall]]",
    now: 20_000,
    id: "stall-1",
  });
  assert.equal(stalled.ok, true);
  assert.equal(ledger.balanceOf("u"), 19.4);
  const timedOut = ledger.read("stall-1", "u", 21_500);
  assert.equal(timedOut.ok, true);
  if (timedOut.ok) assert.equal(timedOut.task.status, "timeout");
  assert.equal(ledger.balanceOf("u"), 20);
  const reread = ledger.read("stall-1", "u", 30_000);
  assert.equal(reread.ok, true);
  if (reread.ok) assert.equal(reread.task.id, "stall-1");
  assert.equal(ledger.balanceOf("u"), 20);
});

test("a completed mock task charges once", () => {
  const ledger = new VideoLedger({ u: 10 });
  const created = ledger.submit({
    userId: "u",
    groupName: "媒体台",
    idempotencyKey: "ok",
    model: "minimax-h3-origin-quality",
    duration: 15,
    prompt: "完成",
    now: 40_000,
    id: "ok-1",
  });
  assert.equal(created.ok, true);
  const done = ledger.read("ok-1", "u", 42_000);
  assert.equal(done.ok, true);
  if (done.ok) {
    assert.equal(done.task.status, "completed");
    assert.equal(done.task.charged, true);
    assert.equal(done.task.priceUsd, 4.5);
  }
  ledger.read("ok-1", "u", 50_000);
  assert.equal(ledger.balanceOf("u"), 5.5);
});

test("insufficient balance does not open a task", () => {
  const ledger = new VideoLedger({ u: 1 });
  const result = ledger.submit({
    userId: "u",
    groupName: "媒体台",
    idempotencyKey: "poor",
    model: "DB-SD-2.0-Fast",
    duration: 15,
    prompt: "太贵",
    now: 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "insufficient");
  assert.equal(ledger.read("missing", "u").ok, false);
  assert.equal(ledger.balanceOf("u"), 1);
});

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
