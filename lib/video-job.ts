export type DebitState = "none" | "debited" | "reversed";

export type JobStatus =
  | "reserved"
  | "debit_unknown"
  | "held"
  | "upstream_unknown"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed";

export type VideoJob = {
  id: string;
  userId: number;
  idempotencyKey: string;
  model: string;
  duration: number;
  resolution: string;
  size: string;
  prompt: string;
  priceUsd: number;
  status: JobStatus;
  progress: number;
  upstreamAttempted: boolean;
  upstreamId: string | null;
  debitState: DebitState;
  reversalUnknown: boolean;
  error: string | null;
  balanceAfter: number | null;
  createdAt: string;
  updatedAt: string;
};

export type JobAction = "respond" | "debit" | "post" | "reverse" | "poll";

export function nextAction(job: VideoJob): JobAction {
  if (job.status === "completed" || job.status === "debit_unknown" || job.status === "upstream_unknown") return "respond";
  if (job.status === "failed") {
    if (job.debitState === "debited" && !job.reversalUnknown) return "reverse";
    return "respond";
  }
  if (job.debitState === "none") return "debit";
  if (job.debitState === "reversed") return "respond";
  if (!job.upstreamAttempted) return "post";
  if (!job.upstreamId) return "respond";
  if (job.status === "reserved" || job.status === "held" || job.status === "queued" || job.status === "in_progress") {
    return "poll";
  }
  return "respond";
}

export class JobBook {
  private jobs = new Map<string, VideoJob>();
  private byKey = new Map<string, string>();

  static fromJobs(jobs: VideoJob[]): JobBook {
    const book = new JobBook();
    for (const job of jobs) book.remember(job);
    return book;
  }

  list(): VideoJob[] {
    return [...this.jobs.values()];
  }

  getById(id: string): VideoJob | null {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  getByIdempotency(userId: number, idempotencyKey: string): VideoJob | null {
    const id = this.byKey.get(keyOf(userId, idempotencyKey));
    return id ? this.getById(id) : null;
  }

  insert(job: VideoJob): { ok: true; job: VideoJob } | { ok: false; conflict: VideoJob } {
    const existing = this.getByIdempotency(job.userId, job.idempotencyKey);
    if (existing) return { ok: false, conflict: existing };
    if (this.jobs.has(job.id)) return { ok: false, conflict: this.getById(job.id)! };
    this.remember(job);
    return { ok: true, job: clone(job) };
  }

  save(job: VideoJob): void {
    if (!this.jobs.has(job.id)) throw new Error("任务不存在，不能更新");
    this.remember(job);
  }

  private remember(job: VideoJob): void {
    const stored = clone(job);
    this.jobs.set(stored.id, stored);
    this.byKey.set(keyOf(stored.userId, stored.idempotencyKey), stored.id);
  }
}

function keyOf(userId: number, idempotencyKey: string): string {
  return `${userId}\n${idempotencyKey}`;
}

function clone(job: VideoJob): VideoJob {
  return { ...job };
}
