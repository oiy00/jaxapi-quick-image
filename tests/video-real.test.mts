import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FORBIDDEN_MEDIA_GROUP_ID, MEDIA_GROUP_ID, pickImageGroup, selectMediaGrant } from "../lib/keys.ts";
import { estimateVideoCost } from "../lib/pricing.ts";
import { fetchRelayMediaGrant } from "../lib/relay-account.ts";
import { createSuperGptVideo, pollSuperGptVideo, readSuperGptContent, videoContentUrl } from "../lib/supergpt-video.ts";
import { supergptVideoCreateBody } from "../lib/videos.ts";
import { MemoryBilling } from "../lib/video-billing-port.ts";
import { HOLD_FREEZE_SQL, RELEASE_SQL, SETTLE_SQL } from "../lib/postgres-billing.ts";
import { readVideoConfig } from "../lib/video-config.ts";
import { VideoFlow, type VideoUpstream } from "../lib/video-flow.ts";
import { videoPost } from "../lib/video-route.ts";
import { FileJobStore } from "../lib/video-store.ts";
import type { ApiGroup, ApiKeyRecord } from "../lib/types.ts";

const caller = { userId: 4, groupId: MEDIA_GROUP_ID, groupName: "媒体台" };

test("hold SQL freezes available funds and release does not credit balance", () => {
  assert.match(HOLD_FREEZE_SQL, /balance - frozen_balance >=/);
  assert.match(SETTLE_SQL, /balance = balance - \$2::numeric/);
  assert.match(SETTLE_SQL, /frozen_balance = frozen_balance - \$2::numeric/);
  assert.doesNotMatch(RELEASE_SQL, /(^|[^_])balance =/);
  assert.match(RELEASE_SQL, /frozen_balance = frozen_balance - \$2::numeric/);
});

test("sell prices stay on the configured table and verified bodies keep 1344x768", () => {
  assert.equal(estimateVideoCost({ model: "muse-video", duration: 10 })?.totalUsd, 1.2);
  assert.equal(estimateVideoCost({ model: "minimax-h3-base-fast", duration: 10 })?.totalUsd, 0.6);
  assert.equal(estimateVideoCost({ model: "video-ray", duration: 10 })?.totalUsd, 0.6);
  assert.equal(estimateVideoCost({ model: "muse-video", duration: 15 }), null);
  const musePrompt = "A calm sunset over the ocean, slow camera pan, no people, no text.";
  const muse = supergptVideoCreateBody({ model: "muse-video", prompt: musePrompt, duration: 10 });
  assert.equal(JSON.stringify(muse), JSON.stringify({ model: "muse-video", prompt: musePrompt, seconds: 10, size: "1280x720" }));
  assert.equal(muse && "duration" in muse, false);
  const minimax = supergptVideoCreateBody({ model: "minimax-h3-base-fast", prompt: "河面", duration: 10 });
  assert.equal(JSON.stringify(minimax), JSON.stringify({ model: "minimax-h3-base-fast", prompt: "河面", seconds: 10, size: "1344x768" }));
  assert.equal(supergptVideoCreateBody({ model: "video-ray", prompt: "河面", duration: 10 }), null);
  assert.equal(supergptVideoCreateBody({ model: "muse-video", prompt: "河面", duration: 60 }), null);
});

test("live config refuses stock billing and a relative job file", () => {
  assert.equal(readVideoConfig({ VIDEO_BILLING_ADAPTER: "sql", SUPERGPT_API_KEY: "sk-test-key" }).ok, false);
  assert.equal(readVideoConfig({ VIDEO_BILLING_ADAPTER: "sub2api", SUPERGPT_API_KEY: "sk-test-key" }).ok, false);
  assert.equal(readVideoConfig({ VIDEO_BILLING_ADAPTER: "off", SUPERGPT_API_KEY: "sk-test-key" }).ok, false);
  const missingStore = readVideoConfig({
    VIDEO_BILLING_ADAPTER: "postgres",
    VIDEO_DATABASE_URL: "postgresql://media_video_billing@postgres:5432/sub2api",
    SUPERGPT_API_KEY: "sk-test-key",
  });
  assert.equal(missingStore.ok, false);
  const ready = readVideoConfig({
    VIDEO_BILLING_ADAPTER: "database",
    VIDEO_DATABASE_URL: "postgresql://media_video_billing@postgres:5432/sub2api",
    SUPERGPT_API_KEY: "sk-test-key",
    VIDEO_JOB_STORE: "/data/video-jobs.json",
  });
  assert.equal(ready.ok, true);
});

