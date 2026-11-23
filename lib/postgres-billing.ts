import { BillingAmbiguous, ReleaseAmbiguous, type BillingPort, type HoldResult, type ReleaseResult, type SettleResult } from "./video-billing-port.ts";
import { moneyFromDecimal, moneyFromNumber, moneyToNumber } from "./money.ts";

/**
 * Sub2API 0.2.24 users.balance is numeric(20,8). Available funds are
 * balance - frozen_balance. Stock DeductBalance ignores frozen_balance and
 * can still overdraft; these statements lock the user row and never do that.
 * None of them increases users.balance. Release only reduces frozen_balance.
 */
export const HOLD_MEMBER_SQL = `
SELECT 1
FROM api_keys AS k
JOIN groups AS g ON g.id = k.group_id
WHERE k.user_id = $1
  AND k.deleted_at IS NULL
  AND k.status = 'active'
  AND (k.expires_at IS NULL OR k.expires_at > NOW())
  AND g.id = 11
  AND g.deleted_at IS NULL
  AND g.status = 'active'
  AND g.name = '媒体台'
LIMIT 1
`;

export const HOLD_FREEZE_SQL = `
UPDATE users
SET frozen_balance = frozen_balance + $2::numeric, updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
  AND status = 'active'
  AND balance - frozen_balance >= $2::numeric
RETURNING balance::text AS balance, frozen_balance::text AS frozen
`;

export const SETTLE_SQL = `
UPDATE users
SET balance = balance - $2::numeric,
    frozen_balance = frozen_balance - $2::numeric,
    updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
  AND frozen_balance >= $2::numeric
  AND balance >= $2::numeric
RETURNING balance::text AS balance, frozen_balance::text AS frozen
`;

export const RELEASE_SQL = `
UPDATE users
SET frozen_balance = frozen_balance - $2::numeric, updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
  AND frozen_balance >= $2::numeric
RETURNING balance::text AS balance, frozen_balance::text AS frozen
`;

type QueryResult<T> = { rows: T[]; rowCount: number | null };
export type DbClient = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release?: () => void;
};
export type DbPool = { connect(): Promise<DbClient> };

type HoldRow = {
  state: string;
  user_id: string;
  amount: string;
  balance_after: string | null;
  frozen_after: string | null;
};

export class PostgresBilling implements BillingPort {
  private readonly pool: DbPool;

  constructor(pool: DbPool) {
    this.pool = pool;
  }

  async hold(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<HoldResult> {
    const amount = moneyFromNumber(input.amountUsd);
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO media_video.holds (idempotency_key, user_id, amount, state)
         VALUES ($1, $2, $3::numeric, 'pending')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [input.idempotencyKey, input.userId, amount],
      );
      const existing = await lockHold(client, input.idempotencyKey);
      assertSameHold(existing, input.userId, amount);
      if (existing.state === "held" || existing.state === "settled" || existing.state === "released") {
        return heldResult(existing, true);
      }
      if (existing.state === "rejected") return rejected(existing);
      const member = await client.query(HOLD_MEMBER_SQL, [input.userId]);
      if ((member.rowCount ?? member.rows.length) === 0) {
        await mark(client, input.idempotencyKey, "rejected", null, null, null, null);
        const wallet = await readWallet(client, input.userId);
        return { ok: false, code: "insufficient", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
      }
      const frozen = await client.query<{ balance: string; frozen: string }>(HOLD_FREEZE_SQL, [input.userId, amount]);
      if ((frozen.rowCount ?? frozen.rows.length) === 0) {
        const wallet = await readWallet(client, input.userId);
        await mark(client, input.idempotencyKey, "rejected", wallet.balance, wallet.frozen, wallet.balance, wallet.frozen);
        return { ok: false, code: "insufficient", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
      }
      const row = frozen.rows[0];
      await mark(client, input.idempotencyKey, "held", null, null, row.balance, row.frozen);
      return { ok: true, balance: moneyToNumber(moneyFromDecimal(row.balance)), frozen: moneyToNumber(moneyFromDecimal(row.frozen)), alreadyApplied: false };
    });
  }

