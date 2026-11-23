import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresBilling } from "../lib/postgres-billing.ts";

const adminUrl = process.env.VIDEO_TEST_ADMIN_URL;

test("postgres holds serialize on available balance and release does not credit", { skip: adminUrl ? false : "set VIDEO_TEST_ADMIN_URL to run the ephemeral Postgres test" }, async () => {
  if (!adminUrl) return;
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`ephemeral Postgres is required for the billing test: ${message}`);
  }
  const dbName = `media_video_test_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = adminUrl.replace(/\/postgres(?=$|\?)/, `/${dbName}`);
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query(`
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
        expires_at timestamptz
      );
      CREATE SCHEMA media_video;
      CREATE TABLE media_video.holds (
        idempotency_key text PRIMARY KEY,
        user_id bigint NOT NULL,
        amount numeric(20,8) NOT NULL CHECK (amount > 0),
        state text NOT NULL,
        balance_before numeric(20,8),
        frozen_before numeric(20,8),
        balance_after numeric(20,8),
        frozen_after numeric(20,8),
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE auth_cache_invalidation_outbox (id bigserial PRIMARY KEY, cache_key text);
      CREATE OR REPLACE FUNCTION enqueue_user_auth_cache_invalidation()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE'
           AND OLD.status IS NOT DISTINCT FROM NEW.status
           AND OLD.role IS NOT DISTINCT FROM NEW.role
           AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
          RETURN NEW;
        END IF;
        INSERT INTO auth_cache_invalidation_outbox (cache_key) VALUES ('fired');
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_users_auth_cache_invalidation
      AFTER UPDATE OR DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION enqueue_user_auth_cache_invalidation();
    `);
    await pool.query(`INSERT INTO users (id, balance) VALUES (4, 3.60)`);
    await pool.query(`INSERT INTO users (id, balance, frozen_balance) VALUES (9, 5, 4.50)`);
    await pool.query(`INSERT INTO groups (id, name) VALUES (11, '媒体台')`);
    await pool.query(`INSERT INTO api_keys (id, user_id, group_id) VALUES (1, 4, 11), (2, 9, 11)`);

    const billing = new PostgresBilling(pool);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_item, index) => billing.hold({ userId: 4, amountUsd: 1.2, idempotencyKey: `hold-${index}` })),
    );
    const held = results.filter((item) => item.ok);
    const denied = results.filter((item) => !item.ok);
    assert.equal(held.length, 3);
    assert.equal(denied.length, 5);
    const wallet = await pool.query<{ balance: string; frozen: string }>(
      `SELECT balance::text AS balance, frozen_balance::text AS frozen FROM users WHERE id = 4`,
    );
    assert.equal(Number(wallet.rows[0].balance), 3.6);
    assert.equal(Number(wallet.rows[0].frozen), 3.6);
    const again = await billing.hold({ userId: 4, amountUsd: 1.2, idempotencyKey: "hold-0" });
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.alreadyApplied, true);
    const afterReplay = await pool.query<{ frozen: string }>(`SELECT frozen_balance::text AS frozen FROM users WHERE id = 4`);
    assert.equal(Number(afterReplay.rows[0].frozen), 3.6);

    const blocked = await billing.hold({ userId: 9, amountUsd: 1.2, idempotencyKey: "frozen-user" });
    assert.equal(blocked.ok, false);
    const user9 = await pool.query<{ balance: string; frozen: string }>(
      `SELECT balance::text AS balance, frozen_balance::text AS frozen FROM users WHERE id = 9`,
    );
    assert.equal(Number(user9.rows[0].balance), 5);
    assert.equal(Number(user9.rows[0].frozen), 4.5);

    const released = await billing.release({ userId: 4, amountUsd: 1.2, idempotencyKey: "hold-0" });
    assert.equal(released.ok, true);
    const afterRelease = await pool.query<{ balance: string; frozen: string }>(
      `SELECT balance::text AS balance, frozen_balance::text AS frozen FROM users WHERE id = 4`,
    );
    assert.equal(Number(afterRelease.rows[0].balance), 3.6);
    assert.equal(Number(afterRelease.rows[0].frozen), 2.4);
    const releasedAgain = await billing.release({ userId: 4, amountUsd: 1.2, idempotencyKey: "hold-0" });
    assert.equal(releasedAgain.ok, true);
    if (releasedAgain.ok) assert.equal(releasedAgain.alreadyReleased, true);

    const stillHeld = await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM media_video.holds WHERE state = 'held' LIMIT 1`,
    );
    const settled = await billing.settle({ userId: 4, amountUsd: 1.2, idempotencyKey: stillHeld.rows[0].idempotency_key });
    assert.equal(settled.ok, true);
    const afterSettle = await pool.query<{ balance: string; frozen: string }>(
      `SELECT balance::text AS balance, frozen_balance::text AS frozen FROM users WHERE id = 4`,
    );
    assert.equal(Number(afterSettle.rows[0].balance), 2.4);
    assert.equal(Number(afterSettle.rows[0].frozen), 1.2);
    const cacheRows = await pool.query(`SELECT count(*)::int AS n FROM auth_cache_invalidation_outbox`);
    assert.equal(cacheRows.rows[0].n, 0);
  } finally {
    pool.on("error", () => undefined);
    await pool.end();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
});
