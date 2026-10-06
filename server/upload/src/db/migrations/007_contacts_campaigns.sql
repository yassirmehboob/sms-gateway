ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS bulk_delay_seconds INT NOT NULL DEFAULT 60;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS bulk_last_activity_at DATETIME(6) NULL;
CREATE TABLE IF NOT EXISTS contacts (
 id CHAR(36) PRIMARY KEY, tenant_id CHAR(36) NOT NULL, name VARCHAR(200) NOT NULL,
 normalized_e164 VARCHAR(16) NOT NULL, address VARCHAR(500) NULL, email VARCHAR(254) NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 UNIQUE KEY contact_number (tenant_id,normalized_e164), UNIQUE KEY contact_tenant (id,tenant_id),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id), FOREIGN KEY (normalized_e164) REFERENCES recipients(normalized_e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS contact_groups (
 id CHAR(36) PRIMARY KEY, tenant_id CHAR(36) NOT NULL, name VARCHAR(200) NOT NULL,
 UNIQUE KEY group_name (tenant_id,name), UNIQUE KEY group_tenant (id,tenant_id),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS contact_group_members (
 group_id CHAR(36) NOT NULL, contact_id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
 PRIMARY KEY (group_id,contact_id),
 FOREIGN KEY (group_id,tenant_id) REFERENCES contact_groups(id,tenant_id) ON DELETE CASCADE,
 FOREIGN KEY (contact_id,tenant_id) REFERENCES contacts(id,tenant_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS campaigns (
 id CHAR(36) PRIMARY KEY, tenant_id CHAR(36) NOT NULL, client_id CHAR(36) NOT NULL,
 name VARCHAR(200) NOT NULL, encrypted_body TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','CANCELLED','COMPLETED')),
 scheduled_at DATETIME(6) NOT NULL, expires_at DATETIME(6) NOT NULL,
 created_by CHAR(36) NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id), FOREIGN KEY (client_id) REFERENCES api_clients(id),
 INDEX campaign_schedule (status,scheduled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS campaign_recipients (
 id CHAR(36) PRIMARY KEY, campaign_id CHAR(36) NOT NULL, name VARCHAR(200) NOT NULL,
 normalized_e164 VARCHAR(16) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','QUEUED','SKIPPED','CANCELLED')),
 job_id CHAR(36) NULL UNIQUE, last_error VARCHAR(64) NULL,
 next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 UNIQUE KEY campaign_number (campaign_id,normalized_e164),
 FOREIGN KEY (campaign_id) REFERENCES campaigns(id), FOREIGN KEY (job_id) REFERENCES outbound_messages(id),
 INDEX campaign_pending (status,next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