  async settle(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<SettleResult> {
    const amount = moneyFromNumber(input.amountUsd);
    return this.transaction(async (client) => {
      const existing = await lockHold(client, input.idempotencyKey);
      assertSameHold(existing, input.userId, amount);
      if (existing.state === "settled") return { ok: true, ...numbers(existing), alreadyApplied: true };
      if (existing.state !== "held") return { ok: false, code: "not_held", ...numbers(existing) };
      const updated = await client.query<{ balance: string; frozen: string }>(SETTLE_SQL, [input.userId, amount]);
      if ((updated.rowCount ?? updated.rows.length) === 0) {
        const wallet = await readWallet(client, input.userId);
        return { ok: false, code: "settle_blocked", balance: moneyToNumber(wallet.balance), frozen: moneyToNumber(wallet.frozen) };
      }
      const row = updated.rows[0];
      await mark(client, input.idempotencyKey, "settled", null, null, row.balance, row.frozen);
      return { ok: true, balance: moneyToNumber(moneyFromDecimal(row.balance)), frozen: moneyToNumber(moneyFromDecimal(row.frozen)), alreadyApplied: false };
    });
  }

  async release(input: { userId: number; amountUsd: number; idempotencyKey: string }): Promise<ReleaseResult> {
    const amount = moneyFromNumber(input.amountUsd);
    return this.transaction(async (client) => {
      const existing = await lockHold(client, input.idempotencyKey);
      assertSameHold(existing, input.userId, amount);
      if (existing.state === "released") return { ok: true, ...numbers(existing), alreadyReleased: true };
      if (existing.state !== "held") return { ok: false, code: "not_held", ...numbers(existing) };
      const updated = await client.query<{ balance: string; frozen: string }>(RELEASE_SQL, [input.userId, amount]);
      if ((updated.rowCount ?? updated.rows.length) === 0) throw new ReleaseAmbiguous("冻结对不上，没有改动余额。");
      const row = updated.rows[0];
      await mark(client, input.idempotencyKey, "released", null, null, row.balance, row.frozen);
      return { ok: true, balance: moneyToNumber(moneyFromDecimal(row.balance)), frozen: moneyToNumber(moneyFromDecimal(row.frozen)), alreadyReleased: false };
    });
  }

  private async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof BillingAmbiguous || error instanceof ReleaseAmbiguous) throw error;
      throw new BillingAmbiguous("账户账本没有完成这次操作。没有自动再试。");
    } finally {
      client.release?.();
    }
  }
}

async function lockHold(client: DbClient, key: string): Promise<HoldRow> {
  const found = await client.query<HoldRow>(
    `SELECT state, user_id::text AS user_id, amount::text AS amount, balance_after::text AS balance_after, frozen_after::text AS frozen_after
     FROM media_video.holds WHERE idempotency_key = $1 FOR UPDATE`,
    [key],
  );
  const row = found.rows[0];
  if (!row) throw new BillingAmbiguous("冻结记录没有锁定。");
  return row;
}

function assertSameHold(row: HoldRow, userId: number, amount: string): void {
  if (row.user_id !== String(userId) || moneyFromDecimal(row.amount) !== amount) {
    throw new BillingAmbiguous("幂等键已被另一笔金额占用。");
  }
}

async function mark(client: DbClient, key: string, state: string, balanceBefore: string | null, frozenBefore: string | null, balanceAfter: string | null, frozenAfter: string | null): Promise<void> {
  await client.query(
    `UPDATE media_video.holds
     SET state = $2, balance_before = COALESCE($3::numeric, balance_before), frozen_before = COALESCE($4::numeric, frozen_before),
         balance_after = $5::numeric, frozen_after = $6::numeric, updated_at = NOW()
     WHERE idempotency_key = $1`,
    [key, state, balanceBefore, frozenBefore, balanceAfter, frozenAfter],
  );
}

async function readWallet(client: DbClient, userId: number): Promise<{ balance: string; frozen: string }> {
  const found = await client.query<{ balance: string; frozen: string }>(
    `SELECT balance::text AS balance, frozen_balance::text AS frozen FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return found.rows[0] ?? { balance: "0", frozen: "0" };
}

function heldResult(row: HoldRow, alreadyApplied: boolean): HoldResult {
  return { ok: true, balance: moneyToNumber(moneyFromDecimal(row.balance_after || "0")), frozen: moneyToNumber(moneyFromDecimal(row.frozen_after || "0")), alreadyApplied };
}

function rejected(row: HoldRow): HoldResult {
  return { ok: false, code: "insufficient", balance: moneyToNumber(moneyFromDecimal(row.balance_after || "0")), frozen: moneyToNumber(moneyFromDecimal(row.frozen_after || "0")) };
}

function numbers(row: HoldRow): { balance: number; frozen: number } {
  return { balance: moneyToNumber(moneyFromDecimal(row.balance_after || "0")), frozen: moneyToNumber(moneyFromDecimal(row.frozen_after || "0")) };
}
