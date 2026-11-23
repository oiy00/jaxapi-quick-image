import { randomUUID } from "node:crypto";
import { videoGroupRejection } from "./keys.ts";
import { estimateVideoCost } from "./pricing.ts";
import { isVerifiedVideoRequest } from "./video-models.ts";
import { createSuperGptVideo, pollSuperGptVideo, readSuperGptContent, type ContentOutcome, type CreateOutcome, type PollOutcome } from "./supergpt-video.ts";
import { supergptVideoCreateBody, type SuperGptVideoBody } from "./videos.ts";
import { BillingAmbiguous, ReleaseAmbiguous, type BillingPort } from "./video-billing-port.ts";
import { nextAction, type VideoJob } from "./video-job.ts";
import { FileJobStore } from "./video-store.ts";

const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,80}$/;

export type PublicVideoJob = {
  id: string;
  status: VideoJob["status"];
  progress: number;
  model: string;
  duration: number;
  resolution: string;
  size: string;
  priceUsd: number;
  debitState: VideoJob["debitState"];
  balanceCharged: boolean;
  error: string | null;
  upstreamKnown: boolean;
};

export type FlowOk = { ok: true; http: number; job: PublicVideoJob; balance: number | null };
export type FlowErr = { ok: false; http: number; code: string; message: string; balance?: number | null; job?: PublicVideoJob };
export type FlowResult = FlowOk | FlowErr;

export type VideoCaller = { userId: number; groupId: number; groupName: string };

export type VideoUpstream = {
  create(body: SuperGptVideoBody): Promise<CreateOutcome>;
  poll(upstreamId: string): Promise<PollOutcome>;
  content(upstreamId: string): Promise<ContentOutcome>;
};

export function superGptUpstream(input: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): VideoUpstream {
  return {
    create: (body) => createSuperGptVideo({ ...input, body }),
    poll: (upstreamId) => pollSuperGptVideo({ ...input, upstreamId }),
    content: (upstreamId) => readSuperGptContent({ ...input, upstreamId }),
  };
}

export class VideoFlow {
  private readonly store: FileJobStore;
  private readonly billing: BillingPort;
  private readonly upstream: VideoUpstream;
  private readonly now: () => string;

  constructor(store: FileJobStore, billing: BillingPort, upstream: VideoUpstream, now: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.billing = billing;
    this.upstream = upstream;
    this.now = now;
  }

