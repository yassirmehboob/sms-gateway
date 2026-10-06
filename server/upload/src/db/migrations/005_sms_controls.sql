ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS control_command VARCHAR(5) NULL CHECK (control_command IS NULL OR control_command IN ('STOP','START'));
CREATE TABLE IF NOT EXISTS sms_preferences (
 normalized_e164 VARCHAR(16) PRIMARY KEY,
 opted_out BOOLEAN NOT NULL DEFAULT false,
 last_received_at BIGINT NOT NULL DEFAULT 0,
 last_confirmation_at DATETIME(6) NULL,
 FOREIGN KEY (normalized_e164) REFERENCES recipients(normalized_e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS sms_control_events (
 device_id CHAR(36) NOT NULL, event_id CHAR(36) NOT NULL, request_hash CHAR(64) NOT NULL,
 result_json JSON NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(device_id,event_id), FOREIGN KEY(device_id) REFERENCES devices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
