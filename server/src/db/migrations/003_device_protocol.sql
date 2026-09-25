ALTER TABLE devices ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at DATETIME(6);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS encrypted_fcm_token TEXT;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS lease_id CHAR(36) COLLATE utf8mb4_bin;
CREATE TABLE IF NOT EXISTS enrollment_challenges (
 device_id CHAR(36) PRIMARY KEY, token_hash CHAR(64) NOT NULL, public_key TEXT NOT NULL,
 expires_at DATETIME(6) NOT NULL, consumed_at DATETIME(6),
 FOREIGN KEY (device_id) REFERENCES devices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS device_nonces (
 device_id CHAR(36) NOT NULL, nonce CHAR(36) NOT NULL, expires_at DATETIME(6) NOT NULL,
 PRIMARY KEY (device_id,nonce), FOREIGN KEY (device_id) REFERENCES devices(id), INDEX nonce_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS device_events (
 device_id CHAR(36) NOT NULL, event_id CHAR(36) NOT NULL, job_id CHAR(36) NOT NULL,
 request_hash CHAR(64) NOT NULL, event_type VARCHAR(32) NOT NULL, resulting_status VARCHAR(32) NOT NULL,
 recorded_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY (device_id,event_id), FOREIGN KEY (device_id) REFERENCES devices(id), FOREIGN KEY (job_id) REFERENCES outbound_messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
