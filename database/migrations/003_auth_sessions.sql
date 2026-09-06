CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT auth_sessions_refresh_hash_format
    CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_active_user_idx
  ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

-- Legacy refresh tokens cannot be migrated safely: invalidate them and require
-- clients to authenticate again. The compatibility column is intentionally kept
-- for now, but application code no longer reads or writes it.
UPDATE users
SET refresh_token = NULL,
    updated_at = NOW()
WHERE refresh_token IS NOT NULL;
