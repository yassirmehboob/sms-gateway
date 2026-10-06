ALTER TABLE cms_users ADD COLUMN IF NOT EXISTS super_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cms_users ADD COLUMN IF NOT EXISTS all_tenants BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cms_users ADD COLUMN IF NOT EXISTS permissions_json JSON NULL;
UPDATE cms_users SET super_admin=(role='admin'),all_tenants=true,permissions_json='{"dashboard":"view","settings":"view","recipients":"view","contacts":"view","bulk":"view","devices":"view","clients":"view","messages":"view","audit":"view"}' WHERE permissions_json IS NULL;
ALTER TABLE cms_users MODIFY COLUMN permissions_json JSON NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS cms_user_tenants (
 user_id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, PRIMARY KEY (user_id,tenant_id),
 FOREIGN KEY (user_id) REFERENCES cms_users(id) ON DELETE CASCADE,
 FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
