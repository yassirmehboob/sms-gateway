CREATE TABLE IF NOT EXISTS gateway_settings (
 id TINYINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), paused BOOLEAN NOT NULL DEFAULT true
) ENGINE=InnoDB;
INSERT INTO gateway_settings (id) VALUES (1) ON DUPLICATE KEY UPDATE id=id;
CREATE TABLE IF NOT EXISTS tenants (
 id CHAR(36) PRIMARY KEY, name VARCHAR(200) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS api_clients (
 id CHAR(36) PRIMARY KEY, tenant_id CHAR(36) NOT NULL, key_hash CHAR(64) NOT NULL UNIQUE,
 scopes JSON NOT NULL CHECK (JSON_TYPE(scopes) = 'ARRAY'), enabled BOOLEAN NOT NULL DEFAULT true,
 FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS devices (
 id CHAR(36) PRIMARY KEY, tenant_id CHAR(36) NOT NULL, paused BOOLEAN NOT NULL DEFAULT true,
 revoked_at DATETIME(6), allowed_sim_id INT NOT NULL CHECK (allowed_sim_id >= 0),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS recipients (
 normalized_e164 VARCHAR(16) PRIMARY KEY, next_allowed_at DATETIME(6) NOT NULL DEFAULT '1970-01-01 00:00:00',
 suppressed BOOLEAN NOT NULL DEFAULT false
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS recipient_tenant_consents (
 tenant_id CHAR(36) NOT NULL, normalized_e164 VARCHAR(16) NOT NULL, purpose VARCHAR(64) NOT NULL,
 evidence TEXT NOT NULL, revoked_at DATETIME(6), PRIMARY KEY (tenant_id, normalized_e164, purpose),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id), FOREIGN KEY (normalized_e164) REFERENCES recipients(normalized_e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS outbound_messages (
 id CHAR(36) PRIMARY KEY, tenant_id CHAR(36) NOT NULL, client_id CHAR(36) NOT NULL,
 device_id CHAR(36) NOT NULL, normalized_e164 VARCHAR(16) NOT NULL,
 encrypted_body TEXT NOT NULL, body_hash CHAR(64) NOT NULL, segments INT NOT NULL CHECK (segments = 1),
 status VARCHAR(32) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','CLAIMED','ATTEMPT_RECORDED','SENT_TO_CARRIER','DELIVERED','EXPIRED','CANCELLED','FAILED_DEFINITE','UNKNOWN')),
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), expires_at DATETIME(6) NOT NULL,
 lease_expires_at DATETIME(6), send_attempt_started_at DATETIME(6),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id), FOREIGN KEY (client_id) REFERENCES api_clients(id),
 FOREIGN KEY (device_id) REFERENCES devices(id), FOREIGN KEY (normalized_e164) REFERENCES recipients(normalized_e164),
 INDEX outbound_recipient_usage (normalized_e164, created_at), INDEX outbound_client_usage (client_id, created_at),
 INDEX outbound_device_usage (device_id, created_at), INDEX outbound_tenant_history (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS idempotency_keys (
 tenant_id CHAR(36) NOT NULL, idempotency_key VARCHAR(128) NOT NULL, request_hash CHAR(64) NOT NULL,
 job_id CHAR(36) NOT NULL, PRIMARY KEY (tenant_id, idempotency_key),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id), FOREIGN KEY (job_id) REFERENCES outbound_messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS outbox_events (
 id CHAR(36) PRIMARY KEY, job_id CHAR(36) NOT NULL UNIQUE,
 event_type VARCHAR(32) NOT NULL CHECK (event_type = 'JOB_AVAILABLE'), published_at DATETIME(6),
 retry_count INT NOT NULL DEFAULT 0, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY (job_id) REFERENCES outbound_messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS audit_logs (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id CHAR(36), actor_id CHAR(36) NOT NULL,
 action VARCHAR(64) NOT NULL, resource_id CHAR(36), recorded_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
