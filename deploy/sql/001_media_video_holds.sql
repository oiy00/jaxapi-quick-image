-- Review-only migration. Do not run this from the app and do not run it
-- with the Sub2API superuser as the runtime role.
-- No SECURITY DEFINER functions. Statements are schema-qualified.
-- Video escrow debits public.users.balance. It does not write frozen_balance.
-- Confirmed-failure credit adds the escrow row's own amount once.
-- usage_logs and billing_usage_entries are not granted.

CREATE SCHEMA IF NOT EXISTS media_video;

CREATE TABLE IF NOT EXISTS media_video.escrow (
  idempotency_key text PRIMARY KEY,
  user_id bigint NOT NULL,
  api_key_id bigint,
  amount numeric(20,8) NOT NULL CHECK (amount > 0),
  state text NOT NULL CHECK (state IN ('pending', 'held', 'settled', 'released', 'rejected')),
  balance_before numeric(20,8),
  frozen_before numeric(20,8),
  balance_after numeric(20,8),
  frozen_after numeric(20,8),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE media_video.escrow IS
  'Video escrow. held means users.balance was decreased once. settled does not debit again. released means that same amount was credited once after a confirmed upstream failure. Ambiguous rows stay held.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_video_billing') THEN
    CREATE ROLE media_video_billing LOGIN;
  END IF;
END $$;

ALTER ROLE media_video_billing SET search_path = pg_catalog, media_video, public;

GRANT USAGE ON SCHEMA media_video TO media_video_billing;
GRANT SELECT, INSERT, UPDATE ON media_video.escrow TO media_video_billing;

GRANT SELECT (id, balance, frozen_balance, status, deleted_at) ON public.users TO media_video_billing;
GRANT UPDATE (balance, updated_at) ON public.users TO media_video_billing;

GRANT SELECT (
  id, user_id, group_id, status, deleted_at, expires_at,
  quota, quota_used, rate_limit_5h, rate_limit_1d, rate_limit_7d,
  usage_5h, usage_1d, usage_7d, window_5h_start, window_1d_start, window_7d_start
) ON public.api_keys TO media_video_billing;
GRANT UPDATE (
  quota_used, usage_5h, usage_1d, usage_7d, window_5h_start, window_1d_start, window_7d_start
) ON public.api_keys TO media_video_billing;

GRANT SELECT (id, name, status, deleted_at) ON public.groups TO media_video_billing;

-- Not granted: frozen_balance updates, users.status/role/deleted_at,
-- api_keys.status or key material, usage_logs, billing_usage_entries,
-- idempotency_records, or any security-definer function.
