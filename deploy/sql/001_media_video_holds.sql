-- Review-only migration for the media-station video ledger.
-- Do not run this against production from the application, and do not run it
-- with the Sub2API superuser as the runtime role.
-- It does not recreate Sub2API, does not change group prices, and does not
-- contain a statement that increases users.balance.

CREATE SCHEMA IF NOT EXISTS media_video;

CREATE TABLE IF NOT EXISTS media_video.holds (
  idempotency_key text PRIMARY KEY,
  user_id bigint NOT NULL,
  amount numeric(20,8) NOT NULL CHECK (amount > 0),
  state text NOT NULL CHECK (state IN ('pending', 'held', 'settled', 'released', 'rejected')),
  balance_before numeric(20,8),
  frozen_before numeric(20,8),
  balance_after numeric(20,8),
  frozen_after numeric(20,8),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE media_video.holds IS
  'Video holds owned by jaxapi-quick-image. Release lowers frozen_balance only. Settle lowers balance and frozen_balance together. No balance credit is stored here.';

-- Runtime role. Set the password out of band. Do not reuse the admin role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_video_billing') THEN
    CREATE ROLE media_video_billing LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA media_video TO media_video_billing;
GRANT SELECT, INSERT, UPDATE ON media_video.holds TO media_video_billing;

GRANT SELECT (id, balance, frozen_balance, status, deleted_at) ON public.users TO media_video_billing;
GRANT UPDATE (balance, frozen_balance, updated_at) ON public.users TO media_video_billing;
GRANT SELECT (id, user_id, group_id, status, deleted_at, expires_at) ON public.api_keys TO media_video_billing;
GRANT SELECT (id, name, status, deleted_at) ON public.groups TO media_video_billing;

-- Not granted: usage_logs, billing_usage_entries, idempotency_records,
-- INSERT/DELETE on users, or UPDATE of status, role, or deleted_at.
-- users UPDATE still fires enqueue_user_auth_cache_invalidation(). In 0.2.24
-- that function returns before writing the outbox when status, role, and
-- deleted_at are unchanged, so a balance/frozen update does not enqueue keys.
