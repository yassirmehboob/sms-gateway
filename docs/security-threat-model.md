# Initial threat model

Status: development draft, not Phase A sign-off or a production security assessment.

Assets: consent evidence, recipient identifiers, message content, client credentials, future device private keys, gateway SIM budget, delivery history and suppression state.

Trust boundaries: callers to API; API to MariaDB; future API to FCM; future device to claim/event APIs; Android to SIM/carrier. FCM is only a wake-up channel and must never grant sending authority.

| Threat | Current control | Remaining validation or implementation |
|---|---|---|
| Open relay / stolen caller key | Hashed high-entropy credentials, scopes, enabled flags, tenant consent and single-segment content validation | Rotation, short-lived tokens, incident alerts |
| Concurrent duplicate submissions | Shared InnoDB row lock, canonical number, idempotency fingerprint, cooldown and quotas in one transaction | Real MariaDB race suite passed locally; CI configured |
| Cross-tenant reads | Tenant predicate on every message read | Expand checks as endpoints are added |
| Payload/content disclosure | AES-GCM body encryption, no bodies/numbers in status responses or ordinary error logs | Key rotation, disk/backup encryption, retention deletion |
| Policy bypass through alternate numbers | Maintained number parser and PK mobile restriction | Confirm actual approved destination scope |
| Request flooding | Body cap and per-IP/per-client process-local throttling | Shared ingress limits and proxy configuration |
| Opt-out ignored | Signed STOP/START reports, separate global SMS opt-out, cancellation, local recipient block and pre-authorization policy recheck | Real SIM/offline race validation; an already invoked modem send cannot be recalled |
| Compromised gateway / forged callbacks | Approved P-256 enrollment, Android Keystore, signed requests, timestamp/nonces, event dedup and revocation | Hardware attestation if required; an authorized compromised device can still falsify reports |
| Duplicate send after crash | One-time server authorization, Room attempt tombstones, monotonic deadline checks, expiry and UNKNOWN reconciliation | Instrumented restart and real-SIM crash testing |
| Private inbound messages uploaded | Only standalone STOP/START on the selected SIM enter an encrypted local queue; server requires a known recipient and signed device report | OEM SIM-metadata validation, retention cleanup and carrier sender-spoofing limitations |

Admins and database operators are trusted to provision actual consent and to use the global policy lock for all policy mutations. The local operator CLI applies that lock and commits an audit record with each change; access relies on host/database permissions, and its supplied actor ID is attribution, not authenticated human identity. The local CMS provides password/TOTP MFA, admin/viewer roles and session/CSRF checks; external identity-provider integration remains pending. A caller can supply custom text, but cannot supply a device ID or a cooldown override. An accepted request is only a reservation and may expire without transmission.

Before enabling a real phone, resolve Phase A decisions and verify the Android attempt journal and SIM checks on the target device. Delivery callbacks use a narrowly scoped mutable PendingIntent for system PDU extras; sent callbacks are immutable. Both are explicit and target a non-exported receiver with a persisted callback capability. A pause cannot recall a transmission already invoked. Deployment and real-SIM release remain separate milestones.
