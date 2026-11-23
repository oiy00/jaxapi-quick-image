import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresBilling } from "../lib/postgres-billing.ts";
import { BillingAmbiguous } from "../lib/video-billing-port.ts";

const adminUrl = process.env.VIDEO_TEST_ADMIN_URL;

test("postgres escrow debit races an image-like debit and credits a confirmed failure once", { skip: adminUrl ? false : "set VIDEO_TEST_ADMIN_URL to run the ephemeral Postgres test" }, async () => {
  if (!adminUrl) return;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const dbName = `media_video_test_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = adminUrl.replace(/\/postgres(?=$|\?)/, `/${dbName}`);
  const pool = new pg.Pool({ connectionString: url });
  pool.on("error", () => undefined);
  try {
    await pool.query(schemaSql());
    await pool.query(`INSERT INTO groups (id, name) VALUES (11, '媒体台'), (7, 'ChatGPT 生图')`);
    await pool.query(`INSERT INTO users (id, balance, frozen_balance) VALUES (4, 3.60, 0), (8, 10, 0), (9, 5, 4.50), (3, 10, 0)`);
    await pool.query(
      `INSERT INTO api_keys (id, user_id, group_id, quota, quota_used, rate_limit_5h) VALUES
       (1, 4, 11, 0, 0, 0),
       (2, 9, 11, 0, 0, 0),
       (3, 8, 11, 0, 0, 0),
       (4, 3, 11, 1, 0, 1)`,
    );

    const billing = new PostgresBilling(pool);
    const results = await Promise.all(Array.from({ length: 8 }, (_item, index) => billing.hold({ userId: 4, amountUsd: 1.2, idempotencyKey: `hold-${index}` })));
    assert.equal(results.filter((item) => item.ok).length, 3);
    assert.equal(results.filter((item) => !item.ok).length, 5);
    let wallet = await walletOf(pool, 4);
    assert.equal(wallet.balance, 0);
    assert.equal(wallet.frozen, 0);
    const heldRows = await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM media_video.escrow WHERE user_id = 4 AND state = 'held' ORDER BY idempotency_key`,
    );
    assert.equal(heldRows.rows.length, 3);
    const replay = await billing.hold({ userId: 4, amountUsd: 1.2, idempotencyKey: heldRows.rows[0].idempotency_key });
    assert.equal(replay.ok && replay.alreadyApplied, true);
    assert.equal((await walletOf(pool, 4)).balance, 0);

    const blocked = await billing.hold({ userId: 9, amountUsd: 1.2, idempotencyKey: "respect-frozen" });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "insufficient");
    const user9 = await walletOf(pool, 9);
    assert.equal(user9.balance, 5);
    assert.equal(user9.frozen, 4.5);

    const image = pool.connect();
    const video = billing.hold({ userId: 8, amountUsd: 6, idempotencyKey: "video-race" });
    const client = await image;
    const imageResult = client.query(
      `UPDATE users SET balance = balance - 6, updated_at = NOW()
       WHERE id = 8 AND deleted_at IS NULL AND balance - frozen_balance >= 6`,
    );
    const [videoResult, imageWrite] = await Promise.all([video, imageResult]);
    client.release();
    const user8 = await walletOf(pool, 8);
    assert.equal(user8.balance, 4);
    assert.equal(user8.frozen, 0);
    assert.equal(Number(videoResult.ok) + (imageWrite.rowCount ?? 0), 1);

    const revoked = await billing.hold({ userId: 3, amountUsd: 0.4, idempotencyKey: "quota" });
    assert.equal(revoked.ok, true);
    const overQuota = await billing.hold({ userId: 3, amountUsd: 0.7, idempotencyKey: "quota-2" });
    assert.equal(overQuota.ok, false);
    if (!overQuota.ok) assert.equal(overQuota.code, "revoked");
    const quota = await pool.query<{ quota_used: string }>(`SELECT quota_used::text AS quota_used FROM api_keys WHERE id = 4`);
    assert.equal(Number(quota.rows[0].quota_used), 0.4);

    await pool.query(`UPDATE api_keys SET status = 'revoked' WHERE user_id = 8`);
    await pool.query(`UPDATE users SET balance = 10 WHERE id = 8`);
    const inactive = await billing.hold({ userId: 8, amountUsd: 1, idempotencyKey: "revoked-key" });
    assert.equal(inactive.ok, false);
    assert.equal((await walletOf(pool, 8)).balance, 10);

    const credited = await billing.release({ userId: 4, amountUsd: 1.2, idempotencyKey: heldRows.rows[0].idempotency_key });
    assert.equal(credited.ok, true);
    assert.equal((await walletOf(pool, 4)).balance, 1.2);
    const creditedAgain = await billing.release({ userId: 4, amountUsd: 1.2, idempotencyKey: heldRows.rows[0].idempotency_key });
    assert.equal(creditedAgain.ok && creditedAgain.alreadyReleased, true);
    assert.equal((await walletOf(pool, 4)).balance, 1.2);

    const still = await pool.query<{ idempotency_key: string }>(`SELECT idempotency_key FROM media_video.escrow WHERE user_id = 4 AND state = 'held' LIMIT 1`);
    const settled = await billing.settle({ userId: 4, amountUsd: 1.2, idempotencyKey: still.rows[0].idempotency_key });
    assert.equal(settled.ok, true);
    assert.equal((await walletOf(pool, 4)).balance, 1.2);
    const noCredit = await billing.release({ userId: 4, amountUsd: 1.2, idempotencyKey: still.rows[0].idempotency_key });
    assert.equal(noCredit.ok, false);
    assert.equal((await walletOf(pool, 4)).balance, 1.2);

    const boom = new PostgresBilling({
      async connect() {
        return {
          async query() {
            throw new Error("db down");
          },
          release() {
            return undefined;
          },
        };
      },
    });
    await assert.rejects(() => boom.hold({ userId: 4, amountUsd: 1.2, idempotencyKey: "db-down" }), BillingAmbiguous);
  } finally {
    await pool.end();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
});

