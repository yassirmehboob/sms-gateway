# Android SMS Gateway — Project Plan

**Version:** 1.1  
**Prepared:** 23 September 2026  
**Status:** Development started; database changed to MariaDB per owner instruction  
**Primary stack:** Android (Kotlin), Express.js (Node.js), Firebase Cloud Messaging (FCM), MariaDB, Redis (optional)

> **File-format note:** The accompanying `.mdf` file contains this same plain-text Markdown plan because that was the requested extension. `.md` is the conventional Markdown extension; `.mdf` is also commonly used for unrelated database-file formats. This document is not a SQL Server database file.

## 1. Project purpose and intended use

Build a **consent-based, administrator-controlled SMS gateway** using a dedicated Android phone and its SIM. A protected Express.js REST API accepts outbound SMS requests; FCM notifies the authorized Android device that work is available; the Android app sends SMS through the mobile network and reports status. The Android app also captures **only permitted and explicitly configured** incoming SMS and securely uploads them to the API for viewing or forwarding to an authorized business application.

**Important distinction:** FCM is a notification/command-transport service; it **does not send a cellular SMS**. Google Messages is a separate messaging app; do not design around automating its user interface or assuming it exposes a general remote-control API. The Android application uses Android telephony/SMS APIs, subject to OS permissions, default-SMS-app status, carrier restrictions, and distribution policies.

### 1.1 MVP goals

- Send a single, approved transactional SMS by a protected API request.
- Receive an inbound SMS on a controlled Android phone and upload eligible messages to the backend.
- Support one registered Android gateway and one chosen SIM/subscription initially; design database/API for multiple gateways later.
- Enforce per-recipient cooldowns, duplicate-request protection, opt-out/suppression, per-client/per-device quotas, and an emergency stop.
- Track *accepted*, *queued*, *claimed*, *send attempted*, *sent to carrier*, *delivery report received*, *failed*, and *unknown* separately.
- Keep a durable audit trail while minimizing exposure of phone numbers and message content.

### 1.2 Out of scope for MVP

- Bulk marketing, unsolicited messaging, sender-number spoofing, SIM-farm throughput, CAPTCHA/verification bypass, and unrestricted public SMS relay.
- Reading or forwarding all personal SMS, one-time passwords, banking alerts, or other unrelated private messages.
- MMS, RCS, attachments, group messages, or guaranteed immediate delivery.
- Unlimited concurrent physical devices, automatic SIM rotation, or carrier-limit avoidance.

## 2. Operating assumptions and decisions to confirm

| Decision | MVP choice | Why it matters |
|---|---|---|
| Device ownership | A dedicated, administrator-owned Android phone and SIM | Keeps personal correspondence separate from business traffic |
| Deployment | Private controlled distribution **subject to local law, carrier terms and Android permissions** | Google Play has additional SMS-permission eligibility/review rules |
| Play Store path | If public Play distribution is required, build a genuine default SMS application or obtain an applicable approval/exception **before** relying on restricted SMS permissions | A side-loaded APK does not waive OS permission or privacy obligations |
| Outbound recipients | Opted-in or otherwise authorized contacts only | Avoids open relay and unsolicited traffic |
| Inbound forwarding | Explicit sender/number allowlist and message-type policy; default deny | Prevents unrelated private SMS being copied to a server |
| Country/number format | Configure home country, e.g., `PK`; normalize to E.164 (e.g., `+923001234567`) | Avoids cooldown bypass through `0300...`, `92300...` and `+92300...` |
| Device/SIM | One configured subscription ID with operator verification | Prevents sending from an unexpected SIM on dual-SIM phones |
| Storage | MariaDB source of truth; encrypted device-side Room queue | Enables durable, transactional safety checks |
| Default cooldown | 5 minutes to the same destination **across all clients and gateway devices** | Starting policy; tighten for the actual use case |
| Delivery guarantee | At-most-one *automatic send attempt* per job; ambiguous outcomes require reconciliation | Mobile networks cannot provide true end-to-end exactly-once SMS delivery |

