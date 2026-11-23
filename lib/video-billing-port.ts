import { addMoney, compareMoney, moneyEquals, moneyFromNumber, moneyToNumber, subMoney, type Money } from "./money.ts";

export type HoldResult =
  | { ok: true; balance: number; frozen: number; alreadyApplied: boolean }
  | { ok: false; code: "insufficient" | "revoked"; balance: number; frozen: number };

export type SettleResult =
  | { ok: true; balance: number; frozen: number; alreadyApplied: boolean }
  | { ok: false; code: "settle_blocked" | "not_held"; balance: number; frozen: number };

export type ReleaseResult =
  | { ok: true; balance: number; frozen: number; alreadyReleased: boolean }
  | { ok: false; code: "not_held"; balance: number; frozen: number };

export class BillingAmbiguous extends Error {
  constructor(message = "冻结结果不明，没有向视频上游提交，也没有自动再冻一次。") {
    super(message);
    this.name = "BillingAmbiguous";
  }
}

export class ReleaseAmbiguous extends Error {
  constructor(message = "解除冻结的结果不明。没有改动余额，也没有自动再解一次。") {
    super(message);
    this.name = "ReleaseAmbiguous";
  }
}

export type BillingPort = {
  /** Debit users.balance once into escrow. Does not write frozen_balance. */
  hold(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<HoldResult>;
  /** Mark the escrow final. Does not debit again. */
  settle(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<SettleResult>;
  /** Credit the escrowed amount back once after a confirmed failure. */
  release(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<ReleaseResult>;
};

type Wallet = { balance: Money; frozen: Money };
type Charge = { userId: number; amount: Money; state: "held" | "settled" | "released" | "rejected" };

/**
 * Same hold, settle, and release rules as the Postgres ledger.
 * Used by flow tests. Production uses PostgresBilling.
 */
export class MemoryBilling implements BillingPort {
  private wallets = new Map<number, Wallet>();
  private charges = new Map<string, Charge>();

  constructor(opening: Record<number, number> = {}) {
    for (const [userId, amount] of Object.entries(opening)) {
      this.wallets.set(Number(userId), { balance: moneyFromNumber(amount), frozen: moneyFromNumber(0) });
    }
  }

  balanceOf(userId: number): number {
    return moneyToNumber(this.wallet(userId).balance);
  }

  frozenOf(userId: number): number {
    return moneyToNumber(this.wallet(userId).frozen);
  }

  async hold(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<HoldResult> {
    const amount = moneyFromNumber(input.amountUsd);
    const existing = this.charges.get(input.idempotencyKey);
    if (existing && (existing.userId !== input.userId || !moneyEquals(existing.amount, amount))) {
      throw new BillingAmbiguous("幂等键已被另一笔金额占用。");
    }
    if (existing?.state === "held" || existing?.state === "settled" || existing?.state === "released") {
      const wallet = this.wallet(existing.userId);
      return { ok: true, balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen), alreadyApplied: true };
    }
    if (existing?.state === "rejected") {
      const wallet = this.wallet(existing.userId);
      return { ok: false, code: "insufficient", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
    }
    const wallet = this.wallet(input.userId);
    const available = subMoney(wallet.balance, wallet.frozen);
    if (compareMoney(available, amount) < 0) {
      this.charges.set(input.idempotencyKey, { userId: input.userId, amount, state: "rejected" });
      return { ok: false, code: "insufficient", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
    }
    wallet.balance = subMoney(wallet.balance, amount);
    this.charges.set(input.idempotencyKey, { userId: input.userId, amount, state: "held" });
    return { ok: true, balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen), alreadyApplied: false };
  }

  async settle(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<SettleResult> {
    const amount = moneyFromNumber(input.amountUsd);
    const existing = this.charges.get(input.idempotencyKey);
    const wallet = this.wallet(input.userId);
    if (!existing || existing.state === "rejected" || existing.state === "released" || existing.userId !== input.userId) {
      return { ok: false, code: "not_held", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
    }
    if (existing.state === "settled") {
      return { ok: true, balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen), alreadyApplied: true };
    }
    if (!moneyEquals(existing.amount, amount)) {
      return { ok: false, code: "not_held", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
    }
    existing.state = "settled";
    return { ok: true, balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen), alreadyApplied: false };
  }

  async release(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<ReleaseResult> {
    const amount = moneyFromNumber(input.amountUsd);
    const existing = this.charges.get(input.idempotencyKey);
    const wallet = this.wallet(input.userId);
    if (!existing || existing.state === "rejected" || existing.state === "settled" || existing.userId !== input.userId) {
      return { ok: false, code: "not_held", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
    }
    if (existing.state === "released") {
      return { ok: true, balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen), alreadyReleased: true };
    }
    if (!moneyEquals(existing.amount, amount)) {
      throw new ReleaseAmbiguous("退回金额和账本不一致，没有退回。");
    }
    wallet.balance = addMoney(wallet.balance, existing.amount);
    existing.state = "released";
    return { ok: true, balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen), alreadyReleased: false };
  }

  private wallet(userId: number): Wallet {
    const found = this.wallets.get(userId);
    if (found) return found;
    const created = { balance: moneyFromNumber(0), frozen: moneyFromNumber(0) };
    this.wallets.set(userId, created);
    return created;
  }
}