function schemaSql(): string {
  return `
    CREATE TABLE users (
      id bigint PRIMARY KEY,
      balance numeric(20,8) NOT NULL DEFAULT 0,
      frozen_balance numeric(20,8) NOT NULL DEFAULT 0,
      status varchar(20) NOT NULL DEFAULT 'active',
      role varchar(20) NOT NULL DEFAULT 'user',
      deleted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE groups (
      id bigint PRIMARY KEY,
      name varchar(100) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'active',
      deleted_at timestamptz
    );
    CREATE TABLE api_keys (
      id bigint PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id),
      group_id bigint REFERENCES groups(id),
      status varchar(20) NOT NULL DEFAULT 'active',
      deleted_at timestamptz,
      expires_at timestamptz,
      quota numeric(20,8) NOT NULL DEFAULT 0,
      quota_used numeric(20,8) NOT NULL DEFAULT 0,
      rate_limit_5h numeric(20,8) NOT NULL DEFAULT 0,
      rate_limit_1d numeric(20,8) NOT NULL DEFAULT 0,
      rate_limit_7d numeric(20,8) NOT NULL DEFAULT 0,
      usage_5h numeric(20,8) NOT NULL DEFAULT 0,
      usage_1d numeric(20,8) NOT NULL DEFAULT 0,
      usage_7d numeric(20,8) NOT NULL DEFAULT 0,
      window_5h_start timestamptz,
      window_1d_start timestamptz,
      window_7d_start timestamptz
    );
    CREATE SCHEMA media_video;
    CREATE TABLE media_video.escrow (
      idempotency_key text PRIMARY KEY,
      user_id bigint NOT NULL,
      api_key_id bigint,
      amount numeric(20,8) NOT NULL CHECK (amount > 0),
      state text NOT NULL,
      balance_before numeric(20,8),
      frozen_before numeric(20,8),
      balance_after numeric(20,8),
      frozen_after numeric(20,8),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
  `;
}

async function walletOf(pool: pg.Pool, id: number): Promise<{ balance: number; frozen: number }> {
  const found = await pool.query<{ balance: string; frozen: string }>(
    `SELECT balance::text AS balance, frozen_balance::text AS frozen FROM users WHERE id = $1`,
    [id],
  );
  return { balance: Number(found.rows[0].balance), frozen: Number(found.rows[0].frozen) };
}
