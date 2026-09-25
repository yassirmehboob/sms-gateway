# Custom-message API

Restart the backend after this update (`npm.cmd run dev`, or `npm.cmd run build` followed by `npm.cmd start`). No database migration or Android rebuild is needed. The Android client already verifies the body hash and actual single-segment fit before authorizing a send.

Send `POST /v1/messages` with `Authorization: Bearer YOUR_API_KEY` and `Content-Type: application/json`. `Idempotency-Key` is optional; omit it for a simple submission:

```json
{
  "to": "+923001234567",
  "body": "Hello Ali, your order 123 is ready for collection.",
  "includeOptOut": true
}
```

Use the actual authorized recipient. Pakistan mobile formats such as `03001234567` and `923001234567` normalize to the same international number. International and landline destinations remain rejected. Routing uses the gateway SIM; carrier delivery is not guaranteed by API acceptance.

`purpose` is optional and defaults to `transactional_notification`, the only supported purpose. `body` is preserved and no variables are expanded. Optional `includeOptOut:true` appends a newline and `Reply STOP to unsubscribe`; the final text must fit one segment. Without this option no footer is appended. Your calling application can insert variable values before submission. The existing appointment template remains supported, but mixing `body` with `templateId`/`variables` is invalid. See [STOP/START upgrade and behavior](stop-start-and-background.md).

Only one SMS segment is supported: up to 160 GSM-7 units, with extension characters such as `^`, `{`, `}`, `\\`, `[`, `]`, `~`, `|`, and `€` counting as two. Text containing non-GSM characters (including Urdu) is limited to 70 UTF-16 units; emoji may consume two or more units. See [SMS encoding limits](https://www.twilio.com/docs/glossary/what-sms-character-limit). The phone performs an additional SIM/platform segment check.

Empty/whitespace-only text, malformed Unicode, and unsupported control characters are rejected. Line breaks are allowed. Over-segment text returns HTTP 422 `MESSAGE_TOO_LONG`; malformed/empty content returns 400 `INVALID_REQUEST` or 422 `INVALID_MESSAGE_BODY`. Request schema validation also rejects bodies longer than 4096 UTF-16 units.

Consent, suppression, API scopes, global/device pause, five-minute destination cooldown, quotas, 24-hour content replay protection and encrypted storage apply equally to custom messages. This is not a consent bypass. Record actual consent using the operator CLI before submission.

HTTP 202 returns `jobId` and `statusUrl`, meaning queued rather than delivered. GET that status URL with the same Bearer key to track delivery. If you omit `Idempotency-Key`, the server generates a fresh key per request and returns it in the response's `Idempotency-Key` header. Repeating a request without a key does not return the original job; it is a new submission subject to cooldown and 24-hour content replay protection. Check message status/list after a lost response instead of blindly resubmitting.

For reliable retries, optionally provide an `Idempotency-Key` of 8–128 URL-safe characters and reuse it for the identical request; changing the body with that key returns HTTP 409 `IDEMPOTENCY_CONFLICT`. Empty or malformed supplied keys are rejected. Never use one fixed key for all recipients/messages. A new key does not bypass cooldown or content replay protection. The app never automatically resends uncertain attempts.
