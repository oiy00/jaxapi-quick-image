import { MEDIA_GROUP_NAME } from "./keys.ts";
import { estimateVideoCost } from "./pricing.ts";

export type MockVideoStatus = "queued" | "in_progress" | "completed" | "failed" | "timeout";

export type VideoScript = "ok" | "fail" | "stall";

export type LedgerTask = {
  id: string;
  userId: string;
  groupName: string;
  idempotencyKey: string;
  model: string;
  duration: number;
  resolution: string;
  prompt: string;
  priceUsd: number;
  status: MockVideoStatus;
  progress: number;
  charged: boolean;
  released: boolean;
  createdAt: number;
  error?: string;
};

export type LedgerResult =
  | { ok: true; task: LedgerTask; balance: number }
  | { ok: false; code: "wrong_group" | "unknown_price" | "insufficient" | "forbidden" | "missing"; balance?: number };

type SubmitInput = {
  userId: string;
  groupName: string;
  idempotencyKey: string;
  model: string;
  duration: number;
  prompt: string;
  /** Ignored. Personal discounts must not change the table price. */
  clientMultiplier?: number;
  now?: number;
  id?: string;
};

const FAIL_AT_MS = 1000;
const STALL_AT_MS = 1500;
const COMPLETE_AT_MS = 2000;

export class VideoLedger {
  private balances = new Map<string, number>();
  private opened = new Set<string>();
  private tasks = new Map<string, LedgerTask>();
  private byKey = new Map<string, string>();

  constructor(opening: Record<string, number> = {}) {
    for (const [userId, balance] of Object.entries(opening)) {
      this.balances.set(userId, balance);
      this.opened.add(userId);
    }
  }

  /** First observation of a user sets the mock opening balance. Later calls do not refill. */
  ensureOpening(userId: string, amount: number): void {
    if (!userId || this.opened.has(userId)) return;
    this.opened.add(userId);
    this.balances.set(userId, amount);
  }

  balanceOf(userId: string): number {
    return this.balances.get(userId) ?? 0;
  }

  submit(input: SubmitInput): LedgerResult {
    const userId = input.userId.trim();
    const groupName = input.groupName.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!userId || !idempotencyKey) return { ok: false, code: "forbidden" };
    if (groupName !== MEDIA_GROUP_NAME) return { ok: false, code: "wrong_group", balance: this.balanceOf(userId) };

    const existingId = this.byKey.get(keyOf(userId, idempotencyKey));
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (!existing || existing.userId !== userId) return { ok: false, code: "forbidden" };
      this.project(existing, input.now ?? Date.now());
      return { ok: true, task: existing, balance: this.balanceOf(userId) };
    }

    const quote = estimateVideoCost({ model: input.model, duration: input.duration });
    if (!quote) return { ok: false, code: "unknown_price", balance: this.balanceOf(userId) };
    const balance = this.balanceOf(userId);
    if (balance + 1e-9 < quote.totalUsd) return { ok: false, code: "insufficient", balance };

    const now = input.now ?? Date.now();
    const task: LedgerTask = {
      id: input.id ?? `mock_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      groupName,
      idempotencyKey,
      model: quote.model,
      duration: quote.duration,
      resolution: quote.resolution,
      prompt: input.prompt,
      priceUsd: quote.totalUsd,
      status: "queued",
      progress: 0,
      charged: false,
      released: false,
      createdAt: now,
    };
    this.balances.set(userId, roundMoney(balance - quote.totalUsd));
    this.tasks.set(task.id, task);
    this.byKey.set(keyOf(userId, idempotencyKey), task.id);
    return { ok: true, task, balance: this.balanceOf(userId) };
  }

  read(taskId: string, userId: string, now = Date.now()): LedgerResult {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, code: "missing" };
    if (task.userId !== userId) return { ok: false, code: "forbidden" };
    this.project(task, now);
    return { ok: true, task, balance: this.balanceOf(userId) };
  }

  private project(task: LedgerTask, now: number): void {
    const elapsed = now - task.createdAt;
    const script = scriptOf(task.prompt);
    if (script === "fail" && elapsed >= FAIL_AT_MS) {
      this.fail(task, "上游拒绝了这条模拟任务。模拟账本已退回预扣，没有写成真实扣费。");
      return;
    }
    if (script === "stall" && elapsed >= STALL_AT_MS) {
      this.timeout(task);
      return;
    }
    if (script === "ok" && elapsed >= COMPLETE_AT_MS) {
      this.complete(task);
      return;
    }
    if (task.charged || task.released) return;
    if (elapsed < 700) {
      task.status = "queued";
      task.progress = 0;
      return;
    }
    task.status = "in_progress";
    task.progress = Math.min(90, Math.floor((elapsed - 700) / 14));
  }

  private complete(task: LedgerTask): void {
    if (task.released) return;
    task.status = "completed";
    task.progress = 100;
    task.charged = true;
  }

  private fail(task: LedgerTask, error: string): void {
    if (task.charged || task.released) return;
    task.status = "failed";
    task.error = error;
    task.released = true;
    this.balances.set(task.userId, roundMoney(this.balanceOf(task.userId) + task.priceUsd));
  }

  private timeout(task: LedgerTask): void {
    if (task.charged || task.released) return;
    task.status = "timeout";
    task.error = "模拟任务超时。没有自动重新提交。预扣已退回模拟账本。";
    task.released = true;
    this.balances.set(task.userId, roundMoney(this.balanceOf(task.userId) + task.priceUsd));
  }
}

export function scriptOf(prompt: string): VideoScript {
  if (prompt.includes("[[fail]]")) return "fail";
  if (prompt.includes("[[stall]]")) return "stall";
  return "ok";
}

function keyOf(userId: string, idempotencyKey: string): string {
  return `${userId}\n${idempotencyKey}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Sub2API 0.2.24 only bills 480p/720p/1080p and clamps duration to 1–15 seconds. */
export function sub2apiResolutionKnown(resolution: string): boolean {
  return resolution === "480p" || resolution === "720p" || resolution === "1080p";
}

export function sub2apiClampedSeconds(duration: number): number {
  if (duration <= 0) return 8;
  return Math.min(15, Math.max(1, duration));
}
