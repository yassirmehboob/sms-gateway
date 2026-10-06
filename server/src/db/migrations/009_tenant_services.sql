CREATE TABLE IF NOT EXISTS tenant_plans (
 tenant_id CHAR(36) PRIMARY KEY,
 expires_at DATETIME(6) NULL,
 settings_json JSON NOT NULL,
 CONSTRAINT tenant_plans_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
ALTER TABLE gateway_settings ADD COLUMN IF NOT EXISTS bulk_last_tenant_id CHAR(36) NULL;
