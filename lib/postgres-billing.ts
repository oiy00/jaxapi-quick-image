import { addMoney, compareMoney, moneyFromDecimal, moneyFromNumber, moneyToNumber, type Money } from "./money.ts";
import { BillingAmbiguous, ReleaseAmbiguous, type BillingPort, type HoldResult, type ReleaseResult, type SettleResult } from "./video-billing-port.ts";

/**
 * Upfront escrow debit. Available money is balance - frozen_balance, but the
 * video ledger never writes frozen_balance: stock DeductBalance ignores it.
 * The debit decreases balance only. Confirmed-failure credit adds the escrow
 * row's own amount once. Settle does not touch users.
 */
export const ESCROW_DEBIT_SQL = `
UPDATE public.users
SET balance = balance - $2::numeric, updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
  AND status = 'active'
  AND balance - frozen_balance >= $2::numeric
RETURNING balance::text AS balance, frozen_balance::text AS frozen
`;

export const ESCROW_CREDIT_SQL = `
UPDATE public.users
SET balance = balance + $2::numeric, updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
RETURNING balance::text AS balance, frozen_balance::text AS frozen
`;

export const MEMBER_KEY_SQL = `
SELECT k.id::text AS id,
       k.quota::text AS quota,
       k.quota_used::text AS quota_used,
       k.rate_limit_5h::text AS rate_limit_5h,
       k.rate_limit_1d::text AS rate_limit_1d,
       k.rate_limit_7d::text AS rate_limit_7d,
       k.usage_5h::text AS usage_5h,
       k.usage_1d::text AS usage_1d,
       k.usage_7d::text AS usage_7d,
       k.window_5h_start AS window_5h_start,
       k.window_1d_start AS window_1d_start,
       k.window_7d_start AS window_7d_start
FROM public.api_keys AS k
JOIN public.groups AS g ON g.id = k.group_id
WHERE k.user_id = $1
  AND k.deleted_at IS NULL
  AND k.status = 'active'
  AND (k.expires_at IS NULL OR k.expires_at > NOW())
  AND g.id = 11
  AND g.deleted_at IS NULL
  AND g.status = 'active'
  AND g.name = '媒体台'
ORDER BY k.id
LIMIT 1
FOR UPDATE OF k
`;

const HOUR = 60 * 60 * 1000;
export const RATE_WINDOWS = [
  { usage: "usage_5h", start: "window_5h_start", limit: "rate_limit_5h", ms: 5 * HOUR },
  { usage: "usage_1d", start: "window_1d_start", limit: "rate_limit_1d", ms: 24 * HOUR },
  { usage: "usage_7d", start: "window_7d_start", limit: "rate_limit_7d", ms: 7 * 24 * HOUR },
] as const;

type QueryResult<T> = { rows: T[]; rowCount: number | null };
export type DbClient = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release?: () => void;
};
export type DbPool = { connect(): Promise<DbClient> };

type EscrowRow = {
  state: string;
  user_id: string;
  amount: string;
  api_key_id: string | null;
  balance_after: string | null;
  frozen_after: string | null;
};

type KeyRow = {
  id: string;
  quota: string;
  quota_used: string;
  rate_limit_5h: string;
  rate_limit_1d: string;
  rate_limit_7d: string;
  usage_5h: string;
  usage_1d: string;
  usage_7d: string;
  window_5h_start: Date | string | null;
  window_1d_start: Date | string | null;
  window_7d_start: Date | string | null;
};

export function quotaAllows(quota: Money, used: Money, amount: Money): boolean {
  if (compareMoney(quota, "0") <= 0) return true;
  return compareMoney(addMoney(used, amount), quota) <= 0;
}

export function nextRateUsage(input: {
  usage: Money;
  windowStart: Date | null;
  now: Date;
  windowMs: number;
  amount: Money;
  limit: Money;
}): { usage: Money; windowStart: Date; blocked: boolean } {
  const expired = !input.windowStart || input.now.getTime() - input.windowStart.getTime() >= input.windowMs;
  const base = expired ? "0" : input.usage;
  const usage = addMoney(base, input.amount);
  const blocked = compareMoney(input.limit, "0") > 0 && compareMoney(usage, input.limit) > 0;
  return { usage, windowStart: expired ? input.now : input.windowStart!, blocked };
}

export class PostgresBilling implements BillingPort {
  private readonly pool: DbPool;

  constructor(pool: DbPool) {
    this.pool = pool;
  }

