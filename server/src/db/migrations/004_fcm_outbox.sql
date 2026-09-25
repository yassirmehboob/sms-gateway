ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_token CHAR(36) COLLATE utf8mb4_bin;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_until DATETIME(6);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS abandoned_at DATETIME(6);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error VARCHAR(64);
CREATE INDEX IF NOT EXISTS outbox_dispatch ON outbox_events (published_at,abandoned_at,available_at,lease_until);
