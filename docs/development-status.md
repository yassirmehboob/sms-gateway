# Development status

STOP/START command processing and an Android foreground polling service are implemented. See [upgrade steps and device acceptance tests](stop-start-and-background.md). Migration 005 separates SMS opt-out from manual suppression; Room v2 preserves attempts and queues encrypted command metadata.

The local [management CMS](cms.md) is implemented with migration 006, authenticated administrator audit, editable limits, recipient controls and device enrollment.

Phase B is in progress. The requested database is now MariaDB 11.8 with InnoDB; source queries, migrations, connector, Compose, tests, CI and both plan copies have been updated.

Implemented: Express/TypeScript API; hashed, scoped client API keys and revocation; custom single-segment messages and an appointment-reminder template; PK mobile normalization; tenant consent; global suppression; AES-256-GCM body encryption; transactional idempotency, recipient cooldown, rolling quotas, jobs, audit and outbox; tenant-scoped status/list endpoints; request throttling; development seed.

The [local operator CLI](operator-runbook.md) supports device provisioning, enrollment challenges, global/device pause and resume, device/client revocation and consent changes. Audits commit with each mutation. Pause/revocation cancels unattempted pending work without refunding usage or reviving cancelled jobs.

The [device protocol](device-protocol.md) supports approved P-256 keys, one-time enrollment, signed requests with nonce replay protection, heartbeat and encrypted FCM token registration, leased claims, one-time pre-send authorization, idempotent delivery events and UNKNOWN reconciliation. Migration 003 extends existing MariaDB installations. Expiry/lease/nonce reconciliation runs every 30 seconds in the API process.

The first [Android app](android-gateway.md) implements Keystore identity, encrypted settings, enrollment/recovery, permission and SIM selection, FCM/manual/periodic WorkManager sync, a Room attempt journal, selected-SIM single-segment sending and durable callback uploads. It starts paused and does not store recipients or SMS bodies. Backend authorization now adds `validForMs` for monotonic deadline enforcement; deploy that server update with the app. Real-device validation is still required.

Default policy (editable in the CMS): one GSM-7 or Unicode segment, five-minute global destination cooldown, three reservations per recipient per rolling 24 hours, ten per client per hour, thirty per device per 24 hours, ten-minute validity, 24-hour content replay prevention. All job statuses consume reservations. Idempotency keys are retained indefinitely in this increment.

The [FCM outbox worker](fcm-worker.md) is implemented with MariaDB leases, fenced acknowledgments, durable backoff, token-rotation handling and expiry/policy checks. Migration 004 supports dispatch state. The worker runs separately and is disabled by default; no live Firebase delivery has been tested. Notification acceptance remains separate from SMS status.

MariaDB date decoding now explicitly interprets database timestamps as UTC, fixing returned dates/lease deadlines on non-UTC hosts. Database timestamps were already written using UTC session time; no data rewrite is required.

## Next increments

1. External identity-provider integration and CMS user-lifecycle management. The local CMS already supports password/TOTP MFA, admin/viewer roles, tenant/client provisioning and key rotation.
2. Real-device validation of Android enrollment, permissions, journal durability and at-most-one attempt behavior.
3. Configure Firebase and validate wake-up delivery with the Android app on the target phone.
4. Android instrumentation/crash/SIM testing and production signing; current local storage minimizes data and encrypts settings rather than retaining encrypted message content.
5. General inbound processing, retention cleanup, metrics and UI. STOP/START keyword handling is implemented.

Phase A still needs actual device/distribution, operator/SIM, consent/template and inbound-sender decisions plus permission feasibility testing. Android SMS transport is implemented but no cellular send or deployment has been performed.

## Operational limits

The API defaults to localhost and supports an explicit LAN HOST. The CMS listens separately on loopback port 3001. Configure TLS, proxy trust, shared ingress throttling, database/backup encryption, retention and key rotation before deployment. Numbers remain indexed identifiers. Standard errors omit content and credentials; rejected-request auditing and alerting remain pending.

Use the policy lock for every operational policy mutation. MariaDB migrations bootstrap a fresh database and do not import an existing PostgreSQL database. See [database notes](mariadb.md).

GET the status URL for current state; idempotent submission returns the original acceptance response. An outbox row does not prove transmission. Expiry is enforced by claims/authorization and the reconciler. Authorization cannot be recalled once issued; the device must enforce its local checks and returned deadline immediately before transmission.

Tests now use real MariaDB for API, policy, migration, operator and independent-pool concurrency checks; they explicitly skip without `TEST_DATABASE_URL`. See [verification](verification.md) for the actual execution results.
