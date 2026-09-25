# Verification: Android gateway increment

CMS increment (2026-09-25): backend build and **52 tests passed, none skipped**, including password hashing, RFC TOTP vectors, login/MFA/CSRF/session and role checks, live quota updates, recipient restore, manual suppression preservation, audit rollback, and separate STOP/START confirmation intervals. A headless Microsoft Edge smoke test passed login, authenticator enrollment, policy editing, tenant/API-client/device creation, consent, STOP/START, audit and responsive layouts against a disposable database. Migration 006 and initial CMS account creation completed on local XAMPP MariaDB 10.4.32. Android unit tests, app/test APK assembly and lint passed (0 errors, 13 warnings); device instrumentation and real-SIM restoration remain unexecuted.

XAMPP migration repair (2026-09-25): reproduced the incomplete migration 005 on local MariaDB 10.4.32. Its database default was `utf8mb4_general_ci`, while `devices.id` used `utf8mb4_bin`. The new `sms_control_events` table now explicitly uses `utf8mb4_bin`; migration and repeated migration both completed on that database, and the FCM eligibility query passed. Test databases now use the XAMPP-style default collation so missing table collations are exercised. Backend build and all 50 tests passed on isolated MariaDB 11.8.8. The worker checks all required STOP/START tables at startup and reports missing migrations clearly, without logging credential or message content.

STOP/START and background-service increment: backend build and **50 tests passed, zero skipped**, on isolated MariaDB 11.8.8. Tests cover migration 005, opt-out suffix length, signed control ingestion, wrong SIM/unknown sender rejection, STOP cancellation including claimed jobs, ordinary-send blocking, duplicate/stale events, one-time STOP/START confirmation authorization and FCM eligibility, START without suppression/consent bypass, and audit rollback. Android debug and instrumentation APKs assemble successfully; **6 JVM tests pass**, and lint reports **0 errors, 16 warnings**. The two journal instrumentation tests (restart and v1-to-v2 migration/inbound ordering) compile but have not run: `adb devices` reports no attached device. No real STOP/START SMS, foreground-service lifecycle, boot, Doze or OEM battery test was performed. See the [upgrade and phone acceptance guide](stop-start-and-background.md).

Optional-idempotency follow-up: backend build and all 48 tests passed against isolated MariaDB. Custom API coverage now submits without a key, verifies the generated response header, reuses that key to retrieve the same job, rejects malformed supplied keys, and confirms repeated keyless requests still hit cooldown/content-replay protections. No migration or APK change is needed.

Custom-message follow-up: backend TypeScript build and all **48 tests passed, zero skipped**, against isolated MariaDB 11.8.8 on port 3307. Added coverage for exact custom text preservation, normalized recipients, optional purpose, strict request shapes, GSM extension/Unicode segment limits, malformed content, encrypted storage, idempotency, consent, cooldown, replay and suppression. No real custom SMS was sent during verification. This change requires no migration or APK rebuild. See [custom-message usage](custom-messages.md).

Local HTTP follow-up: the debug APK now permits private IPv4 HTTP origins; release behavior remains HTTPS-only. Four Android JVM tests pass, including private-network HTTP acceptance and production/public-host rejection. Debug assembly and lint passed, and the backend TypeScript build passed with configurable IPv4 `HOST` (default loopback). No phone-to-PC network test was performed. The MariaDB integration suite below predates this host-only server change.

Local environment: Windows, Node.js v24.18.0, portable MariaDB 11.8.8 on loopback port 3307. The official archive SHA-256 was verified before execution. Runtime files live in ignored `.local/`; no Windows service was installed.

- `npm.cmd run build`: passed.
- `npm.cmd test` with `TEST_DATABASE_URL`: **45 passed, zero failed, zero skipped** against real MariaDB.
- Compiled CLI smoke checks passed: migration, repeated migration, development seed and attributed operator mutation in an isolated database.
- Compiled FCM worker exits cleanly with `FCM_ENABLED=false` without contacting Firebase. UUID CommonJS compatibility check passed.
- Dependency audit after the Firebase installation and scoped UUID update: zero reported vulnerabilities. `gaxios` uses the compatible CommonJS UUID v4 API; its UUID dependency is overridden to the patched 11.1.1-or-later 11.x line.