  async hold(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<HoldResult> {
    const amount = moneyFromNumber(input.amountUsd);
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO media_video.escrow (idempotency_key, user_id, amount, state)
         VALUES ($1, $2, $3::numeric, 'pending')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [input.idempotencyKey, input.userId, amount],
      );
      const existing = await lockEscrow(client, input.idempotencyKey);
      assertSame(existing, input.userId, amount);
      if (existing.state === "held" || existing.state === "settled" || existing.state === "released") {
        return { ok: true, ...numbers(existing), alreadyApplied: true };
      }
      if (existing.state === "rejected") return { ok: false, code: "insufficient", ...numbers(existing) };

      const key = await lockKey(client, input.userId);
      if (!key) {
        const wallet = await readWallet(client, input.userId);
        await mark(client, input.idempotencyKey, "rejected", null, wallet.balance, wallet.frozen);
        return { ok: false, code: "revoked", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
      }
      const now = new Date();
      const rated = rateKey(key, amount, now);
      if (!rated.ok) {
        const wallet = await readWallet(client, input.userId);
        await mark(client, input.idempotencyKey, "rejected", key.id, wallet.balance, wallet.frozen);
        return { ok: false, code: "revoked", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
      }
      const debited = await client.query<{ balance: string; frozen: string }>(ESCROW_DEBIT_SQL, [input.userId, amount]);
      if ((debited.rowCount ?? debited.rows.length) === 0) {
        const wallet = await readWallet(client, input.userId);
        await mark(client, input.idempotencyKey, "rejected", key.id, wallet.balance, wallet.frozen);
        return { ok: false, code: "insufficient", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
      }
      await client.query(
        `UPDATE public.api_keys
         SET quota_used = $2::numeric,
             usage_5h = $3::numeric, window_5h_start = $4,
             usage_1d = $5::numeric, window_1d_start = $6,
             usage_7d = $7::numeric, window_7d_start = $8
         WHERE id = $1`,
        [key.id, rated.quotaUsed, rated.usage5h, rated.start5h, rated.usage1d, rated.start1d, rated.usage7d, rated.start7d],
      );
      const row = debited.rows[0];
      await mark(client, input.idempotencyKey, "held", key.id, row.balance, row.frozen);
      return { ok: true, balance: moneyToNumber(moneyFromDecimal(row.balance)), frozen: moneyToNumber(moneyFromDecimal(row.frozen)), alreadyApplied: false };
    });
  }

  async settle(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<SettleResult> {
    const amount = moneyFromNumber(input.amountUsd);
    return this.transaction(async (client) => {
      const existing = await lockEscrow(client, input.idempotencyKey);
      assertSame(existing, input.userId, amount);
      if (existing.state === "settled") return { ok: true, ...numbers(existing), alreadyApplied: true };
      if (existing.state !== "held") return { ok: false, code: "not_held", ...numbers(existing) };
      await client.query(`UPDATE media_video.escrow SET state = 'settled', updated_at = NOW() WHERE idempotency_key = $1 AND state = 'held'`, [
        input.idempotencyKey,
      ]);
      return { ok: true, ...numbers(existing), alreadyApplied: false };
    });
  }

  async release(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<ReleaseResult> {
    const amount = moneyFromNumber(input.amountUsd);
    return this.transaction(async (client) => {
      const existing = await lockEscrow(client, input.idempotencyKey);
      assertSame(existing, input.userId, amount);
      if (existing.state === "released") return { ok: true, ...numbers(existing), alreadyReleased: true };
      if (existing.state !== "held") return { ok: false, code: "not_held", ...numbers(existing) };
      const credited = await client.query<{ balance: string; frozen: string }>(ESCROW_CREDIT_SQL, [input.userId, existing.amount]);
      if ((credited.rowCount ?? credited.rows.length) === 0) {
        throw new ReleaseAmbiguous("用户已不存在，这一笔没有退回，也没有标记成已退。");
      }
      if (existing.api_key_id) {
        await client.query(
          `UPDATE public.api_keys
           SET quota_used = GREATEST(quota_used - $2::numeric, 0),
               usage_5h = GREATEST(usage_5h - $2::numeric, 0),
               usage_1d = GREATEST(usage_1d - $2::numeric, 0),
               usage_7d = GREATEST(usage_7d - $2::numeric, 0)
           WHERE id = $1`,
          [existing.api_key_id, existing.amount],
        );
      }
      const row = credited.rows[0];
      await mark(client, input.idempotencyKey, "released", existing.api_key_id, row.balance, row.frozen);
      return { ok: true, balance: moneyToNumber(moneyFromDecimal(row.balance)), frozen: moneyToNumber(moneyFromDecimal(row.frozen)), alreadyReleased: false };
    });
  }

  private async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('search_path', 'pg_catalog, media_video, public', true)`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof BillingAmbiguous || error instanceof ReleaseAmbiguous) throw error;
      throw new BillingAmbiguous("账户账本没有完成这次操作。没有自动再试，也没有退款。");
    } finally {
      client.release?.();
    }
  }
}

function rateKey(key: KeyRow, amount: Money, now: Date): { ok: true; quotaUsed: Money; usage5h: Money; start5h: Date; usage1d: Money; start1d: Date; usage7d: Money; start7d: Date } | { ok: false } {
  if (!quotaAllows(moneyFromDecimal(key.quota), moneyFromDecimal(key.quota_used), amount)) return { ok: false };
  const windows = [
    nextRateUsage({ usage: moneyFromDecimal(key.usage_5h), windowStart: asDate(key.window_5h_start), now, windowMs: RATE_WINDOWS[0].ms, amount, limit: moneyFromDecimal(key.rate_limit_5h) }),
    nextRateUsage({ usage: moneyFromDecimal(key.usage_1d), windowStart: asDate(key.window_1d_start), now, windowMs: RATE_WINDOWS[1].ms, amount, limit: moneyFromDecimal(key.rate_limit_1d) }),
    nextRateUsage({ usage: moneyFromDecimal(key.usage_7d), windowStart: asDate(key.window_7d_start), now, windowMs: RATE_WINDOWS[2].ms, amount, limit: moneyFromDecimal(key.rate_limit_7d) }),
  ];
  if (windows.some((item) => item.blocked)) return { ok: false };
  return {
    ok: true,
    quotaUsed: addMoney(moneyFromDecimal(key.quota_used), amount),
    usage5h: windows[0].usage,
    start5h: windows[0].windowStart,
    usage1d: windows[1].usage,
    start1d: windows[1].windowStart,
    usage7d: windows[2].usage,
    start7d: windows[2].windowStart,
  };
}

function asDate(value: Date | string | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

async function lockKey(client: DbClient, userId: number): Promise<KeyRow | null> {
  const found = await client.query<KeyRow>(MEMBER_KEY_SQL, [userId]);
  return found.rows[0] ?? null;
}

async function lockEscrow(client: DbClient, key: string): Promise<EscrowRow> {
  const found = await client.query<EscrowRow>(
    `SELECT state, user_id::text AS user_id, amount::text AS amount, api_key_id::text AS api_key_id,
            balance_after::text AS balance_after, frozen_after::text AS frozen_after
     FROM media_video.escrow WHERE idempotency_key = $1 FOR UPDATE`,
    [key],
  );
  const row = found.rows[0];
  if (!row) throw new BillingAmbiguous("视频账本没有锁住这一笔。");
  return row;
}

function assertSame(row: EscrowRow, userId: number, amount: string): void {
  if (row.user_id !== String(userId) || moneyFromDecimal(row.amount) !== amount) {
    throw new BillingAmbiguous("幂等键已被另一笔金额占用。");
  }
}

async function mark(client: DbClient, key: string, state: string, apiKeyId: string | null, balanceAfter: string | null, frozenAfter: string | null): Promise<void> {
  await client.query(
    `UPDATE media_video.escrow
     SET state = $2, api_key_id = COALESCE($3::bigint, api_key_id),
         balance_after = $4::numeric, frozen_after = $5::numeric, updated_at = NOW()
     WHERE idempotency_key = $1`,
    [key, state, apiKeyId, balanceAfter, frozenAfter],
  );
}

async function readWallet(client: DbClient, userId: number): Promise<{ balance: Money; frozen: Money }> {
  const found = await client.query<{ balance: string; frozen: string }>(
    `SELECT balance::text AS balance, frozen_balance::text AS frozen FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const row = found.rows[0];
  if (!row) return { balance: "0", frozen: "0" };
  return { balance: moneyFromDecimal(row.balance), frozen: moneyFromDecimal(row.frozen) };
}

function numbers(row: EscrowRow): { balance: number; frozen: number } {
  return {
    balance: moneyToNumber(moneyFromDecimal(row.balance_after || "0")),
    frozen: moneyToNumber(moneyFromDecimal(row.frozen_after || "0")),
  };
}