test("group 7 is never selected or granted", () => {
  const groups: ApiGroup[] = [
    { id: FORBIDDEN_MEDIA_GROUP_ID, name: "媒体台", platform: "openai", status: "active", allow_image_generation: true },
    { id: MEDIA_GROUP_ID, name: "媒体台", platform: "openai", status: "active", allow_image_generation: true },
  ];
  assert.equal(pickImageGroup(groups)?.id, MEDIA_GROUP_ID);
  assert.equal(pickImageGroup([groups[0]])?.id, undefined);
  const keys: ApiKeyRecord[] = [
    key(1, FORBIDDEN_MEDIA_GROUP_ID, "媒体台"),
    key(2, MEDIA_GROUP_ID, "媒体台"),
  ];
  assert.equal(selectMediaGrant([keys[0]]).ok, false);
  const grant = selectMediaGrant(keys);
  assert.equal(grant.ok, true);
  if (grant.ok) assert.equal(grant.groupId, 11);
});

test("relay auth ignores redirects and requires group 11", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(url);
    assert.equal((init as RequestInit).redirect, "manual");
    if (url.endsWith("/api/v1/auth/me")) {
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/steal" } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const redirected = await fetchRelayMediaGrant({ baseUrl: "https://jaxapi.top", token: "login-token", fetchImpl });
  assert.equal(redirected.ok, false);
  if (!redirected.ok) assert.equal(redirected.code, "upstream_unknown");
  assert.equal(seen.some((url) => url.includes("127.0.0.1")), false);

  const okFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/me")) return Response.json({ id: 4, email: "a@b.c", balance: 9 });
    if (url.includes("/api/v1/keys")) {
      return Response.json({ items: [{ id: 2, key: "secret-key", status: "active", group_id: 11, group: { id: 11, name: "媒体台", status: "active" } }], pages: 1 });
    }
    if (url.endsWith("/api/v1/groups/available")) return Response.json([]);
    throw new Error(url);
  };
  const granted = await fetchRelayMediaGrant({ baseUrl: "https://jaxapi.top", token: "login-token", fetchImpl: okFetch });
  assert.equal(granted.ok, true);
  if (granted.ok) assert.equal(granted.groupId, 11);
});