## 3. Architecture

```text
Approved business system / admin console
                 |
       TLS + client authentication
                 v
       Express.js REST API
       |     |           |
  policy &  MariaDB  audit / alerts
  quotas      |
       |    transactional outbox + job queue
       v              |
  Firebase Admin SDK  |
       |              |
   FCM device wake-up |
       v              v
  Android gateway <--- authenticated job claim/sync API
       |   |
       |   +--> Room local job / inbound outbox
       |   +--> callbacks, heartbeat, inbound upload -> Express API
       v
  Android SmsManager -> selected SIM -> mobile carrier -> recipient
  Android inbound SMS broadcast -> strict filtering -> local outbox -> Express API
```

**Critical design choice:** An FCM message is only a wake-up hint containing a `deviceId`/`jobAvailable` indicator, **not** the recipient, SMS text, API secrets, or the final sending instruction. The app authenticates to Express, claims authorized, unexpired work, and checks it again immediately before trying to send. Add a periodic/best-effort reconciliation sync for missed FCM notifications; do not treat FCM delivery as guaranteed.

## 4. Technical components

### 4.1 Android app (Kotlin)

- `MainActivity`: enrollment, gateway online/offline state, approved SIM, permission/default-handler status, daily usage, pause/resume and emergency stop.
- `FirebaseMessagingService`: receive FCM wake-up and enqueue a **unique** WorkManager sync operation; refresh and register FCM token on rotation.
- `GatewaySyncWorker`: authenticate, claim work, store job durably, and upload pending device events when network is available.
- `SmsSender`: verify job lease, authorization, SIM and local idempotency state; use `SmsManager` and `divideMessage`/multipart APIs when required.
- `SentStatusReceiver` / `DeliveryStatusReceiver`: correlate explicit, immutable `PendingIntent` request IDs and record part-level send/delivery results. Carrier submission is not proof that the person read the SMS; delivery reports can be missing.
- `InboundSmsReceiver`: accept only the appropriate Android SMS broadcast, reassemble multipart PDUs, filter before storage/upload, and put approved data in a persistent local outbox.
- `Room`: persist `jobId`, message fingerprint, approval/lease expiry, selected subscription, a **send-attempt-started** marker, callbacks, and inbound event IDs. Encrypt sensitive local fields where supported and prevent sensitive content entering logs/backups.
- `DeviceIdentity`: server-issued enrollment identity and device-held asymmetric private key (Android Keystore, where supported); rotate/revoke device credentials from the server.

**Android permission and distribution gate:** `SEND_SMS` and `RECEIVE_SMS` are sensitive/restricted. For a Play-distributed app, ensure its actual core role and declared permissions meet the current Google Play SMS policy; becoming the default SMS app requires a real messaging UX and required SMS/MMS intent handling, not simply requesting a role to bypass policy. Only a default SMS app receives `SMS_DELIVER_ACTION` and may write to the SMS Provider. A non-default app may receive `SMS_RECEIVED_ACTION` where OS permission and distribution policy permit; do **not** equate this with being a compliant Play-distributed SMS gateway. Test on target device/Android version before committing to that variant. Avoid `READ_SMS` unless genuinely necessary.

**Background behavior:** FCM can be delayed while offline or in Doze; high-priority FCM is not a reliable always-on worker and should not be misused for silent high-volume processing. Use WorkManager for short, durable synchronization with realistic background constraints. Do not promise exact arrival times or start an unrestricted foreground service solely to defeat platform limits.

### 4.2 Express.js API

- TypeScript + Express, Node.js active supported LTS; strict request schemas (Zod/Joi), centralized exception handling, structured redacted logging.
- MariaDB + migrations + transaction support. A worker processes a transactional outbox and sends short FCM wake-up notifications via Firebase Admin SDK.
- Optional Redis for fast IP/client throttling and short-lived locks, **not** as the only durable source of SMS-send safety.
- Admin UI/API for device enrollment, quotas, recipient suppression, audit, viewing authorized inbound messages, and manual reconciliation of unknown outcomes.
- Metrics/alerts for gateway offline, queue age, delivery failures, quota hits, permission/SIM changes, and abnormal traffic.