  async submit(input: {
    caller: VideoCaller;
    idempotencyKey: string;
    model: string;
    duration: number;
    prompt: string;
    /** Ignored. The sale price always comes from the configured table. */
    clientPriceUsd?: number;
  }): Promise<FlowResult> {
    const group = videoGroupRejection({ id: input.caller.groupId, name: input.caller.groupName });
    if (group) return fail(403, "wrong_group", "当前账户没有媒体台分组 11 的可用密钥。不会使用分组 7，也没有向视频上游提交。");
    void input.clientPriceUsd;
    if (!IDEMPOTENCY.test(input.idempotencyKey)) return fail(400, "forbidden", "缺少有效的幂等键，没有提交。");
    const quote = estimateVideoCost({ model: input.model, duration: input.duration });
    if (!quote) return fail(400, "unknown_price", "这个模型或时长没有已配置的售价，已拒绝。");
    if (!isVerifiedVideoRequest(input.model, input.duration)) {
      return fail(400, "unproven", "这一档没有已完成的上游记录，暂不提交，也不扣费。");
    }
    const body = supergptVideoCreateBody({ model: input.model, prompt: input.prompt, duration: input.duration });
    if (!body) return fail(400, "unproven", "这一档不能组成已核实的上游请求，没有提交。");

    const job = await this.store.transact((book) => {
      const existing = book.getByIdempotency(input.caller.userId, input.idempotencyKey);
      if (existing) return existing;
      const created: VideoJob = {
        id: `job_${randomUUID()}`,
        userId: input.caller.userId,
        idempotencyKey: input.idempotencyKey,
        model: quote.model,
        duration: quote.duration,
        resolution: quote.resolution,
        size: body.size,
        prompt: body.prompt,
        priceUsd: quote.totalUsd,
        status: "reserved",
        progress: 0,
        upstreamAttempted: false,
        upstreamId: null,
        debitState: "none",
        reversalUnknown: false,
        error: null,
        balanceAfter: null,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      const inserted = book.insert(created);
      return inserted.ok ? inserted.job : inserted.conflict;
    });
    return this.progress(job.id, input.caller.userId, { allowPost: true });
  }

  async status(jobId: string, userId: number): Promise<FlowResult> {
    const job = await this.store.transact((book) => book.getById(jobId));
    if (!job || job.userId !== userId) return fail(404, "forbidden", "没有找到这个任务。");
    return this.progress(job.id, userId, { allowPost: false });
  }

  async statusByIdempotency(idempotencyKey: string, userId: number): Promise<FlowResult> {
    const job = await this.store.transact((book) => book.getByIdempotency(userId, idempotencyKey));
    if (!job) return fail(404, "missing", "这次提交没有落到服务端。没有自动重新提交。");
    return this.progress(job.id, userId, { allowPost: true });
  }

  async content(jobId: string, userId: number): Promise<{ result: FlowResult; payload?: ContentOutcome }> {
    const job = await this.store.transact((book) => book.getById(jobId));
    if (!job || job.userId !== userId) return { result: fail(404, "forbidden", "没有找到这个任务。") };
    if (job.status !== "completed" || !job.upstreamId) {
      return { result: fail(409, "not_ready", "视频还不能下载。", job) };
    }
    const payload = await this.upstream.content(job.upstreamId);
    if (payload.kind === "ready") return { result: ok(job), payload };
    if (payload.kind === "not_ready") return { result: fail(409, "not_ready", "视频还不能下载。", job) };
    if (payload.kind === "refused") return { result: fail(502, "upstream_rejected", payload.message, job) };
    return { result: fail(504, "upstream_unknown", "读取视频内容没有得到明确结果。没有改用样片。", job) };
  }

  private async progress(jobId: string, userId: number, options: { allowPost: boolean }): Promise<FlowResult> {
    for (let step = 0; step < 5; step += 1) {
      const job = await this.store.transact((book) => book.getById(jobId));
      if (!job || job.userId !== userId) return fail(404, "forbidden", "没有找到这个任务。");
      const action = nextAction(job);
      if (action === "respond") return present(job);
      if (action === "debit") {
        await this.applyDebit(job);
        continue;
      }
      if (action === "post") {
        if (!options.allowPost) return present(job);
        await this.applyPost(job);
        const posted = await this.store.transact((book) => book.getById(jobId));
        if (posted?.status === "failed") continue;
        return posted ? present(posted) : fail(404, "missing", "没有找到这个任务。");
      }
      if (action === "release") {
        await this.applyRelease(job);
        continue;
      }
      if (action === "settle") {
        await this.applySettle(job);
        return present((await this.store.transact((book) => book.getById(jobId))) ?? job);
      }
      const polled = await this.applyPoll(job);
      if (polled === "stop") break;
    }
    const job = await this.store.transact((book) => book.getById(jobId));
    return job ? present(job) : fail(404, "missing", "没有找到这个任务。");
  }

  private async applyDebit(job: VideoJob): Promise<void> {
    let result: Awaited<ReturnType<BillingPort["hold"]>>;
    try {
      result = await this.billing.hold({ userId: job.userId, amountUsd: job.priceUsd, idempotencyKey: job.id });
    } catch (error) {
      if (error instanceof BillingAmbiguous) {
        await this.store.transact((book) => {
          const current = book.getById(job.id);
          if (!current || current.debitState !== "none") return;
          current.status = "debit_unknown";
          current.error = error.message;
          current.updatedAt = this.now();
          book.save(current);
        });
        return;
      }
      throw error;
    }
    await this.store.transact((book) => {
      const current = book.getById(job.id);
      if (!current || current.debitState === "held" || current.debitState === "settled" || current.debitState === "released") return;
      current.balanceAfter = result.balance;
      current.updatedAt = this.now();
      if (!result.ok) {
        current.status = "failed";
        current.error = "可用余额不足（余额减去冻结）。没有冻结，也没有向视频上游提交。";
      } else {
        current.debitState = "held";
        current.status = "held";
        current.error = null;
      }
      book.save(current);
    });
  }

  private async applyPost(job: VideoJob): Promise<void> {
    const claimed = await this.store.transact((book) => {
      const current = book.getById(job.id);
      if (!current || current.upstreamAttempted || current.upstreamId || current.debitState !== "held") return false;
      current.upstreamAttempted = true;
      current.status = "upstream_unknown";
      current.updatedAt = this.now();
      book.save(current);
      return true;
    });
    if (!claimed) return;
    const body = supergptVideoCreateBody({ model: job.model, prompt: job.prompt, duration: job.duration });
    const outcome: CreateOutcome = body
      ? await this.upstream.create(body)
      : { kind: "confirmed_failure", status: 400, message: "价格或尺寸不再有效，没有提交。" };
    await this.store.transact((book) => {
      const current = book.getById(job.id);
      if (!current || current.upstreamId) return;
      current.updatedAt = this.now();
      if (outcome.kind === "accepted") {
        current.upstreamId = outcome.upstreamId;
        current.status = outcome.status.toLowerCase() === "in_progress" ? "in_progress" : "queued";
        current.progress = outcome.progress ?? 0;
        current.error = null;
      } else if (outcome.kind === "confirmed_failure") {
        current.status = "failed";
        current.error = outcome.message;
      } else {
        current.status = "upstream_unknown";
        current.error = outcome.message;
      }
      book.save(current);
    });
  }

  private async applyRelease(job: VideoJob): Promise<void> {
    let result: Awaited<ReturnType<BillingPort["release"]>>;
    try {
      result = await this.billing.release({ userId: job.userId, amountUsd: job.priceUsd, idempotencyKey: job.id });
    } catch (error) {
      if (error instanceof ReleaseAmbiguous) {
        await this.store.transact((book) => {
          const current = book.getById(job.id);
          if (!current || current.reversalUnknown || current.debitState !== "held") return;
          current.reversalUnknown = true;
          current.error = error.message;
          current.updatedAt = this.now();
          book.save(current);
        });
        return;
      }
      throw error;
    }
    await this.store.transact((book) => {
      const current = book.getById(job.id);
      if (!current || current.debitState === "released" || current.debitState === "settled") return;
      current.updatedAt = this.now();
      current.balanceAfter = result.balance;
      if (result.ok) {
        current.debitState = "released";
        current.reversalUnknown = false;
        current.error = current.error || "上游已明确失败。冻结已解除，余额没有增加。";
      } else {
        current.reversalUnknown = true;
        current.error = current.error || "没有找到可解除的冻结。余额没有增加。";
      }
      book.save(current);
    });
  }

  private async applySettle(job: VideoJob): Promise<void> {
    let result: Awaited<ReturnType<BillingPort["settle"]>>;
    try {
      result = await this.billing.settle({ userId: job.userId, amountUsd: job.priceUsd, idempotencyKey: job.id });
    } catch (error) {
      if (error instanceof BillingAmbiguous) {
        await this.store.transact((book) => {
          const current = book.getById(job.id);
          if (!current || current.debitState !== "held") return;
          current.reversalUnknown = true;
          current.error = error.message;
          current.updatedAt = this.now();
          book.save(current);
        });
        return;
      }
      throw error;
    }
    await this.store.transact((book) => {
      const current = book.getById(job.id);
      if (!current || current.debitState === "settled") return;
      current.updatedAt = this.now();
      current.balanceAfter = result.balance;
      if (result.ok) {
        current.debitState = "settled";
        current.error = null;
      } else if (result.code === "settle_blocked") {
        current.error = "视频已完成，但冻结没能转成扣费。余额没有增加，冻结仍留在账上。";
      } else {
        current.reversalUnknown = true;
        current.error = current.error || "没有找到可结算的冻结。余额没有增加。";
      }
      book.save(current);
    });
  }

  private async applyPoll(job: VideoJob): Promise<"continue" | "stop"> {
    if (!job.upstreamId) return "stop";
    const outcome = await this.upstream.poll(job.upstreamId);
    let next: "continue" | "stop" = "stop";
    await this.store.transact((book) => {
      const current = book.getById(job.id);
      if (!current || current.status === "completed" || current.status === "failed") return;
      current.updatedAt = this.now();
      if (outcome.kind === "ambiguous") return;
      if (outcome.kind === "running") {
        current.status = "in_progress";
        current.progress = outcome.progress ?? current.progress;
        current.error = null;
      } else if (outcome.kind === "completed") {
        current.status = "completed";
        current.progress = 100;
        current.error = null;
        next = "continue";
      } else {
        current.status = "failed";
        current.error = outcome.message;
        next = "continue";
      }
      book.save(current);
    });
    return next;
  }
}

function present(job: VideoJob): FlowResult {
  if (job.status === "failed" && job.debitState === "none") {
    return fail(402, "insufficient", job.error || "余额不足，没有向视频上游提交。", job);
  }
  return ok(job);
}

function ok(job: VideoJob): FlowOk {
  const unresolved = job.status === "upstream_unknown" || job.status === "debit_unknown";
  return { ok: true, http: unresolved ? 202 : 200, job: publish(job), balance: job.balanceAfter };
}

function fail(http: number, code: string, message: string, job?: VideoJob): FlowErr {
  return { ok: false, http, code, message, balance: job?.balanceAfter ?? null, job: job ? publish(job) : undefined };
}

function publish(job: VideoJob): PublicVideoJob {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    model: job.model,
    duration: job.duration,
    resolution: job.resolution,
    size: job.size,
    priceUsd: job.priceUsd,
    debitState: job.debitState,
    balanceCharged: job.debitState === "settled",
    error: job.error,
    upstreamKnown: Boolean(job.upstreamId),
  };
}
