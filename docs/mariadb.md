# MariaDB database design

MariaDB 11.8 with InnoDB replaces the original PostgreSQL choice. The Node.js connector is the official `mariadb` package; PostgreSQL and PGlite dependencies have been removed.

All policy mutations acquire the singleton `gateway_settings` row with `SELECT ... FOR UPDATE`. Reservations use READ COMMITTED transactions so reads after lock contention see the preceding commit. This intentionally serializes low-volume MVP submissions across clients, tenants and API instances. Quotas remain global where specified. Do not change tables through ad-hoc SQL while bypassing this lock.

Tables use explicit InnoDB foreign keys, UTC DATETIME(6), UUID strings and JSON scopes. Identifier and idempotency columns use binary collation, so case-sensitive keys stay distinct. Dates and interval arithmetic come from MariaDB, and parameters use connector placeholders. Content encryption is unchanged.

The adapter explicitly decodes DATE/DATETIME/TIMESTAMP as UTC and serializes JavaScript Date parameters in UTC. Setting the session timezone alone does not prevent this connector's date parser from applying the host timezone. Tests compare returned timestamps with database epoch time and round-trip dates on the Asia/Karachi Windows host.

MariaDB DDL commits implicitly. The migration runner therefore holds a session `GET_LOCK`, applies resumable DDL statements and records SHA-256 checksums. It does not promise transactional DDL rollback. Retry an interrupted migration with the same files; do not alter an applied migration. The SQL files remain required runtime assets for the migration command and are read from `server/src/db/migrations` in both source and compiled execution.

This change bootstraps a fresh MariaDB database. It does not copy an existing PostgreSQL deployment. Preserve any old database/volume and plan an explicit data conversion if one exists; never point this migration runner at it. The Compose volume is now `gateway_mariadb` and does not reuse the old volume.

Use a restricted DML account for the API. Migration operators need DDL privileges; tests need CREATE/DROP DATABASE on a disposable server. Set `?ssl=true` for verified remote TLS; the connector otherwise defaults to the local development connection.

References: [MariaDB connector Promise API](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/connector-nodejs-promise-api), [connection options](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options), [implicit DDL commits](https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit), [MariaDB 11.8 release series](https://mariadb.org/11-8-is-lts/).