Verified behaviors:

- FCM sends only bounded-TTL, normal-priority wake-up data. Concurrent workers publish once; published notifications do not advance SMS status.
- Pause, missing tokens, revocation, suppression, expiry and attempted jobs prevent dispatch. Transient failures respect durable backoff and Retry-After; permanent failures affect only notification state.
- Token rotation survives failure of an older token. Expired leases recover; stale acknowledgments cannot overwrite new leases. Lost publication acknowledgments may duplicate only a wake-up hint.
- UTC date decoding and Date parameters round-trip correctly on a non-UTC host, including lease deadlines and retry timestamps.

- P-256 public-key validation, pinned-key one-time enrollment and expired challenge rejection.
- Signed body verification, timestamp skew, replay rejection (including policy-rejected requests), encrypted FCM registration and revocation.
- Duplicate claims share a lease; concurrent authorizations yield exactly one permission to attempt. Wrong SIM, suppression, stale leases, expired jobs and another device are rejected.
- Failed authorization audit writes roll back the attempt marker. Lost authorization outcomes become UNKNOWN and never requeue; late delivery callbacks resolve state without resending. Event IDs deduplicate and terminal delivery does not regress on a late sent callback.

- Two independent pools and two tenants racing twelve submissions yield one accepted job and one outbox event; every competing request is rejected by global cooldown.
- Twelve concurrent same-key retries produce one job; differently cased keys remain distinct.
- Number normalization, authenticated encryption, authentication/scopes, tenant isolation, pause, consent, suppression, input validation, status/list queries and revoked credentials.
- Recipient, client and device quotas count UNKNOWN reservations.
- Failed outbox writes roll back job creation, idempotency and recipient cooldown. Failed audit writes roll back operator policy changes.
- Migrations rerun without resetting data or pause state. Operator pause cancels pending jobs without refunding reservations; revoked devices cannot resume; renewed consent does not clear suppression; tenant-mismatched changes fail.

Integration tests create and remove generated databases on the local disposable server. The temporary server was shut down after verification. CI is configured with MariaDB 11.8 and runs the same tests; the remote CI workflow itself has not been executed here.

The injected audit-failure test intentionally emits one redacted `request_failed` log and expects HTTP 500; it verifies rollback, not a test failure.

The backend build and all 45 MariaDB tests passed again after adding the server-relative `validForMs` authorization lifetime used by the Android client.

Android verification uses isolated JDK 17, Gradle 8.13, SDK platform 36 and build-tools 35.0.0 under ignored `.local/`. The Gradle distribution checksum was verified and pinned in the wrapper.

- Three JVM unit tests passed: exact signature framing/hash, HTTPS origin validation, and wall-clock/monotonic authorization deadlines.
- The Room restart instrumentation test compiles into the test APK. It checks that a persisted attempt rejects a new lease after reopening the database; it has not been executed on an emulator or device.
- Debug application and instrumentation APKs were assembled. The application APK is `android/app/build/outputs/apk/debug/app-debug.apk`.
- Final `testDebugUnitTest assembleDebug assembleDebugAndroidTest lintDebug` build passed. Lint reports zero errors and 14 warnings (dependency updates, icon, telephony requirement, Kotlin style and localization). Permission lookup handles revocation safely; no lint baseline or error suppression was added.
- Packaged APK inspection confirms minimum API 29, target API 36, SEND_SMS and READ_PHONE_STATE, with no READ_SMS or RECEIVE_SMS. WorkManager/Firebase add their normal scheduling and notification permissions.

FCM transport was faked for database integration tests. No live Firebase delivery, real SMS, device-permission, carrier or production-deployment tests have been performed. Android Keystore behavior, callback delivery and restart safety still require device validation. No Firebase Android configuration is bundled; manual and periodic sync are available without it.