## 5. Outbound lifecycle and non-duplication design

1. Authorized client requests `POST /v1/messages` with a unique `Idempotency-Key`, normalized destination, approved template/purpose and template variables (or permitted message text).
2. Server checks client/device scopes, recipient consent/suppression, policy, length/segment count, client/device/recipient quotas, and global pause state.
3. **One MariaDB transaction** acquires the recipient's lock or recipient-policy row, checks/updates a *global destination cooldown*, reserves the permitted usage budget, saves the SMS job, stores idempotency response, and writes an outbox event. A unique key prevents two simultaneous requests from racing through this check.
4. Return `202 Accepted` with a stable job ID and status URL. The outbox worker issues a short FCM wake-up; an FCM success only means notification accepted by FCM.
5. Android authenticates and claims an eligible job with a short server lease; the server returns the canonical recipient/text and expiry *only to the assigned device*.
6. Android records the job and a durable send-attempt marker **before** invoking `SmsManager`. It immediately rechecks local pause, SIM, lease/expiry, and whether the job has already been attempted.
7. Android sends once; callbacks report sent-to-carrier/failed and optional part-level delivery receipts. The server accepts device events idempotently and updates an ordered state machine.
8. If the device crashes or acknowledgment is lost **after** a send attempt may have started, mark the job `UNKNOWN` and do **not** auto-send it again. Investigate device callback/SMS records where legally and technically permitted; only an authorized administrator may initiate a new job after review and a fresh policy check.

**Important limitation:** An atomic database write and a cellular SMS transmission cannot be a single transaction. The design prioritizes avoiding accidental repeat sends over automatically recovering every ambiguous attempt. Queued/unclaimed jobs may be retried; attempted/unknown jobs are not automatically retransmitted.

### 5.1 Recommended state machine

`ACCEPTED -> QUEUED -> NOTIFIED -> CLAIMED -> ATTEMPT_RECORDED -> SENT_TO_CARRIER -> DELIVERED`

Possible alternate/terminal states: `REJECTED_POLICY`, `EXPIRED`, `CANCELLED`, `FAILED_DEFINITE`, `UNKNOWN`. Network timeout after possible transmission must become `UNKNOWN`, not `FAILED_DEFINITE`. A delivery report is optional and must not block job closure indefinitely. Keep the FCM notification state separate from SMS states.

## 6. Abuse prevention and anti-repeat policy

**Enforce protection on the server, globally and atomically. Never rely only on a client-side timer, IP limit, or FCM message ID.** Suggested initial values are conservative configuration examples, not carrier-approved throughput limits:

| Control | Starting rule | Server action |
|---|---|---|
| Same destination cooldown | 1 outbound job every **5 minutes** per E.164 destination, regardless of client or device | HTTP `429`, `Retry-After`, `nextAllowedAt` |
| Per-destination rolling cap | Max **3 messages / 24 hours**, including reservations/unknown attempts | HTTP `429` until window frees |
| Identical content replay | Same tenant + destination + canonical template/content hash blocked for **24 hours** | HTTP `409` or return existing job for matching idempotency key |
| Per-client request rate | Example **10 accepted SMS / hour** initially; separate rate limit on rejected attempts | HTTP `429`; audit and alert |
| Per-device/SIM budget | Example **30 attempted SMS / day** until operator/compliance limits are confirmed | Queue hold or reject according to policy |
| API flood defense | Per-client and IP rate ceilings, request body-size cap, timeouts, WAF where applicable | Reject before expensive DB/FCM operations |
| Valid recipient policy | Verified opt-in/purpose, country/prefix allowlist, block premium/international destinations by default, suppression/STOP list | HTTP `403` or `422` |
| Payload policy | Approved templates where possible; restrict links, length, segment count and blocked content classes | Reject and log policy reason |
| Emergency stop | Global, tenant, device and SIM pause switches; manual disable for anomaly | No new claims or attempts; terminate pending jobs as appropriate |

