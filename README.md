# Android SMS Gateway

The CMS now supports creating administrators/viewers, multiple tenant assignments and per-section permissions. Existing admins retain full access as super administrators. Apply migration 008; see [CMS users and permissions](docs/cms-users-and-permissions.md).

The management CMS supports contact entry, Excel import, groups, paced bulk SMS and scheduled batches. See [Contacts and bulk messaging](docs/contacts-and-bulk-messaging.md). This update requires migration 007 and an updated dependency installation.

Development follows [the project plan](android_sms_gateway_project_plan.md), using MariaDB. The backend includes policy-protected queues, an audited operator CLI, signed device enrollment/requests, one-time send authorization, delivery events and an FCM worker. The first Android app implements enrollment, a durable attempt journal and selected-SIM outbound sending. Inbound handling and real-phone acceptance testing remain pending. See [development status](docs/development-status.md).

## Run locally

Requires Node.js 24 and MariaDB 11.8 (or Docker Compose).

```powershell
docker compose -f docker-compose.dev.yml up -d
cd server
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the generated value into `CONTENT_ENCRYPTION_KEY` in `server/.env`. Generate a separate random value for `DEV_API_KEY`; keep both secret.

```powershell
npm.cmd run build
npm.cmd run migrate
npm.cmd run seed:dev
npm.cmd test
npm.cmd run dev
```

The API listens on `http://127.0.0.1:3000`; `GET /healthz` is a liveness endpoint. The seed creates a development client with send/read/suppression scopes. A fresh database is paused with no devices or recipient consent. Use the [operator CLI](docs/operator-runbook.md) for audited device provisioning, consent, pause and revocation. The CLI is restricted by host/database access; it is not the future MFA-protected admin web interface.

`DATABASE_URL` uses `mariadb://user:password@127.0.0.1:3306/gateway`; percent-encode reserved characters in credentials. Add `?ssl=true` for a remote database with a trusted TLS certificate. All application timestamps use UTC. Migrations target a fresh MariaDB database; they do not import an existing PostgreSQL database. See [database notes](docs/mariadb.md).

## Current API

The local [management CMS](docs/cms.md) runs at `http://127.0.0.1:3001/admin/` on the backend PC. It provides password/authenticator login, policy settings, recipient START/STOP and consent, device enrollment, API keys, status and audit views. Apply migration 006 and create a local administrator with `npm.cmd run admin:create -- admin` on a new installation. Bootstrap credentials are saved under ignored `.local/`.

The client endpoints below require `Authorization: Bearer <DEV_API_KEY>`. Device endpoints under `/v1/device` instead require P-256 request signatures; see the [device protocol and enrollment guide](docs/device-protocol.md).

| Endpoint | Scope | Behavior |
|---|---|---|
| `POST /v1/messages` | `sms:send` | Reserve a permitted message; optional `Idempotency-Key` (8–128 URL-safe characters), generated when omitted |
| `GET /v1/messages/:id` | `sms:read` | Tenant-scoped status, no body or number |
| `GET /v1/messages?limit=20&offset=0&status=QUEUED` | `sms:read` | Paginated status list |
| `POST /v1/recipients/:number/suppress` | `sms:compliance:write` | Globally suppress a recipient known to the tenant and cancel queued jobs |

Messages accept custom text: `{"to":"+923001234567","body":"Your order is ready."}`. Purpose defaults to `transactional_notification`. The existing template format (`templateId: "appointment_reminder_v1"`, `purpose: "transactional_notification"`, `variables: {"date": "2026-09-24"}`) remains supported. Do not mix template fields with `body`. Only valid Pakistan mobile numbers with recorded consent are accepted. See [custom-message API](docs/custom-messages.md) for examples and single-segment limits.

Run `npm.cmd run migrate` on existing MariaDB installations to apply all pending migrations, including 004 for FCM dispatch. The API process reconciles expired jobs/leases, uncertain attempts and expired request nonces every 30 seconds. Authorization is deliberately issued once per job; a lost response must never trigger an automatic resend.

The FCM worker is disabled by default. Configure Firebase credentials and `FCM_ENABLED=true`, then run `npm.cmd run worker:fcm` as a separate process. See the [worker setup and recovery guide](docs/fcm-worker.md). Notifications contain only wake-up hints and never authorize an SMS.

## Verification

For recipient STOP/START commands, opt-out instructions in custom messages, and the ongoing Android background service, follow the [STOP/START and background upgrade guide](docs/stop-start-and-background.md). Apply migration 005 before installing the new APK; grant the new RECEIVE_SMS permission and resume the app to start its foreground service.

For Android builds and pairing, see the [Android gateway guide](docs/android-gateway.md). The current app requires the backend's additive `validForMs` authorization field and a trusted HTTPS endpoint. It starts paused; configure consent and an approved SIM before controlled real-device testing.

`npm.cmd test` always runs unit tests. Database integration tests require a real MariaDB server and are explicitly skipped without `TEST_DATABASE_URL`. With the development Compose database:

```powershell
$env:TEST_DATABASE_URL = 'mariadb://root:root_dev_only@127.0.0.1:3306/gateway'
npm.cmd test
```

Integration tests create and remove their own randomly named databases, so the test account requires CREATE/DROP DATABASE and trigger permissions. Use a local disposable server, not production credentials. The concurrency test uses two pools and two tenants to race twelve submissions, then tests concurrent idempotent retries. CI supplies MariaDB and runs all tests. No test connects to FCM or telephony.

Tenant defaults, per-tenant overrides and paid-service expiry are documented in [Tenant defaults and expiry](docs/tenant-defaults-and-expiry.md).
