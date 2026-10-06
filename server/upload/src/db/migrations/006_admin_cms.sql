ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS recipient_quota INT NOT NULL DEFAULT 3;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS cooldown_seconds INT NOT NULL DEFAULT 300;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS client_quota INT NOT NULL DEFAULT 10;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS device_quota INT NOT NULL DEFAULT 30;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS message_ttl_seconds INT NOT NULL DEFAULT 600;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS replay_window_hours INT NOT NULL DEFAULT 24;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS confirmation_cooldown_seconds INT NOT NULL DEFAULT 300;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details_json JSON NULL;
ALTER TABLE sms_preferences ADD COLUMN IF NOT EXISTS last_stop_confirmation_at DATETIME(6) NULL;
ALTER TABLE sms_preferences ADD COLUMN IF NOT EXISTS last_start_confirmation_at DATETIME(6) NULL;
CREATE TABLE IF NOT EXISTS cms_users (
 id CHAR(36) PRIMARY KEY, username VARCHAR(80) NOT NULL UNIQUE, password_hash VARCHAR(256) NOT NULL,
 role VARCHAR(16) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','viewer')), enabled BOOLEAN NOT NULL DEFAULT true,
 encrypted_totp_secret TEXT NULL, totp_enabled BOOLEAN NOT NULL DEFAULT false, last_totp_step BIGINT NOT NULL DEFAULT -1,
 failed_logins INT NOT NULL DEFAULT 0, locked_until DATETIME(6) NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS cms_sessions (
 token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, mfa_verified BOOLEAN NOT NULL DEFAULT false,
 expires_at DATETIME(6) NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY(user_id) REFERENCES cms_users(id), INDEX cms_session_expiry(expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