**Policy semantics:** A new request **reserves** its number-specific cooldown immediately, so concurrent submissions cannot both pass. Count `ACCEPTED`, `CLAIMED`, `ATTEMPT_RECORDED`, `UNKNOWN` and `SENT_TO_CARRIER` against the relevant quota until policy-defined expiry; do not refund usage merely because an acknowledgment is missing. A rejected API request must not silently become a queued SMS. If an application needs two legitimate notifications in the same interval, aggregate into one approved message or use a formally reviewed exception with its own lower-risk cap and audit, never an unrestricted caller-supplied `force=true` bypass.

### 6.1 MariaDB atomicity pattern

- Unique `recipients(normalized_e164)` row acts as the **global** lock target. Inside the creation transaction, `SELECT ... FOR UPDATE` this row (create using INSERT ... ON DUPLICATE KEY UPDATE first).
- Check `next_allowed_at` and a rolling-window history or usage table under a compatible lock. Store next allowed time and accepted job together before `COMMIT`.
- Acquire per-client, per-device and global counter locks in a consistent order (or use serialization with bounded retry) so simultaneous requests cannot exceed caps.
- Unique `(tenant_id, idempotency_key)` with a stored request fingerprint and result: same key + same body returns same job; same key + different body returns `409`.
- Unique `(assigned_device_id, job_id)` in device-event handling and stable event IDs; signed device events cannot change destination/text or reset cooldown.
- Use database time for cooldown decisions. Redis may throttle earlier but cannot override a MariaDB denial.

## 7. Incoming SMS: privacy-first design

1. The phone receives SMS using the OS broadcast appropriate for the app's actual SMS role and permissions.
2. Reassemble multipart segments; normalize the sender and record the receiving SIM, timestamp and local event UUID.
3. **Default deny**: forward only messages from explicitly approved senders/number ranges and for documented business purposes. Exclude OTPs, financial/security alerts and personal communications unless there is a separate, valid and explicitly authorized use case; do not forward entire personal inboxes.
4. For the inbound STOP/unsubscribe keyword, update suppression before generating any further outbound communications. Consider START/re-subscribe only through a documented consent process; do not assume every incoming text is consent.
5. Save eligible inbound events in an encrypted local Room outbox; upload using device authentication and HTTPS. Retry upload with backoff until acknowledged, retaining the same stable event UUID.
6. Server deduplicates on `(device_id, inbound_event_id)` and stores only necessary fields (sender, receiving SIM, approved content, time, classification, retention deadline). Apply sender-based ingress rate limits and webhook authorization.
7. Only an authorized system/admin may read inbound records or configure an outbound webhook; sign webhooks and retry idempotently.

**Receiving limitation:** No device app can force a sender's SMS to arrive while the SIM/network is unavailable; inbound SMS access depends on the actual Android role, permissions, and device configuration. This is *not* an approach for intercepting third-party messages.

## 8. REST API contract (v1)

### 8.1 Client endpoints

| Method/path | Purpose | Required authorization |
|---|---|---|
| `POST /v1/messages` | Request one outbound message | `sms:send` + client quota + recipient permission |
| `GET /v1/messages/:id` | View status and permitted metadata | `sms:read` restricted to same tenant |
| `GET /v1/messages?status=...` | Paginated outbound list | `sms:read` |
| `GET /v1/inbound` | Filter/paginate eligible inbound messages | `sms:inbound:read` |
| `POST /v1/recipients/:number/suppress` | Add suppression/opt-out | `sms:compliance:write` |
| `POST /v1/admin/gateways/:id/pause` | Emergency pause | Administrator + MFA + audit |

### 8.2 Device endpoints

