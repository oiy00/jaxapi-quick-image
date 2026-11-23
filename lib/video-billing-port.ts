export type DebitResult =
  | { ok: true; balance: number; alreadyApplied: boolean }
  | { ok: false; code: "insufficient"; balance: number };

export type ReverseResult =
  | { ok: true; balance: number; alreadyReversed: boolean }
  | { ok: false; code: "not_debited"; balance: number };

export class BillingAmbiguous extends Error {
  constructor(message = "扣费结果不明，没有向视频上游提交，也没有自动再扣一次。") {
    super(message);
    this.name = "BillingAmbiguous";
  }
}

export class ReverseAmbiguous extends Error {
  constructor(message = "退款结果不明。没有自动再退一次。") {
    super(message);
    this.name = "ReverseAmbiguous";
  }
}

export type BillingPort = {
  debit(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<DebitResult>;
  reverse(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<ReverseResult>;
};

type Charge = { userId: number; amount: number; state: "debited" | "reversed" | "rejected" };

/** In-process atomic ledger. Tests only. Not a jaxapi account. */
export class MemoryBilling implements BillingPort {
  private balances = new Map<number, number>();
  private charges = new Map<string, Charge>();

  constructor(opening: Record<number, number> = {}) {
    for (const [userId, amount] of Object.entries(opening)) this.balances.set(Number(userId), amount);
  }

  balanceOf(userId: number): number {
    return this.balances.get(userId) ?? 0;
  }

  async debit(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<DebitResult> {
    const existing = this.charges.get(input.idempotencyKey);
    if (existing?.state === "debited" || existing?.state === "reversed") {
      return { ok: true, balance: this.balanceOf(existing.userId), alreadyApplied: true };
    }
    if (existing?.state === "rejected") {
      return { ok: false, code: "insufficient", balance: this.balanceOf(existing.userId) };
    }
    const balance = this.balanceOf(input.userId);
    if (!(input.amountUsd > 0) || balance + 1e-9 < input.amountUsd) {
      this.charges.set(input.idempotencyKey, { userId: input.userId, amount: input.amountUsd, state: "rejected" });
      return { ok: false, code: "insufficient", balance };
    }
    const next = roundMoney(balance - input.amountUsd);
    this.balances.set(input.userId, next);
    this.charges.set(input.idempotencyKey, { userId: input.userId, amount: input.amountUsd, state: "debited" });
    return { ok: true, balance: next, alreadyApplied: false };
  }

  async reverse(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<ReverseResult> {
    const existing = this.charges.get(input.idempotencyKey);
    if (!existing || existing.state === "rejected") {
      return { ok: false, code: "not_debited", balance: this.balanceOf(input.userId) };
    }
    if (existing.userId !== input.userId) {
      return { ok: false, code: "not_debited", balance: this.balanceOf(input.userId) };
    }
    if (existing.state === "reversed") {
      return { ok: true, balance: this.balanceOf(input.userId), alreadyReversed: true };
    }
    if (Math.abs(existing.amount - input.amountUsd) > 1e-9) {
      throw new ReverseAmbiguous("退款金额和原扣费不一致，没有退款。");
    }
    const next = roundMoney(this.balanceOf(input.userId) + existing.amount);
    this.balances.set(input.userId, next);
    existing.state = "reversed";
    return { ok: true, balance: next, alreadyReversed: false };
  }
}

export function roundMoney(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

type FetchLike = typeof fetch;

/**
 * Ops-provided billing service. This process does not run refund SQL.
 * POST debit and reverse must be idempotent on idempotencyKey.
 * Redirects are not followed.
 */
export class HttpBilling implements BillingPort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, token: string, fetchImpl: FetchLike = fetch) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  debit(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<DebitResult> {
    return this.post("debit", input) as Promise<DebitResult>;
  }

  reverse(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<ReverseResult> {
    return this.post("reverse", input) as Promise<ReverseResult>;
  }

  private async post(action: "debit" | "reverse", input: { userId: number; amountUsd: number; idempotencyKey: string }) {
    const url = new URL(action, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new BillingAmbiguous("计费地址必须是 https，或本机回环。");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "curl/8.5.0",
        },
        body: JSON.stringify({
          userId: input.userId,
          amountUsd: input.amountUsd,
          idempotencyKey: input.idempotencyKey,
          groupId: 11,
        }),
      });
    } catch {
      throw action === "debit" ? new BillingAmbiguous() : new ReverseAmbiguous();
    }
    if (response.status >= 300 && response.status < 400) {
      throw action === "debit" ? new BillingAmbiguous("计费接口返回了重定向，没有跟随。") : new ReverseAmbiguous("退款接口返回了重定向，没有跟随。");
    }
    const payload = await response.json().catch(() => null);
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const balance = typeof record.balance === "number" ? record.balance : 0;
    if (action === "debit") {
      if (response.status === 402 || record.code === "insufficient") return { ok: false, code: "insufficient", balance };
      if (response.ok && record.ok !== false) {
        return { ok: true, balance, alreadyApplied: record.alreadyApplied === true };
      }
      throw new BillingAmbiguous();
    }
    if (response.ok && record.ok !== false) {
      return { ok: true, balance, alreadyReversed: record.alreadyReversed === true };
    }
    if (record.code === "not_debited") return { ok: false, code: "not_debited", balance };
    throw new ReverseAmbiguous();
  }
}
