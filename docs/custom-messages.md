# Custom-message API

Restart the backend after this update (`npm.cmd run dev`, or `npm.cmd run build` followed by `npm.cmd start`). No database migration or Android rebuild is needed. The Android client already verifies the body hash and actual single-segment fit before authorizing a send.

Send `POST /v1/messages` with `Authorization: Bearer YOUR_API_KEY` and `Content-Type: application/json`. `Idempotency-Key` is optional; omit it for a simple submission:

```json
{
  "to": "+923001234567",
  "body": "Hello Ali, your order 123 is ready for collection.",
  "includeOptOut": true,
  "evidenceReference": "CUSTOMER-SIGNUP-123"
}
```

Use the actual authorized recipient. Pakistan mobile formats such as `03001234567` and `923001234567` normalize to the same international number. International and landline destinations remain rejected. Routing uses the gateway SIM; carrier delivery is not guaranteed by API acceptance.

`purpose` is optional and defaults to `transactional_notification`, the only supported purpose. `body` is preserved and no variables are expanded. Optional `includeOptOut:true` appends a newline and `Reply STOP to unsubscribe`; the final text must fit one segment. Without this option no footer is appended. Your calling application can insert variable values before submission. The existing appointment template remains supported, but mixing `body` with `templateId`/`variables` is invalid. See [STOP/START upgrade and behavior](stop-start-and-background.md).

Only one SMS segment is supported: up to 160 GSM-7 units, with extension characters such as `^`, `{`, `}`, `\\`, `[`, `]`, `~`, `|`, and `€` counting as two. Text containing non-GSM characters (including Urdu) is limited to 70 UTF-16 units; emoji may consume two or more units. See [SMS encoding limits](https://www.twilio.com/docs/glossary/what-sms-character-limit). The phone performs an additional SIM/platform segment check.

Empty/whitespace-only text, malformed Unicode, and unsupported control characters are rejected. Line breaks are allowed. Over-segment text returns HTTP 422 `MESSAGE_TOO_LONG`; malformed/empty content returns 400 `INVALID_REQUEST` or 422 `INVALID_MESSAGE_BODY`. Request schema validation also rejects bodies longer than 4096 UTF-16 units.

Optional `evidenceReference` records permission your project already collected outside the gateway. If consent is missing for the API key's tenant, recipient and purpose, the same transaction creates it and queues the message. The reference must be 3–128 characters using letters, digits, `_`, `.`, `:`, `/` or `-` (no spaces). It is stored as consent evidence and in a `CONSENT_RECORDED_ON_SEND` audit entry linked to the API client and message; it is never appended to the SMS.

Existing active consent is reused without replacing its evidence. Without a reference, missing consent still returns `CONSENT_REQUIRED`. Supplying a reference cannot restore revoked consent (`CONSENT_REVOKED`), clear SMS STOP (`RECIPIENT_OPTED_OUT`), or override manual suppression (`RECIPIENT_SUPPRESSED`). API scopes, global/device pause, cooldown, quotas, content replay protection and encrypted storage still apply. If acceptance fails, new consent and its audit entry roll back with the message. Each tenant must provide its own evidence; another tenant's consent is not reused. Retries with the same idempotency key must also preserve the evidence reference; changing it returns `IDEMPOTENCY_CONFLICT`.

On cPanel the endpoint is `POST https://itsc.usindh.edu.pk/sms-gateway/v1/messages`. Upload and extract `.local/cpanel-inline-consent-update.zip` in the application root, replacing `dist`, `public` and `app.cjs`, then restart in cPanel. Preserve your existing `.env`. No migration, dependency installation, Android update or cPanel terminal is required.

HTTP 202 returns `jobId` and `statusUrl`, meaning queued rather than delivered. GET that status URL with the same Bearer key to track delivery. If you omit `Idempotency-Key`, the server generates a fresh key per request and returns it in the response's `Idempotency-Key` header. Repeating a request without a key does not return the original job; it is a new submission subject to cooldown and 24-hour content replay protection. Check message status/list after a lost response instead of blindly resubmitting.

For reliable retries, optionally provide an `Idempotency-Key` of 8–128 URL-safe characters and reuse it for the identical request; changing the body with that key returns HTTP 409 `IDEMPOTENCY_CONFLICT`. Empty or malformed supplied keys are rejected. Never use one fixed key for all recipients/messages. A new key does not bypass cooldown or content replay protection. The app never automatically resends uncertain attempts.