| Method/path | Purpose | Required authorization |
|---|---|---|
| `POST /v1/device/enroll` | Exchange short-lived single-use enrollment challenge for device identity | Physical admin approval + one-time pairing |
| `POST /v1/device/fcm-token` | Register/rotate FCM token | Bound device credentials |
| `POST /v1/device/jobs/claim` | Claim assigned, valid work | Bound device credentials; server lease |
| `POST /v1/device/jobs/:id/events` | Report send-attempt/status event using unique event ID | Bound device credentials + job ownership |
| `POST /v1/device/inbound` | Upload allowed inbound event | Bound device credentials + inbound policy |
| `POST /v1/device/heartbeat` | Report online state, permission, SIM and pause status | Bound device credentials |

**Sample authorized send request (illustrative; don't use real numbers in test data):**

```http
POST /v1/messages
Authorization: Bearer <short-lived-client-token>
Idempotency-Key: 5f0e91e6-1f86-40b8-baa2-a950eeea07e1
Content-Type: application/json

{
  "to": "+923001234567",
  "templateId": "appointment_reminder_v1",
  "variables": {"date": "2026-09-24"},
  "purpose": "transactional_notification"
}
```

**Example success:** `202 Accepted` with `{"jobId":"uuid","status":"QUEUED","statusUrl":"/v1/messages/uuid"}`. **Cooldown response:** `429 Too Many Requests` with `Retry-After: 300` and `{"code":"RECIPIENT_COOLDOWN","nextAllowedAt":"..."}`. Return `409` on reused idempotency key with changed payload; `403` for insufficient scope or suppressed recipient; `503`/queue hold when gateway is unavailable according to business policy. Never return provider keys, device tokens, or unnecessary inbound body data.

## 9. Authentication, authorization, and infrastructure security

- **Human admin:** identity provider + MFA, role-based access control, auditable device enrollment/revocation, approval for exceptional sends, and alert review.
- **Calling systems:** per-tenant scoped credentials; prefer OAuth2 client credentials with short-lived access tokens or a rotated, hashed high-entropy API key exchanged for short-lived credentials. Add IP allowlisting for known backends, but never use IP as sole proof of identity.
- **Android gateway:** explicit enrollment requiring admin approval; Keystore-backed device key and short-lived, device-bound tokens or signed challenges. Restrict each identity to its own assigned jobs and SIM. FCM registration token is a routing address, **not authentication**.
- **Firebase:** Firebase Admin SDK/server credentials only on protected backend; never bundle service-account JSON in the APK; least-privilege cloud IAM; restrict console access.
- **Transport:** HTTPS/TLS; server-side timeouts and replay-resistant signed device callbacks (event ID + timestamp/nonce + bounded clock skew), or equivalent proof-of-possession. Protect webhook subscriptions with HMAC signature + timestamp and retry-safe event ID.
- **Input/database:** canonical E.164 normalization via maintained library; strict template variables, content/segment caps, no client-controlled device selection unless authorized; parameterized SQL; validation on all device event transitions; encrypted backups and database secret management.
- **Sensitive data:** redact numbers and message bodies from standard logs; encrypt message content at rest where stored; minimal RBAC-limited retention (e.g., message bodies 30 days, metadata 90 days, adjustable by policy); no OTP/bank-alert collection by default. Publish consent/retention procedures.
- **Operations:** secrets rotation, dependency scans, patching, admin notification on large bursts, device compromise, changed SIM, missing permissions, excessive 401/403/429 responses, and unusual destinations.

## 10. Data model (proposed)

| Table | Main fields / constraints |
|---|---|
| `tenants` | `id`, name, status, allowed_purposes, quota_policy |
| `api_clients` | `id`, tenant_id, name, credential_hash / issuer binding, scopes, enabled |
| `devices` | `id`, tenant_id, public_key, encrypted_fcm_token, allowed_sim_id, state, last_seen_at, revoked_at |
| `recipients` | `normalized_e164` **UNIQUE**, `next_allowed_at`, suppression_state, consent_reference |
| `recipient_tenant_consents` | tenant_id, normalized_e164, purpose, lawful_basis/consent_evidence, confirmed_at, revoked_at |
| `outbound_messages` | id UUID, tenant_id, client_id, device_id, normalized_e164, approved_content_ref/encrypted_body, body_hash, segments, status, lease_expires_at, send_attempt_started_at, created_at, expires_at |
| `idempotency_keys` | `(tenant_id, key)` **UNIQUE**, request_hash, job_id, response_status, expires_at |
| `device_events` | `(device_id, event_uuid)` **UNIQUE**, job_id, type, part_index, outcome, recorded_at |
| `inbound_messages` | `(device_id, inbound_event_id)` **UNIQUE**, sender, receiver_sim, encrypted_approved_body, received_at, classification, retention_until |
| `usage_counters` | scope_type, scope_id, policy_window, reserved_segments/messages; transactional update |
| `outbox_events` | id, event_type, aggregate_id, payload_ref, published_at, retry_count |
| `audit_logs` | actor, tenant_id, action, resource_id, reason, timestamp, redacted metadata |

Partition larger event/audit tables when needed; index job state + assignment + expiry, time-window quota keys, incoming sender/time, and tenant-scoped history. Do not assume a normal SQL `UNIQUE` constraint can enforce an arbitrary rolling five-minute window by itself; use transactional locking and stored `next_allowed_at`.

## 11. Folder structure

```text
sms-gateway/
  android/
    app/src/main/java/.../
      ui/                 # enrollment, device status, pause, logs
      messaging/          # FCM receiver, WorkManager sync
      telephony/          # selected SIM, sender, sent/delivery receivers
      inbound/            # receive, reassemble, filter, local outbox
      data/               # Room, repositories, encrypted settings
      security/           # pairing, Keystore, device auth
    app/src/test/         # unit tests
    app/src/androidTest/  # real-device/instrumented tests
  server/
    src/app.ts
    src/routes/           # client, device, admin
    src/middleware/       # auth, scopes, schema, rate controls
    src/services/         # dispatch, cooldown, consent, status
    src/workers/          # durable outbox -> FCM, expiry/reconcile
    src/db/               # migrations, repository transactions
    src/security/         # device signatures, secret handling
    src/tests/            # API + race-condition tests
  docs/
    api-openapi.yaml
    security-threat-model.md
    device-enrollment-runbook.md
    operations-runbook.md
    privacy-retention-policy.md
  docker-compose.dev.yml
  README.md
```

## 12. Implementation phases and acceptance criteria

### Phase A — Requirements, permissions, and threat model

- Confirm legitimate messaging purpose, recipient consent model, allowed inbound senders, intended carrier/SIM, device ownership, number format, traffic ceiling and Play/private-distribution decision.
- Test SMS send/receive permissions and default-app behavior on the target phone and Android versions; verify operator terms and local rules before deployment.
- Document admin roles, API consumers, incident response, permitted templates, retention, and the `UNKNOWN` handling policy.
- **Exit:** signed-off scope, permission feasibility demonstration, threat model, and policy table.

### Phase B — Backend foundation and send protections

- Build Express TypeScript app, MariaDB migrations, auth/scopes, device enrollment/revocation, E.164 normalization, recipient consent/suppression and audit.
- Implement MariaDB transaction-based idempotency/cooldown/quotas, durable jobs/outbox, status endpoints, global pause and FCM Admin SDK worker.
- **Exit:** concurrency tests prove one eligible job per destination/cooldown, across multiple clients and API instances; unauthorized clients receive no SMS job.

### Phase C — Android gateway and outbound delivery

- Implement device pairing, FCM registration/rotation, work sync, local Room journal, SIM selection, `SmsManager` single/multipart sends, sent/delivery callbacks and authenticated event uploads.
- Test killed app process, offline network, power-saving mode, SIM removal/change, denied permission, device reboot, duplicate FCM, and lost callback.
- **Exit:** authorized test message completes on a real device, and ambiguous send attempts never trigger automatic retransmission.

### Phase D — Restricted inbound and operational safeguards

- Add permitted inbound broadcast, multipart reassembly, default-deny sender filtering, durable encrypted outbox, server ingestion dedup, STOP/suppression, admin audit view and signed downstream webhook if needed.
- Add health/metrics, alerts, emergency pause, redacted logs, retention cleanup and backup/restore.
- **Exit:** only allowlisted business messages enter server storage; retries do not duplicate inbound records; STOP prevents future sends.

### Phase E — Security validation and controlled rollout

- Perform threat-model review, credential-rotation tests, role/scope checks, penetration testing of enrollment/claim/callback endpoints, abuse simulations and real-SIM carrier testing.
- Start with one phone, one approved client and low daily quotas. Review actual delivery outcomes, costs, operational stability, privacy implications and carrier compliance before expansion.
- **Exit:** documented test evidence, production runbook, admin training, rollback/stop procedure and explicit release authorization.

## 13. Minimum test matrix

| Test | Expected result |
|---|---|
| Two clients request same destination simultaneously | Exactly one accepted job; other rejected by recipient cooldown |
| Same `Idempotency-Key` retried with identical request | Same job ID returned; no extra SMS |
| Same key reused with different text/recipient | `409` and no new job |
| `0300...`, `92300...`, `+92300...` represent one destination | Shared E.164 cooldown and suppression |
| Repeat after 2 minutes / after 5 minutes | Rejected during cooldown / eligible only if all other caps pass |
| Suppressed or unconsented recipient | Denied before FCM or device claim |
| Duplicate FCM wake-up or job claim | One durable local job and at most one automatic send attempt |
| Device loses connectivity after `SmsManager` call | Job becomes `UNKNOWN`; not automatically re-sent |
| Phone offline or FCM delayed past job expiry | Expired job is not transmitted later |
| Dual-SIM phone or unexpected SIM switch | No SMS sent from unapproved subscription |
| Inbound unrelated personal/OTP/banking message | Not uploaded; no body in logs |
| Same inbound event uploaded twice | One database record; stable response/event ID |
| Device revoked / API key leaked / admin pauses service | Claims blocked; credentials invalidated; auditable alert |
| Burst of malformed, oversized or unauthorized requests | Rate limited/rejected without consuming SMS allowance |

## 14. Open questions before coding

1. Is the Android phone dedicated solely to this gateway, and will the app be privately deployed or publicly listed on Google Play?
2. Which country, operator and SIM plan will be used, and what transactional traffic is contractually allowed?
3. What constitutes an authorized/opted-in recipient? Are templates fixed, and what business event triggers each SMS?
4. Are inbound messages needed from **all** numbers or just specific approved senders? The proposed safe default is an allowlist.
5. Should responses be shown in an admin dashboard, delivered to a signed webhook, or both?
6. Is a five-minute same-number cooldown and three messages per 24 hours appropriate for the actual use case?
7. What should the system do when the phone is offline: reject immediately, queue until short expiry, or notify an operator?
8. Is multi-device routing required later? If yes, keep cooldowns and suppression **global across devices**, not per SIM.

## 15. Official references (review again at implementation time)

- Android default SMS handler and permissions: https://developer.android.com/guide/topics/permissions/default-handlers
- Google Play restricted SMS/Call Log permission policy: https://support.google.com/googleplay/android-developer/answer/10208820
- Android telephony and default SMS app behavior: https://developer.android.com/reference/android/provider/Telephony
- Android SMS inbound intent reference: https://developer.android.com/reference/android/provider/Telephony.Sms.Intents
- Android `SmsManager` reference: https://developer.android.com/reference/android/telephony/SmsManager
- Firebase FCM Android priority / background limitations: https://firebase.google.com/docs/cloud-messaging/android-message-priority
- Firebase message ordering/collapse behavior: https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types
- Firebase message lifetime / acceptance vs delivery: https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan
- Android WorkManager work requests: https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work

---

**Guiding rule:** A request becoming a successful API response, an FCM send, or a claimed device job must **never** be interpreted as proof that a cellular SMS was sent or delivered. Protect recipients first; ensure every possible retransmission passes a new, explicit safety decision.