test("upstream client does not follow redirects or response urls", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal((init as RequestInit).redirect, "manual");
    assert.equal(new Headers((init as RequestInit).headers).get("user-agent"), "curl/8.5.0");
    return new Response(JSON.stringify({ url: "http://127.0.0.1/secret" }), {
      status: 302,
      headers: { location: "http://169.254.169.254/latest", "content-type": "application/json" },
    });
  };
  const created = await createSuperGptVideo({
    baseUrl: "https://api.supergpt.dev/v1",
    apiKey: "sk-test-key",
    body: { model: "muse-video", prompt: "河", seconds: 10, size: "1280x720" },
    fetchImpl,
  });
  const accepted = await createSuperGptVideo({
    baseUrl: "https://api.supergpt.dev/v1",
    apiKey: "sk-test-key",
    body: { model: "muse-video", prompt: "河", seconds: 10, size: "1280x720" },
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers((init as RequestInit).headers).get("accept"), "application/json");
      assert.equal(new Headers((init as RequestInit).headers).get("content-type"), "application/json");
      return new Response(JSON.stringify({ id: "video_ok", status: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(accepted.kind, "accepted");
  assert.equal(created.kind, "ambiguous");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://api.supergpt.dev/v1/videos");

  const contentCalls: string[] = [];
  const content = await readSuperGptContent({
    baseUrl: "https://api.supergpt.dev/v1",
    apiKey: "sk-test-key",
    upstreamId: "video_1",
    fetchImpl: async (input, init) => {
      contentCalls.push(String(input));
      assert.equal((init as RequestInit).redirect, "manual");
      return new Response(JSON.stringify({ url: "http://127.0.0.1/secret.mp4" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(content.kind, "refused");
  assert.deepEqual(contentCalls, [videoContentUrl("https://api.supergpt.dev/v1", "video_1")]);
  const polled = await pollSuperGptVideo({
    baseUrl: "https://api.supergpt.dev/v1",
    apiKey: "sk-test-key",
    upstreamId: "../admin",
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.equal(polled.kind, "ambiguous");
});

test("unconfigured route does not call upstream", async () => {
  let upstream = 0;
  const response = await videoPost(new Request("https://app.local/api/videos", { method: "POST", body: "{}" }), {
    authenticate: async () => ({ ok: true, userId: 4, balance: 10, groupId: 11, groupName: "媒体台" }),
    flow: null,
    unconfiguredCode: "billing_unconfigured",
  });
  assert.equal(response.status, 401);
  const authed = await videoPost(
    new Request("https://app.local/api/videos", {
      method: "POST",
      headers: { authorization: "Bearer login-token", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "idem-123456", model: "muse-video", duration: 10, prompt: "河" }),
    }),
    {
      authenticate: async () => ({ ok: true, userId: 4, balance: 10, groupId: 11, groupName: "媒体台" }),
      flow: null,
      unconfiguredCode: "billing_unconfigured",
    },
  );
  assert.equal(authed.status, 503);
  assert.equal(upstream, 0);
});

test("real flow charges the sell table once and refuses unproven, poor, and foreign jobs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jax-video-"));
  try {
    const storePath = path.join(dir, "jobs.json");
    const billing = new MemoryBilling({ 4: 10, 5: 10 });
    const upstream = new FakeUpstream();
    const flow = new VideoFlow(new FileJobStore(storePath), billing, upstream, () => "2026-11-23T00:00:00.000Z");

    const denied = await flow.submit({ caller: { userId: 4, groupId: 7, groupName: "媒体台" }, idempotencyKey: "idem-group7", model: "muse-video", duration: 10, prompt: "河" });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "wrong_group");
    assert.equal(upstream.creates, 0);
    assert.equal(billing.balanceOf(4), 10);

    const ray = await flow.submit({ caller, idempotencyKey: "idem-ray-01", model: "video-ray", duration: 10, prompt: "河", clientPriceUsd: 0 });
    assert.equal(ray.ok, false);
    if (!ray.ok) assert.equal(ray.code, "unproven");
    assert.equal(billing.balanceOf(4), 10);

    const poor = new VideoFlow(new FileJobStore(path.join(dir, "poor.json")), new MemoryBilling({ 4: 0.5 }), new FakeUpstream());
    const short = await poor.submit({ caller, idempotencyKey: "idem-poor01", model: "muse-video", duration: 10, prompt: "河" });
    assert.equal(short.ok, false);
    if (!short.ok) assert.equal(short.code, "insufficient");

    const first = await flow.submit({ caller, idempotencyKey: "idem-muse01", model: "muse-video", duration: 10, prompt: "河面", clientPriceUsd: 0 });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.job.priceUsd, 1.2);
      assert.equal(first.job.size, "1280x720");
      assert.equal(first.job.status, "queued");
    }
    assert.equal(billing.balanceOf(4), 10);
    assert.equal(billing.frozenOf(4), 1.2);
    assert.equal(upstream.creates, 1);
    assert.equal(upstream.bodies[0]?.seconds, 10);
    assert.equal(upstream.bodies[0]?.size, "1280x720");
    assert.equal("duration" in (upstream.bodies[0] || {}), false);

    const again = await flow.submit({ caller, idempotencyKey: "idem-muse01", model: "muse-video", duration: 10, prompt: "河面" });
    assert.equal(again.ok, true);
    if (first.ok && again.ok) assert.equal(again.job.id, first.job.id);
    assert.equal(billing.balanceOf(4), 10);
    assert.equal(billing.frozenOf(4), 1.2);
    assert.equal(upstream.creates, 1);

    const other = await flow.status(first.ok ? first.job.id : "", 5);
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.code, "forbidden");
    const hidden = await flow.content(first.ok ? first.job.id : "", 5);
    assert.equal(hidden.result.ok, false);
    assert.equal(upstream.contentReads, 0);

    upstream.mode = "slow";
    const running = await flow.status(first.ok ? first.job.id : "", 4);
    assert.equal(running.ok, true);
    if (running.ok) assert.equal(running.job.status, "in_progress");
    assert.equal(billing.balanceOf(4), 10);
    assert.equal(billing.frozenOf(4), 1.2);
    assert.equal(upstream.creates, 1);

    upstream.mode = "timeout";
    const slow = await flow.status(first.ok ? first.job.id : "", 4);
    assert.equal(slow.ok, true);
    if (slow.ok) assert.equal(slow.job.status, "in_progress");
    assert.equal(billing.balanceOf(4), 10);
    assert.equal(billing.frozenOf(4), 1.2);

    upstream.mode = "done";
    const resumed = new VideoFlow(new FileJobStore(storePath), billing, upstream, () => "2026-11-23T00:10:00.000Z");
    const done = await resumed.status(first.ok ? first.job.id : "", 4);
    assert.equal(done.ok, true);
    if (done.ok) assert.equal(done.job.status, "completed");
    assert.equal(upstream.creates, 1);
    assert.equal(billing.balanceOf(4), 8.8);
    assert.equal(billing.frozenOf(4), 0);
    if (done.ok) assert.equal(done.job.balanceCharged, true);
    const clip = await resumed.content(first.ok ? first.job.id : "", 4);
    assert.equal(clip.payload?.kind, "ready");
    assert.equal(upstream.contentReads, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("confirmed failure reverses once; ambiguous post does not retry or refund", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jax-video-fail-"));
  try {
    const billing = new MemoryBilling({ 4: 10 });
    const failUpstream = new FakeUpstream();
    failUpstream.mode = "reject";
    const failing = new VideoFlow(new FileJobStore(path.join(dir, "fail.json")), billing, failUpstream);
    const failed = await failing.submit({ caller, idempotencyKey: "idem-fail01", model: "minimax-h3-base-fast", duration: 10, prompt: "河" });
    assert.equal(failed.ok, true);
    if (failed.ok) {
      assert.equal(failed.job.status, "failed");
      assert.equal(failed.job.debitState, "released");
      assert.equal(failed.job.balanceCharged, false);
      assert.equal(failed.job.priceUsd, 0.6);
      assert.equal(failed.job.size, "1344x768");
    }
    assert.equal(billing.balanceOf(4), 10);
    assert.equal(billing.frozenOf(4), 0);
    assert.equal(failUpstream.creates, 1);
    await failing.status(failed.ok ? failed.job.id : "", 4);
    assert.equal(billing.balanceOf(4), 10);
    assert.equal(billing.frozenOf(4), 0);
    assert.equal(failUpstream.creates, 1);

    const ambiguousUpstream = new FakeUpstream();
    ambiguousUpstream.mode = "ambiguous";
    const held = new MemoryBilling({ 4: 10 });
    const pending = new VideoFlow(new FileJobStore(path.join(dir, "unknown.json")), held, ambiguousUpstream);
    const unknown = await pending.submit({ caller, idempotencyKey: "idem-unknown", model: "muse-video", duration: 10, prompt: "河" });
    assert.equal(unknown.ok, true);
    if (unknown.ok) assert.equal(unknown.job.status, "upstream_unknown");
    assert.equal(held.balanceOf(4), 10);
    assert.equal(held.frozenOf(4), 1.2);
    const retry = await pending.submit({ caller, idempotencyKey: "idem-unknown", model: "muse-video", duration: 10, prompt: "河" });
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.job.status, "upstream_unknown");
    assert.equal(ambiguousUpstream.creates, 1);
    assert.equal(held.balanceOf(4), 10);
    assert.equal(held.frozenOf(4), 1.2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeUpstream implements VideoUpstream {
  creates = 0;
  polls = 0;
  contentReads = 0;
  bodies: { seconds?: number; size?: string }[] = [];
  mode: "queue" | "slow" | "timeout" | "done" | "reject" | "ambiguous" = "queue";

  async create(body: { seconds?: number; size?: string }) {
    this.creates += 1;
    this.bodies.push(body);
    if (this.mode === "reject") return { kind: "confirmed_failure" as const, status: 400, message: "上游拒绝了这次请求（400）。" };
    if (this.mode === "ambiguous") return { kind: "ambiguous" as const, message: "结果不明" };
    return { kind: "accepted" as const, upstreamId: "video_ok", status: "queued", progress: 0 };
  }

  async poll() {
    this.polls += 1;
    if (this.mode === "timeout") return { kind: "ambiguous" as const };
    if (this.mode === "slow") return { kind: "running" as const, status: "in_progress", progress: 40 };
    if (this.mode === "done") return { kind: "completed" as const, progress: 100 };
    return { kind: "running" as const, status: "queued", progress: 0 };
  }

  async content(upstreamId: string) {
    this.contentReads += 1;
    assert.equal(upstreamId, "video_ok");
    return { kind: "ready" as const, contentType: "video/mp4", body: new Uint8Array([1, 2, 3]) };
  }
}

function key(id: number, groupId: number, name: string): ApiKeyRecord {
  return {
    id,
    name: "JaxApi 媒体台",
    key: `secret-${id}-value`,
    group_id: groupId,
    status: "active",
    group: { id: groupId, name, platform: "openai", status: "active", allow_image_generation: true },
  };
}
