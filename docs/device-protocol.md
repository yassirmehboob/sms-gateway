# Device protocol v1

Migration 005 adds signed `POST /v1/device/inbound-control` with `{eventId,from,command,subscriptionId,receivedAt}`. `command` is exactly STOP or START; `receivedAt` is the SMS sender timestamp in epoch milliseconds. Only the assigned receiving SIM and known recipient are accepted. Claim responses add nullable `controlCommand` for internally generated, fixed confirmation jobs; API clients cannot set it. See [STOP/START behavior](stop-start-and-background.md).

The backend protocol is implemented on MariaDB and the first Android client is available in `android/`. Real-device and real-SIM validation remain pending. Single-segment custom text and the existing reminder template are supported.

## Enrollment

1. Generate a P-256 key in Android Keystore. Export only the SPKI PEM public key (`BEGIN PUBLIC KEY`). Keep the private key on the phone.
2. A trusted operator verifies the device/key fingerprint physically, runs `device-create`, then `device-enrollment` with `tenantId`, `deviceId` and `publicKey`.
3. The CLI returns a sensitive 256-bit `enrollmentToken`. Transfer it privately to that phone. It expires in ten minutes, is stored hashed and is bound to the approved key. Reissuing a challenge invalidates the previous challenge.
4. Sign `POST /v1/device/enroll` with `{"enrollmentToken":"..."}`. Success binds the key and consumes the challenge, without resuming the device.

If the response is lost, use a signed heartbeat to check whether binding succeeded. Enrolled/revoked identities cannot receive new challenges. Key replacement currently requires revocation and a new device identity. Hardware attestation is not implemented; the server verifies key possession, not hardware origin.

## Signing

All device endpoints use POST with `Content-Type: application/json` and headers:

| Header | Value |
|---|---|
| `X-Device-Id` | Device UUID |
| `X-Device-Timestamp` | Unix seconds, ten decimal digits |
| `X-Device-Nonce` | Fresh UUID per request |
| `X-Device-Signature` | Standard Base64 of DER ECDSA/SHA-256 signature |

Sign these UTF-8 lines, joined with LF and **no trailing newline**:

```text
sms-gateway-device-v1
<device UUID>
<timestamp>
<nonce UUID>
POST
/v1/device/<exact path>
<lowercase SHA-256 hex of exact body bytes>
```

Serialize JSON once, sign it and send identical bytes. Query strings and compressed bodies are unsupported. Android uses `SHA256withECDSA` and `secp256r1`; DER signatures are required, not IEEE-P1363. Use separate keys per environment. HTTPS remains required outside local development: signatures do not encrypt content.

Database time permits 120 seconds of clock skew. A valid signature consumes its nonce even when policy rejects the operation. Retry with a fresh nonce/signature; event retries retain the original event ID. Nonces are kept for five minutes, beyond timestamp validity. Revoked devices and disabled tenants cannot authenticate. FCM tokens and caller API keys are not device credentials.

## Endpoints

Readiness is `{"subscriptionId":1,"canSendSms":true,"locallyPaused":false}`. This is a device report, not independent proof of permissions or SIM state.

| Path under `/v1/device` | Body | Result |
|---|---|---|
| `/enroll` | `enrollmentToken` | Device ID, approved subscription, pause state |
| `/heartbeat` | readiness object | Server pause and subscription; updates last-seen time |
| `/fcm-token` | `{"token":"..."}` | Encrypted routing token registration for the separate FCM worker |
| `/jobs/claim` | readiness object | `{"job":null}` or job ID, recipient/body/hash, lease ID, subscription, segment count and deadlines |
| `/jobs/:id/authorize` | `{"leaseId":"...","readiness":{...}}` | One-time authorization with `validUntil` and server-relative `validForMs` |
| `/jobs/:id/events` | `eventId`, `leaseId`, `partIndex:0`, `type` | Stable acknowledgment and resulting status |

Claims last at most 60 seconds, bounded by job expiry. Duplicate claims share an active lease. An expired unattempted lease can be replaced, but its old ID cannot authorize. Only the assigned device can retrieve work. Authorization rechecks pause, tenant/client permission, consent/suppression, readiness, SIM, lease and expiry.

## At-most-one attempt

Android must persist a durable local attempt marker **before** requesting authorization. Only a successful authorization response permits invoking `SmsManager`, immediately after rechecking the local marker, pause, permissions, selected SIM and deadline. Use `validForMs` with elapsed monotonic time measured from before the authorization request, so device/server clock skew cannot extend authorization. The Android client applies a five-second safety margin. A worker restart, timeout or lost/late response must never cause automatic reauthorization or retransmission.

The server commits `ATTEMPT_RECORDED` before responding and refuses all later authorization requests for that job. After two minutes without a callback, it becomes UNKNOWN and never returns to the queue. Lost authorization responses deliberately sacrifice automatic recovery. Manual reconciliation will require a fresh reviewed job; no reset/force endpoint exists.

Pause prevents new authorization but cannot recall authorization already issued or a cellular send already started. The device must minimize the authorization-to-send interval. Database persistence and cellular transmission cannot be one atomic transaction.

Event types: `SENT_TO_CARRIER`, `DELIVERED`, `FAILED_DEFINITE`, `UNKNOWN`. Events require the original lease and a recorded attempt. Identical event-ID retries return the original acknowledgment; changed content returns `409 EVENT_CONFLICT`. Late definitive events may resolve UNKNOWN. Delivery before sent is accepted; a later sent callback preserves DELIVERED. Contradictory terminal transitions are rejected. No event can change content/recipient or requeue work. The acknowledgment reflects its original acceptance; client status endpoints show current state.

The API reconciles expiry, stale unattempted leases, unknown attempts and expired nonces every 30 seconds under the policy lock, and on device heartbeat/claim. Processing resumes at API startup after downtime. Carrier submission is not delivery, and delivery is not proof of reading.

References: [Android Keystore signing](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec), [Node crypto verification](https://nodejs.org/download/release/v26.7.0/docs/api/crypto.html).
