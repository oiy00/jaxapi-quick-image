import assert from "node:assert/strict";
import test from "node:test";
import { BalanceSequencer, ImageRequestTracker, MAX_CONCURRENT_IMAGES } from "../lib/image-concurrency.ts";

test("the page allows five requests at once", () => {
  assert.equal(MAX_CONCURRENT_IMAGES, 5);
  const tracker = new ImageRequestTracker();
  for (let i = 0; i < 5; i += 1) assert.equal(tracker.start(`r${i}`), true);
  assert.equal(tracker.canStart(), false);
  assert.equal(tracker.start("r5"), false);
  assert.equal(tracker.size, 5);
  tracker.finish("r2");
  assert.equal(tracker.start("r5"), true);
});

test("a request alone keeps its balance difference as its cost", () => {
  const tracker = new ImageRequestTracker();
  tracker.start("a");
  assert.deepEqual(tracker.finish("a"), { overlapped: false });
});

test("overlapping requests both lose their own cost, in either finishing order", () => {
  const tracker = new ImageRequestTracker();
  tracker.start("a");
  tracker.start("b");
  assert.deepEqual(tracker.finish("b"), { overlapped: true });
  assert.deepEqual(tracker.finish("a"), { overlapped: true });
  tracker.start("c");
  assert.deepEqual(tracker.finish("c"), { overlapped: false });
});

test("a request started after another finished does not count as overlap", () => {
  const tracker = new ImageRequestTracker();
  tracker.start("a");
  tracker.finish("a");
  tracker.start("b");
  assert.deepEqual(tracker.finish("b"), { overlapped: false });
});

test("an outside balance change taints every active request", () => {
  const tracker = new ImageRequestTracker();
  tracker.start("a");
  tracker.markBalanceMoved();
  assert.deepEqual(tracker.finish("a"), { overlapped: true });
});

test("finishing twice is harmless and frees one slot", () => {
  const tracker = new ImageRequestTracker(1);
  tracker.start("a");
  tracker.finish("a");
  tracker.finish("a");
  assert.equal(tracker.size, 0);
  assert.equal(tracker.start("b"), true);
});

test("an older balance read cannot overwrite a newer one", () => {
  const seq = new BalanceSequencer();
  const first = seq.ticket();
  const second = seq.ticket();
  assert.equal(seq.accept(second), true);
  assert.equal(seq.accept(first), false);
  assert.equal(seq.accept(seq.ticket()), true);
});
